/**
 * @file services/retryScheduler.js
 * @description Schedules and executes silent retries for infra errors.
 */

'use strict';

const TransactionRecord = require('../models/TransactionRecord');
const { getNextState } = require('./stateMachine');

/**
 * Schedules a silent retry attempt.
 * @param {object} transaction Mongoose document
 * @param {number} attempt Attempt number (1-based)
 */
async function scheduleRetry(transaction, attempt = 1) {
  try {
    // Determine the next state (will throw if invalid)
    let nextState;
    if (transaction.state === 'FAILED_PAYMENT_INGESTED') {
       nextState = getNextState(transaction.state, 'RETRY_SCHEDULED');
    } else {
       // If already in SILENT_RETRY_SCHEDULED, stay in it
       nextState = transaction.state;
    }

    transaction.state = nextState;
    transaction.retryCount = attempt;
    await transaction.save();

    console.log(`[Retry] Txn ${transaction._id} scheduled for attempt ${attempt}/${transaction.maxRetries}`);

    // Fast delay for testing, otherwise use real business logic delays (e.g. 5 minutes)
    const delayMs = process.env.NODE_ENV === 'test' ? 100 : 2000;

    setTimeout(async () => {
      try {
        const txn = await TransactionRecord.findById(transaction._id);
        if (!txn || txn.state !== 'SILENT_RETRY_SCHEDULED') return;

        console.log(`[Retry] Executing attempt ${attempt} for Txn ${txn._id}`);

        // TODO (Day 6): Actual Razorpay API call here
        // For Day 2, we simulate failure:
        
        if (attempt >= txn.maxRetries) {
          console.log(`[Retry] Txn ${txn._id} retries exhausted. Escalating to outreach.`);
          txn.state = getNextState(txn.state, 'RETRY_EXHAUSTED');
          await txn.save();
        } else {
          // Schedule next attempt
          await scheduleRetry(txn, attempt + 1);
        }
      } catch (err) {
        console.error(`[Retry Error during execution] Txn ${transaction._id}:`, err.message);
      }
    }, delayMs);

  } catch (err) {
    console.error(`[Retry Error scheduling] Txn ${transaction._id}:`, err.message);
  }
}

module.exports = { scheduleRetry };
