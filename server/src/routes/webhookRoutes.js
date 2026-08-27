'use strict';

/**
 * @file routes/webhookRoutes.js
 * @description Thin router — maps webhook endpoints to controller handlers.
 * No business logic lives here.
 */

const express = require('express');
const { ingestFailedPayment }    = require('../controllers/webhookController');
const { handleTwilioWhatsApp }   = require('../controllers/twilioWebhookController');
const { verifyWebhook, handleInbound } = require('../controllers/whatsappCloudController');

const router = express.Router();

// POST /api/webhooks/payment-failed
router.post('/payment-failed', ingestFailedPayment);

// Twilio WhatsApp (fallback)
router.post('/whatsapp', handleTwilioWhatsApp);

// Meta WhatsApp Cloud API
router.get('/whatsapp-cloud', verifyWebhook);
router.post('/whatsapp-cloud', handleInbound);

module.exports = router;
