const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

// Request password reset
router.post('/request', authController.requestPasswordReset);

// Reset password
router.post('/reset', authController.resetPassword);

module.exports = router;
