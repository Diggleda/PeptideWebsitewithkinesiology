const { Router } = require('express');
const quotesController = require('../controllers/quotesController');

const router = Router();

router.get('/daily', quotesController.getDaily);
router.get('/', quotesController.list);

module.exports = router;

