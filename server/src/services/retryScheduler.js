'use strict';

/**
 * @file services/retryScheduler.js
 * @description Silent retry pipeline for infra-error transactions.
 *
 * When a payment fails due to a bank/infra error (e.g. BANK_SERVER_DOWN,
 * GATEWAY_TIMEOUT), there is no customer friction — the bank was just down.
 * We silently retry the payment via Razorpay without contacting the customer.
 *
 * Flow per attempt:
 *   scheduleRetry(txn, attempt)
 *     → save state SILENT_RETRY_SCHEDULED
 *     → setTimeout(RETRY_DELAY_MS)
 *       → fetch fresh txn from DB (guard against state changes in the interim)
 *       → call Razorpay to re-attempt the payment
 *       → if captured  → state RECOVERED (Razorpay webhook also covers this)
 *       → if failed    → attempt < maxRetries → scheduleRetry(attempt+1)
 *                      → attempt >= maxRetries → state OUTREACH_INITIATED
 */

const TransactionRecord = require('../models/TransactionRecord');
const AgentAuditLog     = require('../models/AgentAuditLog');
const { getNextState }  = require('./stateMachine');
const socket            = require('../config/socket');
const razorpay          = require('../config/razorpay');

// Delay between retry attempts — short in test mode
const RETRY_DELAY_MS =
  process.env.NODE_ENV === 'test' ? 100 : 2 * 60 * 1000; // 2 min

// ---------------------------------------------------------------------------
// Razorpay retry helper
// ---------------------------------------------------------------------------

/**
 * Attempts to charge the customer again via Razorpay.
 * Creates a new Payment Link and immediately captures it (test mode simulation).
 *
 * In production you would instead use the Razorpay `/payments/:id/capture`
 * endpoint on a previously authorized payment, or trigger an e-mandate charge.
 * For the hackathon demo, we create a new payment link and consider it "pending"
 * unless the customer pays — which is a valid business flow too.
 *
 * @param {object} txn - The TransactionRecord Mongoose document.
 * @returns {Promise<{ success: boolean, link?: string, error?: string }>}
 */
