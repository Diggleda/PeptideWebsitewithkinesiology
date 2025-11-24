const { Router } = require('express');
const wooController = require('../controllers/wooController');

const router = Router();

// Catch-all under this router using middleware form to avoid
// path-to-regexp wildcard quirks in Express 5.
router.use(wooController.proxyCatalog);

module.exports = router;
