const { Router } = require('express');
const wooController = require('../controllers/wooController');

const router = Router();

router.get('/*', wooController.proxyCatalog);

module.exports = router;