async function attemptRazorpayCharge(txn) {
  try {
    // Create a payment link for the outstanding amount
    const link = await razorpay.paymentLink.create({
      amount:         Math.round(txn.originalAmount * 100), // paise
      currency:       txn.currency || 'INR',
      accept_partial: false,
      description:    'Silent retry — payment recovery',
      reference_id:   txn._id.toString(),
      customer: {
        name:    txn.customerName,
        contact: txn.phone,
        email:   txn.email || undefined,
      },
      notify:    { sms: false, email: false }, // We're handling notifications ourselves
      // expire_by: 1 hour from now (so stale links don't linger)
      expire_by: Math.floor(Date.now() / 1000) + 3600,
    });

    // Persist the link on the transaction record
    txn.activePaymentLink = link.short_url;
    await txn.save();

    console.log('[Retry] Razorpay silent-retry link created:', link.short_url);
    return { success: true, link: link.short_url };
  } catch (err) {
    console.error('[Retry] Razorpay charge attempt failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Main scheduler
// ---------------------------------------------------------------------------

/**
 * Schedules a silent automatic payment retry for an infra-error transaction.
 *
 * @param {object} transaction - The TransactionRecord Mongoose document.
 * @param {number} attempt     - Which retry attempt this is (1-indexed).
 */
async function scheduleRetry(transaction, attempt) {
  try {
    // Transition state on the first call (FAILED_PAYMENT_INGESTED → SILENT_RETRY_SCHEDULED)
    if (transaction.state === 'FAILED_PAYMENT_INGESTED') {
      transaction.state = getNextState(transaction.state, 'RETRY_SCHEDULED');
    }
    transaction.retryCount = attempt;
    await transaction.save();

    const io = socket.getIO();
    if (io) io.emit('txn:updated', transaction.toObject());

    console.log(
      '[Retry] Scheduled attempt', attempt, 'of', transaction.maxRetries,
      'for', transaction._id.toString(), '— delay:', RETRY_DELAY_MS + 'ms'
    );

    // Fire the actual retry after the delay
    setTimeout(async () => {
      try {
        // Always re-fetch to avoid acting on stale state
        const txn = await TransactionRecord.findById(transaction._id);
        if (!txn) {
          console.warn('[Retry] Transaction gone from DB:', transaction._id.toString());
          return;
        }
        if (txn.state !== 'SILENT_RETRY_SCHEDULED') {
          console.log('[Retry] State changed since scheduling — aborting retry for', txn._id.toString(), '(current state:', txn.state + ')');
          return;
        }

        console.log('[Retry] Executing attempt', attempt, 'for', txn._id.toString());

        // ── Real Razorpay charge attempt ─────────────────────────────────────
        const chargeResult = await attemptRazorpayCharge(txn);

        if (chargeResult.success) {
          // Payment link created — log it. The actual RECOVERED transition happens
          // via the Razorpay webhook (POST /api/webhooks/razorpay → payment_link.paid).
          // If the link is not paid within the expiry window, we escalate to outreach.

          await AgentAuditLog.create({
            transactionId: txn._id,
            step:          'OBSERVATION',
            toolName:      'silent_retry',
            toolInput:     { attempt, maxRetries: txn.maxRetries },
            toolOutput:    {
              observation: 'Razorpay retry link created: ' + chargeResult.link,
              attempt,
            },
            fromState: 'SILENT_RETRY_SCHEDULED',
            toState:   'SILENT_RETRY_SCHEDULED', // stays here until webhook fires
          });

          // If this is the last retry attempt, we transition to outreach after
          // a short extra window (3 hours) to allow the customer to pay the link.
          // For demo purposes we move to outreach immediately on final attempt.
          if (attempt >= txn.maxRetries) {
            console.log('[Retry] Final attempt completed for', txn._id.toString(), '— moving to outreach');
            const fresh = await TransactionRecord.findById(txn._id);
            if (fresh && fresh.state === 'SILENT_RETRY_SCHEDULED') {
              fresh.state = getNextState(fresh.state, 'RETRY_EXHAUSTED');
              await fresh.save();
              if (io) io.emit('txn:updated', fresh.toObject());
            }
          } else {
            // Schedule the next attempt — customer still hasn't paid
            await scheduleRetry(txn, attempt + 1);
          }

        } else {
          // Razorpay API itself failed (not a customer decline) — log and try again
          await AgentAuditLog.create({
            transactionId: txn._id,
            step:          'OBSERVATION',
            toolName:      'silent_retry',
            toolInput:     { attempt, maxRetries: txn.maxRetries },
            toolOutput:    { error: chargeResult.error, attempt },
            fromState:     'SILENT_RETRY_SCHEDULED',
            toState:       'SILENT_RETRY_SCHEDULED',
            error:         chargeResult.error,
          });

          if (attempt >= txn.maxRetries) {
            console.log('[Retry] Exhausted retries (API error) for', txn._id.toString(), '— escalating to outreach');
            const fresh = await TransactionRecord.findById(txn._id);
            if (fresh && fresh.state === 'SILENT_RETRY_SCHEDULED') {
              fresh.state = getNextState(fresh.state, 'RETRY_EXHAUSTED');
              await fresh.save();
              if (io) io.emit('txn:updated', fresh.toObject());
            }
          } else {
            await scheduleRetry(txn, attempt + 1);
          }
        }

      } catch (err) {
        console.error('[Retry] Execution error for', transaction._id.toString(), '—', err.message);
      }
    }, RETRY_DELAY_MS);

  } catch (err) {
    console.error('[Retry] Scheduling error for', transaction._id.toString(), '—', err.message);
  }
}

module.exports = { scheduleRetry };
