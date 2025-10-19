const { Router } = require('express');
const systemController = require('../controllers/systemController');

const router = Router();

router.get('/health', systemController.getHealth);
router.get('/help', systemController.getHelp);

module.exports = router;
