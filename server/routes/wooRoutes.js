const { Router } = require('express');
const wooController = require('../controllers/wooController');
const { authenticate } = require('../middleware/authenticate');

const router = Router();

router.get(
  '/products/:productId/certificate-of-analysis',
  authenticate,
  wooController.getCertificateOfAnalysis,
);
router.get(
  '/products/:productId/certificate-of-analysis/delegate',
  wooController.getCertificateOfAnalysisDelegate,
);
router.get(
  '/products/:productId/certificate-of-analysis/info',
  authenticate,
  wooController.getCertificateOfAnalysisInfo,
);
router.get('/media', wooController.proxyMedia);

// Catch-all under this router using middleware form to avoid
// path-to-regexp wildcard quirks in Express 5.
router.use(wooController.proxyCatalog);

module.exports = router;
