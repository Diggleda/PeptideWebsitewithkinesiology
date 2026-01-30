const { Router } = require('express');
const { authenticate } = require('../middleware/authenticate');
const referralController = require('../controllers/referralController');

const router = Router();

router.post('/doctor/referrals', authenticate, referralController.submitDoctorReferral);
router.delete('/doctor/referrals/:referralId', authenticate, referralController.deleteDoctorReferral);
router.get('/doctor/summary', authenticate, referralController.getDoctorSummary);
router.get('/doctor/ledger', authenticate, referralController.getDoctorLedger);

	router.get('/admin/dashboard', authenticate, referralController.getSalesRepDashboard);
	// Non-admin alias (avoids infra path restrictions on /admin/*).
	router.get('/dashboard', authenticate, referralController.getSalesRepDashboard);
	router.get('/admin/sales-reps/:salesRepId', authenticate, referralController.getSalesRepById);
	// Non-admin alias (avoids infra path restrictions on /admin/*).
	router.get('/sales-reps/:salesRepId', authenticate, referralController.getSalesRepById);
	router.post('/admin/referrals/code', authenticate, referralController.createReferralCode);
router.post('/admin/manual', authenticate, referralController.createManualProspect);
router.delete('/admin/manual/:referralId', authenticate, referralController.deleteManualProspect);
router.patch('/admin/referrals/:referralId', authenticate, referralController.updateReferral);
router.get('/admin/sales-prospects/:identifier', authenticate, referralController.getSalesProspect);
router.patch('/admin/sales-prospects/:identifier', authenticate, referralController.upsertSalesProspect);
router.post('/admin/sales-prospects/:identifier/reseller-permit', authenticate, referralController.uploadResellerPermit);
router.get('/admin/sales-prospects/:identifier/reseller-permit', authenticate, referralController.downloadResellerPermit);

// Non-admin aliases for sales reps / sales leads (avoids infra path restrictions on /admin/*).
router.get('/sales-prospects/:identifier', authenticate, referralController.getSalesProspect);
router.patch('/sales-prospects/:identifier', authenticate, referralController.upsertSalesProspect);
router.post('/sales-prospects/:identifier/reseller-permit', authenticate, referralController.uploadResellerPermit);
router.get('/sales-prospects/:identifier/reseller-permit', authenticate, referralController.downloadResellerPermit);
router.patch('/admin/codes/:codeId', authenticate, referralController.updateReferralCodeStatus);
router.get('/admin/codes', authenticate, referralController.listReferralCodes);

module.exports = router;
