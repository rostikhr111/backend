// Import and configure dotenv to enable use of environmental variable
const dotenv = require('dotenv');
dotenv.config();

// Imports from express validator to validate user input
const { validationResult } = require('express-validator');

// Import User and Bet model
const { User, Bet } = require('@wallfair.io/wallfair-commons').models;

const bigDecimal = require('js-big-decimal');

// Import Auth Service
const eventService = require('../services/event-service');
const userService = require('../services/user-service');

const { ErrorHandler } = require('../util/error-handler');

const { BetContract, Erc20 } = require('@wallfair.io/smart_contract_mock');
const WFAIR = new Erc20('WFAIR');

const createBet = async (req, res, next) => {
    const LOG_TAG = '[CREATE-BET]';
    // Validating User Inputs
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return next(new ErrorHandler(422, 'Invalid input passed, please check it'));
    }

    try {
        const { eventId, marketQuestion, description, hot, outcomes, endDate, slug } = req.body;
        let event = await eventService.getEvent(eventId);

        console.debug(LOG_TAG, event);
        console.debug(LOG_TAG, {
            marketQuestion: marketQuestion,
            hot: hot,
            outcomes: outcomes,
            endDate: endDate,
            event: eventId,
            creator: req.user.id,
            slug: slug,
        });

        const outcomesDb = outcomes.map((outcome, index) => ({ index, name: outcome.value }));

        const createBet = new Bet({
            marketQuestion: marketQuestion,
            description: description,
            hot: hot,
            outcomes: outcomesDb,
            date: endDate,
            event: eventId,
            creator: req.user.id,
            slug: slug,
        });

        const session = await Bet.startSession();
        try {
            await session.withTransaction(async () => {
                console.debug(LOG_TAG, 'Save Bet to MongoDB');
                await eventService.saveBet(createBet, session);

                if (!event.bets) {
                    event.bets = [];
                }

                console.debug(LOG_TAG, 'Save Bet to Event');
                event.bets.push(createBet);
                event = await eventService.saveEvent(event, session);

                await eventService.provideLiquidityToBet(createBet);
            });

            await eventService.betCreated(createBet, req.user.id);
        } finally {
            await session.endSession();
        }

        res.status(201).json(event);
    } catch (err) {
        console.error(err.message);
        next(new ErrorHandler(422, err.message));
    }
};

const placeBet = async (req, res, next) => {
    const LOG_TAG = '[PLACE-BET]';
    // Validating User Inputs
    const errors = validationResult(req);

    let { amount, outcome, minOutcomeTokens } = req.body;
    const id = req.params.id;

    if (!errors.isEmpty() || amount <= 0) {
        return next(new ErrorHandler(422, 'Invalid input passed, please check it'));
    }

    try {
        amount = parseFloat(amount).toFixed(4);
        const bigAmount = new bigDecimal(amount.toString().replace('.', ''));
        amount = BigInt(bigAmount.getValue());

        let minOutcomeTokensToBuy = 1n;
        if (minOutcomeTokens > 1) {
            minOutcomeTokensToBuy = BigInt(minOutcomeTokens);
        }

        const userId = req.user.id;
        const bet = await eventService.getBet(id);
        console.debug(LOG_TAG, 'Placing Bet', id, userId);

        if (!eventService.isBetTradable(bet)) {
            return next(
                new ErrorHandler(
                    405,
                    'No further action can be performed on an event/bet that has ended!'
                )
            );
        }

        const user = await userService.getUserById(userId);

        const response = {
            bet,
            outcomeValue: bet.outcomes[outcome]?.name,
            outcomeAmount: 0,
            investedAmount: new bigDecimal(amount).getPrettyValue('4', '.'),
        };

        const session = await Bet.startSession();
        try {
            await session.withTransaction(async () => {
                const betContract = new BetContract(id, bet.outcomes.length);
                console.debug(LOG_TAG, 'Successfully bought Tokens');

                if (user.openBets.indexOf(bet.id) === -1) {
                    user.openBets.push(bet.id);
                }

                await userService.saveUser(user, session);
                console.debug(LOG_TAG, 'Saved user');

                console.debug(LOG_TAG, 'Interacting with the AMM');
                await betContract.buy(userId, amount, outcome, minOutcomeTokensToBuy * WFAIR.ONE);

                const balance = await betContract
                    .getOutcomeToken(outcome)
                    .balanceOf(userId.toString());
                response.outcomeAmount = new bigDecimal(balance).getPrettyValue('4', '.');
            });

            await eventService.placeBet(user, bet, bigAmount.getPrettyValue(4, '.'), outcome);
        } finally {
            await session.endSession();
        }

        res.status(200).json(response);
    } catch (err) {
        console.error(err);
        next(new ErrorHandler(422, err.message));
    }
};

