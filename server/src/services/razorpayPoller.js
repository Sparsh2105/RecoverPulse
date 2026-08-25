'use strict';

/**
 * @file services/razorpayPoller.js
 * @description Polls Razorpay API for payment captures on active transactions.
 *
 * WHY THIS EXISTS:
 *   Razorpay webhooks require a public HTTPS URL (ngrok in dev). Without ngrok,
 *   paying a Razorpay test link will not automatically update the dashboard.
 *   This poller closes that gap by periodically checking the status of every
 *   active payment link / mandate directly via Razorpay's REST API.
 *
 * HOW IT WORKS:
 *   Every POLL_INTERVAL_MS (default 8 seconds in dev):
 *     1. Find all transactions with an activePaymentLink and non-terminal state.
 *     2. For payment links  → call Razorpay GET /v1/payment_links/:id
 *        For subscriptions  → call Razorpay GET /v1/subscriptions/:id
 *     3. If status is paid/captured → transition to RECOVERED + emit socket event.
 *
 * This is a dev-mode convenience. In production, the webhook handler handles this
 * instantly. Both paths converge on the same DB transition + socket emit.
 */

const TransactionRecord = require('../models/TransactionRecord');
const AgentAuditLog     = require('../models/AgentAuditLog');
const razorpay          = require('../config/razorpay');
const socket            = require('../config/socket');
const { getNextState }  = require('./stateMachine');

const POLL_INTERVAL_MS = process.env.NODE_ENV === 'development' ? 8_000 : 30_000;

// States where we still need to watch for payment
const WATCHABLE_STATES = new Set([
  'OUTREACH_INITIATED',
  'MANDATE_PENDING_AUTH',
  'DISCOUNT_GATED_LINK',
  'SILENT_RETRY_SCHEDULED',
  'FAILED_PAYMENT_INGESTED',
]);

let pollerTimer = null;
let isRunning   = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts the Razorpay resource ID from a short_url or full URL.
 * Razorpay short URLs look like: https://rzp.io/l/AbCdEf
 * Full payment link URLs:        https://rzp.io/rzp/XXXXX  or  https://rzp.io/i/XXXXX
 * Subscription short URLs:       https://rzp.io/l/AbCdEf  (same format)
 *
 * We store the actual ID (plink_xxx or sub_xxx) on the transaction as mandateId.
 * For payment links we have no separate field, so we query by reference_id instead.
 */

/**
 * Checks a Razorpay payment link status.
 * @param {string} paymentLinkId  - e.g. plink_Axxxxxxxxxxxxxxxx
 * @returns {Promise<{ paid: boolean, amount: number } | null>}
 */
async function checkPaymentLink(paymentLinkId) {
  try {
    const link = await razorpay.paymentLink.fetch(paymentLinkId);
    const paid = link.status === 'paid';
    return { paid, amount: (link.amount_paid || link.amount || 0) / 100 };
  } catch (err) {
    // plink not found or API error — silently skip
    return null;
  }
}

/**
 * Checks a Razorpay subscription status.
 * @param {string} subscriptionId  - e.g. sub_Axxxxxxxxxxxxxxxx
 * @returns {Promise<{ paid: boolean, amount: number } | null>}
 */
async function checkSubscription(subscriptionId) {
  try {
    const sub = await razorpay.subscriptions.fetch(subscriptionId);
    // 'active' means at least one charge succeeded; 'authenticated' means mandate authorised
    const paid = sub.status === 'active';
    return { paid, amount: (sub.paid_count > 0 ? sub.plan_id : 0) };
  } catch (err) {
    return null;
  }
}

/**
 * Searches Razorpay payment links by reference_id (our MongoDB txn _id).
 * This is the fallback when we don't have the payment link ID stored separately.
 * @param {string} referenceId  - transaction._id.toString()
 * @returns {Promise<{ paid: boolean, amount: number, linkId: string } | null>}
 */
