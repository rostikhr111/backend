// Import the express Router to create routes
const router = require('express').Router();

// Imports from express validator to validate user input
const { check } = require('express-validator');

// Import controllers
const eventController = require('../../controllers/events-controller');
const betController = require('../../controllers/bets-controller');
const twitchController = require('../../controllers/twitch-controller');

//Login does register & login
router.get('/get/:id', [check('id').notEmpty()], eventController.getEvent);

router.post(
    '/create',
    [check('name'), check('tags'), check('streamUrl'), check('previewImageUrl'), check('date')],
    eventController.createEvent
);

router.post(
    '/bet/create',
    [
        check('eventId').notEmpty(),
        check('marketQuestion').notEmpty(),
        check('description'),
        check('hot'),
        check('outcomes').isArray(),
        check('endDate'),
    ],
    betController.createBet
);

router.post(
    '/extract/twitch',
    [check('streamUrl').notEmpty()],
    twitchController.getEventFromTwitchUrl
);

router.post(
    '/bet/:id/place',
    [
        check('amount').isNumeric(),
        check('outcome').isNumeric(),
        check('minOutcomeTokens').isNumeric().default(0).optional(),
    ],
    betController.placeBet
);

router.post(
    '/bet/:id/pullout',
    [
        check('amount').isNumeric(),
        check('outcome').isNumeric(),
        check('minReturnAmount').isNumeric().default(Number.MAX_SAFE_INTEGER).optional(),
    ],
    betController.pullOutBet
);

router.get('/bet/:id/payout', betController.payoutBet);

module.exports = router;
