'use strict';

const TransactionRecord = require('../models/TransactionRecord');
const { getNextState } = require('./stateMachine');
const socket = require('../config/socket');

// Delay between retry attempts. Short in test mode, 2 min in production.
const RETRY_DELAY_MS = process.env.NODE_ENV === 'test' ? 100 : 120_000;

async function scheduleRetry(transaction, attempt) {
  try {
    if (transaction.state === 'FAILED_PAYMENT_INGESTED') {
      transaction.state = getNextState(transaction.state, 'RETRY_SCHEDULED');
    }
    transaction.retryCount = attempt;
    await transaction.save();

    const io = socket.getIO();
    if (io) io.emit('txn:updated', transaction.toObject());

    console.log('[Retry] Scheduled attempt', attempt, 'of', transaction.maxRetries, 'for', transaction._id.toString());

    setTimeout(async () => {
      try {
        const txn = await TransactionRecord.findById(transaction._id);
        if (!txn || txn.state !== 'SILENT_RETRY_SCHEDULED') return;

        console.log('[Retry] Executing attempt', attempt, 'for', txn._id.toString());

        // TODO Day 6: Replace with real Razorpay payment retry call here.
        // For now we simulate the retry always failing so retries exhaust.

        if (attempt >= txn.maxRetries) {
          console.log('[Retry] Exhausted retries for', txn._id.toString(), '- escalating to outreach');
          txn.state = getNextState(txn.state, 'RETRY_EXHAUSTED');
          await txn.save();
          const io = socket.getIO();
          if (io) io.emit('txn:updated', txn.toObject());
        } else {
          await scheduleRetry(txn, attempt + 1);
        }
      } catch (err) {
        console.error('[Retry] Execution error for', transaction._id.toString(), '-', err.message);
      }
    }, RETRY_DELAY_MS);

  } catch (err) {
    console.error('[Retry] Scheduling error for', transaction._id.toString(), '-', err.message);
  }
}

module.exports = { scheduleRetry };
