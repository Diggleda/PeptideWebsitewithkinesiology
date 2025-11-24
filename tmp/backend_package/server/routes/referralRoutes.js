const { Router } = require('express');
const { authenticate } = require('../middleware/authenticate');
const referralController = require('../controllers/referralController');

const router = Router();

router.post('/doctor/referrals', authenticate, referralController.submitDoctorReferral);
router.get('/doctor/summary', authenticate, referralController.getDoctorSummary);
router.get('/doctor/ledger', authenticate, referralController.getDoctorLedger);

router.get('/admin/dashboard', authenticate, referralController.getSalesRepDashboard);
router.post('/admin/referrals/code', authenticate, referralController.createReferralCode);
router.patch('/admin/referrals/:referralId', authenticate, referralController.updateReferral);
router.patch('/admin/codes/:codeId', authenticate, referralController.updateReferralCodeStatus);

module.exports = router;
