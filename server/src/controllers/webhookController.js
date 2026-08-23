/**
 * @file controllers/webhookController.js
 * @description Handles ingestion of failed-payment webhook events.
 */

'use strict';

const TransactionRecord      = require('../models/TransactionRecord');
const { validatePaymentPayload } = require('../middleware/validate');
const { classifyErrorCode } = require('../services/triageService');
const { getNextState } = require('../services/stateMachine');
const { scheduleRetry } = require('../services/retryScheduler');

/**
 * Triages the transaction asynchronously.
 */
async function triageAndRoute(transaction) {
  try {
    const category = classifyErrorCode(transaction.errorCode);
    transaction.errorCategory = category;

    if (category === 'infra') {
      // Infra -> Silent Retry Pipeline
      await transaction.save();
      await scheduleRetry(transaction, 1);
    } else {
      // Soft / Hard -> Direct to Outreach
      transaction.state = getNextState(transaction.state, 'OUTREACH_INITIATED');
      await transaction.save();
      console.log(`[Triage] Txn ${transaction._id} classified as ${category}. Moved to OUTREACH_INITIATED.`);
    }
  } catch (err) {
    console.error(`[Triage] Error triaging txn ${transaction._id}:`, err.message);
  }
}

async function ingestFailedPayment(req, res) {
  try {
    const validation = validatePaymentPayload(req.body);
    if (!validation.valid) {
      const { status, errorCode, error, ...extras } = validation;
      return res.status(status).json({ success: false, errorCode, error, ...extras });
    }

    const { sanitized } = validation;

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

    const transaction = await TransactionRecord.create({
      ...sanitized,
      state: 'FAILED_PAYMENT_INGESTED',
    });

    console.log(
      `[Webhook] Ingested: ${transaction._id} | ${transaction.customerName} | Rs.${transaction.originalAmount} | ${transaction.errorCode}`
    );

    const io = req.app.get('io');
    if (io) io.emit('txn:created', transaction);

    // -- Day 2: Async Triage ------------------------------------------------
    triageAndRoute(transaction).catch(err => 
      console.error(`[Webhook] Triage failed for ${transaction._id}`, err)
    );

    return res.status(201).json({ success: true, data: transaction });

  } catch (error) {
    console.error('[Webhook] ingestion error:', error.message);
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

module.exports = { ingestFailedPayment };
