const { Router } = require('express');
const wooController = require('../controllers/wooController');

const router = Router();

// Reuse the same proxy as the /api/woo routes so the client can hit /api/catalog
router.get('/media', wooController.proxyMedia);

router.use(wooController.proxyCatalog);

module.exports = router;
