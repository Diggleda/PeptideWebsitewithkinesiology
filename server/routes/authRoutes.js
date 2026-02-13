const { Router } = require('express');
const authController = require('../controllers/authController');
const passkeyController = require('../controllers/passkeyController');
const { authenticate } = require('../middleware/authenticate');

const router = Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.post('/logout', authController.logout);
router.get('/check-email', authController.checkEmail);
router.get('/me', authenticate, authController.getProfile);
router.put('/me', authenticate, authController.updateProfile);
router.delete('/me', authenticate, authController.deleteAccount);
router.post('/verify-npi', authController.verifyNpi);

router.post('/passkeys/register/options', authenticate, passkeyController.registrationOptions);
router.post('/passkeys/register/verify', authenticate, passkeyController.verifyRegistration);
router.post('/passkeys/login/options', passkeyController.authenticationOptions);
router.post('/passkeys/login/verify', passkeyController.verifyAuthentication);

module.exports = router;
