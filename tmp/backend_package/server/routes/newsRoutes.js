const { Router } = require('express');
const newsController = require('../controllers/newsController');

const router = Router();

router.get('/peptides', newsController.getPeptides);

module.exports = router;