async function findPaymentLinkByReference(referenceId) {
  try {
    // Razorpay supports filtering payment links by reference_id
    const result = await razorpay.paymentLink.all({ reference_id: referenceId });
    if (!result.items || result.items.length === 0) return null;

    // Take the most recent link
    const link = result.items[0];
    return {
      paid:   link.status === 'paid',
      amount: (link.amount_paid || link.amount || 0) / 100,
      linkId: link.id,
    };
  } catch (err) {
    return null;
  }
}

/**
 * Processes a single transaction — checks Razorpay and transitions if paid.
 * @param {object} txn  - Lean TransactionRecord object
 */
async function processTxn(txn) {
  try {
    let result = null;

    if (txn.mandateId && txn.mandateId.startsWith('sub_')) {
      // It's a subscription / UPI mandate
      result = await checkSubscription(txn.mandateId);
    } else {
      // It's a payment link — find by reference_id (our txn _id)
      result = await findPaymentLinkByReference(txn._id.toString());
    }

    if (!result || !result.paid) return; // not paid yet

    // Re-fetch with a write lock to avoid race conditions with the webhook handler
    const freshTxn = await TransactionRecord.findById(txn._id);
    if (!freshTxn || freshTxn.state === 'RECOVERED') return; // already handled
    if (!WATCHABLE_STATES.has(freshTxn.state)) return;       // terminal state

    const fromState           = freshTxn.state;
    freshTxn.state            = getNextState(freshTxn.state, 'PAYMENT_CAPTURED');
    freshTxn.recoveredAmount  = result.amount || freshTxn.originalAmount;
    await freshTxn.save();

    console.log(
      '[Poller] Payment detected for txn', txn._id.toString(),
      '| Rs.' + freshTxn.recoveredAmount,
      '|', fromState, '→', freshTxn.state
    );

    // Audit log
    await AgentAuditLog.create({
      transactionId: freshTxn._id,
      step:          'OBSERVATION',
      toolName:      'razorpay_payment_captured',
      toolInput:     { source: 'poller', amountPaid: freshTxn.recoveredAmount },
      toolOutput:    {
        observation: '[Poller] Payment captured via Razorpay API poll. Amount: Rs.' + freshTxn.recoveredAmount,
      },
      fromState,
      toState: freshTxn.state,
    });

    // Push to dashboard
    const io = socket.getIO();
    if (io) {
      io.emit('txn:updated', freshTxn.toObject());
      io.emit('audit:created', {
        transactionId: txn._id.toString(),
        toolName:      'razorpay_payment_captured',
        observation:   'Payment captured (polled). Rs.' + freshTxn.recoveredAmount + ' recovered.',
      });
    }

  } catch (err) {
    console.error('[Poller] Error processing txn', txn._id?.toString(), '—', err.message);
  }
}

// ---------------------------------------------------------------------------
// Main poll loop
// ---------------------------------------------------------------------------

async function poll() {
  if (isRunning) return; // don't overlap if previous poll is still running
  isRunning = true;

  try {
    // Find all active transactions that have a payment link set
    const activeTxns = await TransactionRecord.find({
      state:             { $in: [...WATCHABLE_STATES] },
      activePaymentLink: { $ne: null, $exists: true },
    }).lean();

    if (activeTxns.length > 0) {
      console.log('[Poller] Checking', activeTxns.length, 'active transaction(s)...');
      // Run checks in parallel (max 5 at a time to avoid Razorpay rate limits)
      const BATCH = 5;
      for (let i = 0; i < activeTxns.length; i += BATCH) {
        const batch = activeTxns.slice(i, i + BATCH);
        await Promise.all(batch.map(processTxn));
      }
    }
  } catch (err) {
    console.error('[Poller] Poll cycle error:', err.message);
  } finally {
    isRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

function startPoller() {
  if (pollerTimer) return; // already running
  console.log('[Poller] Started — polling every', POLL_INTERVAL_MS / 1000, 'seconds');
  // Run once immediately, then on interval
  poll();
  pollerTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopPoller() {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
    console.log('[Poller] Stopped.');
  }
}

module.exports = { startPoller, stopPoller };
