const { Router } = require('express');
const { authenticate } = require('../middleware/authenticate');
const referralController = require('../controllers/referralController');

const router = Router();

router.post('/doctor/referrals', authenticate, referralController.submitDoctorReferral);
router.delete('/doctor/referrals/:referralId', authenticate, referralController.deleteDoctorReferral);
router.get('/doctor/summary', authenticate, referralController.getDoctorSummary);
router.get('/doctor/ledger', authenticate, referralController.getDoctorLedger);

router.get('/admin/dashboard', authenticate, referralController.getSalesRepDashboard);
router.post('/admin/referrals/code', authenticate, referralController.createReferralCode);
router.patch('/admin/referrals/:referralId', authenticate, referralController.updateReferral);
router.patch('/admin/codes/:codeId', authenticate, referralController.updateReferralCodeStatus);
router.get('/admin/codes', authenticate, referralController.listReferralCodes);

module.exports = router;