const pullOutBet = async (req, res, next) => {
    const LOG_TAG = '[PULLOUT-BET]';
    // Validating User Inputs
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return next(new ErrorHandler(422, 'Invalid input passed, please check it'));
    }

    try {
        // Defining User Inputs
        let { outcome, minReturnAmount } = req.body;
        const id = req.params.id;

        let requiredMinReturnAmount = 0n;
        if (minReturnAmount) {
            requiredMinReturnAmount = BigInt(minReturnAmount);
        }

        const userId = req.user.id;

        console.debug(LOG_TAG, 'Pulling out Bet', id, req.user.id);
        const bet = await eventService.getBet(id);

        if (await eventService.isBetTradable(bet)) {
            return next(
                new ErrorHandler(
                    405,
                    'No further action can be performed on an event/bet that has ended!'
                )
            );
        }

        const user = await userService.getUserById(userId);
        let sellAmount;

        const session = await User.startSession();
        try {
            let newBalances = undefined;
            await session
                .withTransaction(async () => {
                    console.debug(LOG_TAG, 'Interacting with the AMM');
                    const betContract = new BetContract(id, bet.outcomes.length);

                    sellAmount = await betContract.getOutcomeToken(outcome).balanceOf(userId);
                    console.debug(
                        LOG_TAG,
                        'SELL ' +
                            userId +
                            ' ' +
                            sellAmount +
                            ' ' +
                            outcome +
                            ' ' +
                            requiredMinReturnAmount * WFAIR.ONE
                    );

                    newBalances = await betContract.sellAmount(
                        userId,
                        sellAmount,
                        outcome,
                        requiredMinReturnAmount * WFAIR.ONE
                    );
                    console.debug(LOG_TAG, 'Successfully sold Tokens');

                    await userService.sellBet(
                        user.id,
                        bet,
                        sellAmount,
                        outcome,
                        newBalances,
                        session
                    );
                })
                .catch((err) => console.debug(err));

            const bigAmount = new bigDecimal(newBalances.earnedTokens);
            await eventService.pullOutBet(user, bet, bigAmount.getPrettyValue(4, '.'), outcome, 0n);
        } catch (err) {
            console.error(err);
        } finally {
            await session.endSession();
        }

        res.status(200).json(bet);
    } catch (err) {
        console.error(err);
        next(new ErrorHandler(422, err.message));
    }
};

const calculateBuyOutcome = async (req, res, next) => {
    const LOG_TAG = '[CALCULATE-BUY-OUTCOME]';
    // Validating User Inputs
    const errors = validationResult(req);

    const { amount } = req.body;
    const { id } = req.params;

    if (!errors.isEmpty() || amount <= 0) {
        return next(new ErrorHandler(422, 'Invalid input passed, please check it'));
    }

    try {
        const bet = await Bet.findById(id);
        const betContract = new BetContract(id, bet.outcomes.length);

        let buyAmount = parseFloat(amount).toFixed(4);
        const bigAmount = new bigDecimal(buyAmount.toString().replace('.', ''));
        buyAmount = BigInt(bigAmount.getValue());

        const result = [];

        for (const outcome of bet.outcomes) {
            const outcomeSellAmount = await betContract.calcBuy(buyAmount, outcome.index);
            const bigAmount = new bigDecimal(outcomeSellAmount);
            result.push({ index: outcome.index, outcome: bigAmount.getPrettyValue(4, '.') });
        }

        res.status(200).json(result);
    } catch (err) {
        console.debug(err);
        next(new ErrorHandler(422, err.message));
    }
};

const calculateSellOutcome = async (req, res, next) => {
    const LOG_TAG = '[CALCULATE-SELL-OUTCOME]';
    // Validating User Inputs
    const errors = validationResult(req);

    const { amount } = req.body;
    const { id } = req.params;

    if (!errors.isEmpty() || amount <= 0) {
        return next(new ErrorHandler(422, 'Invalid input passed, please check it'));
    }

    try {
        const bet = await Bet.findById(id);
        const betContract = new BetContract(id, bet.outcomes.length);
        let sellAmount = parseFloat(amount).toFixed(4);
        const bigAmount = new bigDecimal(sellAmount.toString().replace('.', ''));
        const result = [];

        for (const outcome of bet.outcomes) {
            const outcomeSellAmount = await betContract.calcSellFromAmount(
                BigInt(bigAmount.getValue()),
                outcome.index
            );
            const bigOutcome = new bigDecimal(outcomeSellAmount);
            result.push({ index: outcome.index, outcome: bigOutcome.getPrettyValue(4, '.') });
        }

        res.status(200).json(result);
    } catch (err) {
        console.error(err);
        next(new ErrorHandler(422, err.message));
    }
};

const payoutBet = async (req, res, next) => {
    const LOG_TAG = '[PAYOUT-BET]';
    // Validating User Inputs
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return next(new ErrorHandler(422, 'Invalid input passed, please check it'));
    }

    try {
        const id = req.params.od;
        const session = await User.startSession();
        let bet = {};

        try {
            await session.withTransaction(async () => {
                console.debug(LOG_TAG, 'Payout Bet', id, req.user.id);
                bet = await eventService.getBet(id, session);
                const user = await userService.getUserById(req.user.id, session);

                console.debug(LOG_TAG, 'Payed out Bet');
                //TODO store more information in closedBets
                user.openBets = user.openBets.filter((item) => item !== bet.id);
                user.closedBets.push(bet.id);

                await userService.saveUser(user, session);

                console.debug(LOG_TAG, 'Requesting Bet Payout');
                const betContract = new BetContract(id, bet.outcomes.length);
                await betContract.getPayout(req.user.id);
            });
        } finally {
            await session.endSession();
        }
        res.status(201).json(bet);
    } catch (err) {
        console.error(err.message);
        next(new ErrorHandler(422, err.message));
    }
};

const betHistory = async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return next(new ErrorHandler(422, errors));
    }

    let { direction, rangeType, rangeValue } = req.query;
    const id = req.params.id;

    try {
        const bet = await Bet.findById(id);
        if (!bet) {
            return next(new ErrorHandler(404, 'Bet does not exist'));
        }

        let interactionsList = await eventService.combineBetInteractions(
            bet,
            direction,
            rangeType,
            rangeValue
        );

        res.status(200).json(interactionsList);
    } catch (err) {
        console.debug(err);
        next(new ErrorHandler(422, err.message));
    }
};

exports.createBet = createBet;
exports.placeBet = placeBet;
exports.pullOutBet = pullOutBet;
exports.calculateBuyOutcome = calculateBuyOutcome;
exports.calculateSellOutcome = calculateSellOutcome;
exports.payoutBet = payoutBet;
exports.betHistory = betHistory;
