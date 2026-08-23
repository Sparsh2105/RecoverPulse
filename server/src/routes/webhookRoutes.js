/**
 * @file routes/webhookRoutes.js
 * @description Thin router â€” maps webhook endpoints to controller handlers.
 * No business logic lives here.
 */

'use strict';

const express = require('express');
const { ingestFailedPayment } = require('../controllers/webhookController');

const router = express.Router();

// POST /api/webhooks/payment-failed
router.post('/payment-failed', ingestFailedPayment);

module.exports = router;
