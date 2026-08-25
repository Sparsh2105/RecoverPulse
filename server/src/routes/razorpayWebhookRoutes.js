'use strict';

/**
 * @file routes/razorpayWebhookRoutes.js
 * @description Route for Razorpay payment event webhooks.
 * Raw body parsing is required for HMAC signature verification.
 */

const express = require('express');
const { handleRazorpayWebhook } = require('../controllers/razorpayWebhookController');

const router = express.Router();

// POST /api/webhooks/razorpay
// Razorpay sends payment.captured, payment_link.paid, subscription.charged here
router.post('/razorpay', handleRazorpayWebhook);

module.exports = router;
