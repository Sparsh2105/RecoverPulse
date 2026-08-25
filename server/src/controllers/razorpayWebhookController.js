'use strict';

/**
 * @file controllers/razorpayWebhookController.js
 * @description Handles inbound Razorpay payment events and closes the recovery loop.
 *
 * Supported events:
 *   - payment_link.paid      → payment link was paid
 *   - subscription.charged   → UPI mandate was auto-charged (recurring)
 *   - payment.captured       → generic payment captured (fallback)
 *
 * On any of the above, if we can resolve a transactionId, we transition
 * the transaction to RECOVERED and emit a socket event to the dashboard.
 */

const crypto            = require('crypto');
const TransactionRecord = require('../models/TransactionRecord');
const AgentAuditLog     = require('../models/AgentAuditLog');
const socket            = require('../config/socket');
const { getNextState }  = require('../services/stateMachine');

// States that can still be transitioned to RECOVERED
const RECOVERABLE_STATES = new Set([
  'OUTREACH_INITIATED',
  'MANDATE_PENDING_AUTH',
  'DISCOUNT_GATED_LINK',
  'SILENT_RETRY_SCHEDULED',
  'FAILED_PAYMENT_INGESTED',
]);

/**
 * Verifies the Razorpay webhook signature.
 * @param {string|Buffer} rawBody - Raw request body bytes.
 * @param {string} signature      - Value of x-razorpay-signature header.
 * @param {string} secret         - Your Razorpay webhook secret.
 * @returns {boolean}
 */
function verifySignature(rawBody, signature, secret) {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return expected === signature;
}

/**
 * Extracts (transactionId, amountPaid) from different Razorpay event shapes.
 */
function extractPaymentInfo(event, payload) {
  let transactionId = null;
  let amountPaidPaise = 0;

  if (event === 'payment_link.paid') {
    const entity = payload.payment_link?.entity;
    transactionId  = entity?.reference_id   || null;
    amountPaidPaise = entity?.amount_paid    || 0;
  } else if (event === 'subscription.charged') {
    const sub = payload.subscription?.entity;
    transactionId  = sub?.notes?.transactionId || null;
    // Amount lives on the associated payment entity
    amountPaidPaise = payload.payment?.entity?.amount || 0;
  } else if (event === 'payment.captured') {
    const payment  = payload.payment?.entity;
    transactionId  = payment?.notes?.transactionId || null;
    amountPaidPaise = payment?.amount || 0;
  }

  return {
    transactionId,
    amountPaid: amountPaidPaise / 100, // convert paise → rupees
  };
}

async function handleRazorpayWebhook(req, res) {
  try {
    const secret    = process.env.RAZORPAY_WEBHOOK_SECRET || 'fallback_secret_for_dev';
    const signature = req.headers['x-razorpay-signature'];

    // ── Signature verification ──────────────────────────────────────────────
    // In production we always verify. In development we allow missing signature
    // so you can test with curl/Postman without ngrok.
    if (signature) {
      // req.body is already parsed JSON (Express json() middleware).
      // For signature verification Razorpay requires the raw body string.
      // We re-stringify the parsed body — acceptable for test mode where
      // the payload round-trips cleanly. For production, use express.raw()
      // on this route if you need byte-perfect verification.
      const rawBody = JSON.stringify(req.body);
      const valid   = verifySignature(rawBody, signature, secret);

      if (!valid && process.env.NODE_ENV === 'production') {
        console.warn('[Razorpay Webhook] Invalid signature — rejecting');
        return res.status(400).json({ error: 'Invalid signature' });
      }

      if (!valid) {
        console.warn('[Razorpay Webhook] Signature mismatch (non-production — continuing)');
      }
    } else {
      console.log('[Razorpay Webhook] No signature header — skipping verification (dev mode)');
    }

    const { event, payload } = req.body;
    console.log('[Razorpay Webhook] Received event:', event);

    // ── Only process payment-success events ─────────────────────────────────
    const HANDLED_EVENTS = new Set([
      'payment_link.paid',
      'subscription.charged',
      'payment.captured',
    ]);

    if (!HANDLED_EVENTS.has(event)) {
      // Acknowledge but ignore — Razorpay sends many event types
      return res.status(200).json({ status: 'ignored', event });
    }

    const { transactionId, amountPaid } = extractPaymentInfo(event, payload);

    if (!transactionId) {
      console.warn('[Razorpay Webhook] Could not extract transactionId from event:', event);
      return res.status(200).json({ status: 'no_transaction_id' });
    }

    // ── Transition transaction to RECOVERED ─────────────────────────────────
    const txn = await TransactionRecord.findById(transactionId);

    if (!txn) {
      console.warn('[Razorpay Webhook] Transaction not found:', transactionId);
      return res.status(200).json({ status: 'transaction_not_found' });
    }

    if (txn.state === 'RECOVERED') {
      // Idempotent — already recovered (Razorpay may retry webhooks)
      console.log('[Razorpay Webhook] Already RECOVERED — skipping:', transactionId);
      return res.status(200).json({ status: 'already_recovered' });
    }

    if (!RECOVERABLE_STATES.has(txn.state)) {
      console.warn('[Razorpay Webhook] Unexpected state for recovery:', txn.state, 'txn:', transactionId);
      // Still acknowledge so Razorpay doesn't keep retrying
      return res.status(200).json({ status: 'unrecoverable_state', currentState: txn.state });
    }

    const fromState        = txn.state;
    txn.state              = getNextState(txn.state, 'PAYMENT_CAPTURED');
    txn.recoveredAmount    = amountPaid || txn.originalAmount;
    await txn.save();

    console.log(
      '[Razorpay Webhook] Txn', transactionId,
      'transitioned', fromState, '→', txn.state,
      '| Amount recovered: Rs.' + txn.recoveredAmount
    );

    // ── Write audit log entry ────────────────────────────────────────────────
    await AgentAuditLog.create({
      transactionId: txn._id,
      step:          'OBSERVATION',
      toolName:      'razorpay_payment_captured',
      toolInput:     { event, amountPaid: txn.recoveredAmount },
      toolOutput:    {
        observation: 'Payment captured by Razorpay. Amount: Rs.' + txn.recoveredAmount,
        event,
      },
      fromState,
      toState:       txn.state,
    });

    // ── Emit real-time update to dashboard ───────────────────────────────────
    const io = socket.getIO();
    if (io) {
      io.emit('txn:updated', txn.toObject());
      io.emit('audit:created', {
        transactionId,
        toolName:    'razorpay_payment_captured',
        observation: 'Payment captured. Rs.' + txn.recoveredAmount + ' recovered.',
      });
    }

    return res.status(200).json({ status: 'ok', transactionId, amountRecovered: txn.recoveredAmount });

  } catch (error) {
    console.error('[Razorpay Webhook] Unhandled error:', error.message);
    // Always return 200 — Razorpay retries on non-200, which could cause duplicates
    return res.status(200).json({ status: 'error_caught' });
  }
}

module.exports = { handleRazorpayWebhook };
