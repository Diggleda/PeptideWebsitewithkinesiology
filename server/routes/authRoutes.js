const { Router } = require('express');
const authController = require('../controllers/authController');
const { authenticate } = require('../middleware/authenticate');

const router = Router();

router.post('/register', authController.register);
router.post('/login', authController.login);
router.get('/check-email', authController.checkEmail);
router.get('/me', authenticate, authController.getProfile);
router.put('/me', authenticate, authController.updateProfile);
router.post('/verify-npi', authController.verifyNpi);

module.exports = router;
