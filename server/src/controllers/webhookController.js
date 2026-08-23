/**
 * @file controllers/webhookController.js
 * @description Handles ingestion of failed-payment webhook events.
 * Delegates payload validation to middleware/validate.js and persists
 * records via the TransactionRecord Mongoose model.
 */

'use strict';

const TransactionRecord      = require('../models/TransactionRecord');
const { validatePaymentPayload } = require('../middleware/validate');

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * POST /api/webhooks/payment-failed
 *
 * Ingests a failed payment webhook event:
 *   1. Validates the request body via `validatePaymentPayload`.
 *   2. Checks for duplicate `paymentId` (idempotency guard).
 *   3. Persists a new TransactionRecord in state FAILED_PAYMENT_INGESTED.
 *   4. Broadcasts `txn:created` to all Socket.IO clients.
 *   5. Returns 201 with the created document.
 *
 * @param {import('express').Request}  req - Express request (body must contain payment fields).
 * @param {import('express').Response} res - Express response.
 * @returns {Promise<void>}
 */
async function ingestFailedPayment(req, res) {
  try {
    // -- Step 1: Validate payload (pure, no DB) -----------------------------
    const validation = validatePaymentPayload(req.body);
    if (!validation.valid) {
      const { status, errorCode, error, ...extras } = validation;
      return res.status(status).json({ success: false, errorCode, error, ...extras });
    }

    const { sanitized } = validation;

    // -- Step 2: Idempotency â€” reject duplicate paymentId ------------------
    if (sanitized.paymentId) {
      const existing = await TransactionRecord.findOne({ paymentId: sanitized.paymentId }).lean();
      if (existing) {
        return res.status(409).json({
          success: false,
          errorCode: 'DUPLICATE_PAYMENT_ID',
          error: `A transaction with paymentId "${sanitized.paymentId}" already exists`,
          existingTransactionId: existing._id,
        });
      }
    }

    // -- Step 3: Persist ----------------------------------------------------
    const transaction = await TransactionRecord.create({
      ...sanitized,
      state: 'FAILED_PAYMENT_INGESTED',
    });

    console.log(
      `ðŸ“¥ Ingested: ${transaction._id} | ${transaction.customerName} | Rs.${transaction.originalAmount} | ${transaction.errorCode}`
    );

    // -- Step 4: Real-time broadcast ----------------------------------------
    const io = req.app.get('io');
    if (io) io.emit('txn:created', transaction);

    // -- Step 5: Respond ----------------------------------------------------
    return res.status(201).json({ success: true, data: transaction });

  } catch (error) {
    console.error('âŒ Webhook ingestion error:', error.message);

    // Mongoose schema-level validation failures
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        errorCode: 'DB_VALIDATION_ERROR',
        error: 'Database validation failed',
        details: Object.values(error.errors).map((e) => e.message),
      });
    }

    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_SERVER_ERROR',
      error: 'Failed to ingest payment webhook',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = { ingestFailedPayment };
