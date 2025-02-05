const userService = require('../services/user-service');
const { BetContract, Erc20, Wallet } = require('@wallfair.io/smart_contract_mock');
const WFAIR = new Erc20('WFAIR');

exports.clearOpenBets = async (bet, session) => {
    const betContract = new BetContract(bet.id, bet.outcomes.length);
    for (const outcome of bet.outcomes) {
        const wallets = await betContract.getInvestorsOfOutcome(outcome.index);
        const winning = outcome.index === bet.finalOutcome;

        for (const wallet of wallets) {
            const userId = wallet.owner;

            if (userId.startsWith('BET')) {
                continue;
            }

            const balance = BigInt(wallet.balance) / WFAIR.ONE;

            const user = await userService.getUserById(userId, session);
            userService.clearOpenBetAndAddToClosed(user, bet, balance, winning ? balance : 0);

            await userService.saveUser(user, session);
        }
    }
};
exports.refundUserHistory = async (bet, session) => {
    const userIds = [];
    const betContract = new BetContract(bet.id, bet.outcomes.length);
    for (const outcome of bet.outcomes) {
        const wallets = await betContract.getInvestorsOfOutcome(outcome.index);

        for (const wallet of wallets) {
            const userId = wallet.owner;

            if (!userIds.includes(userId)) {
                userIds.push(userId);
            }

            const konstiWallet = new Wallet(userId);

            if (userId.startsWith('BET')) {
                continue;
            }

            const balance = BigInt(wallet.balance) / WFAIR.ONE;

            const user = await userService.getUserById(userId, session);
            userService.clearOpenBetAndAddToClosed(
                user,
                bet,
                balance,
                await konstiWallet.investmentBet(bet.id, outcome.index)
            );

            await userService.saveUser(user, session);
        }
    }

    return userIds;
};

exports.automaticPayout = async (winningUsers, bet) => {
    //Payout finalOutcome
    for (const userId of winningUsers) {
        await userService.payoutUser(userId, bet);
    }
};
