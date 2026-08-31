'use strict';

/**
 * @file controllers/batchController.js
 * @description Batch runner — ingests all 50 seed records through the pipeline
 * with a configurable concurrency limit and speed multiplier.
 *
 * POST /api/batch/run
 *   Body: { speedMultiplier?: number (default 1), concurrency?: number (default 5) }
 *
 * Concurrency = max simultaneous agent turns running at once.
 * SpeedMultiplier = how much to compress delays (2 = twice as fast, 10 = demo speed).
 *
 * Each record goes through the full ingestFailedPayment pipeline:
 *   create TransactionRecord → triage → (infra: silent retry | soft/hard: agent turn)
 * Socket.IO emits txn:created + txn:updated as each one progresses.
 */

const path = require('path');
const fs   = require('fs');
const TransactionRecord = require('../models/TransactionRecord');
const { validatePaymentPayload } = require('../middleware/validate');
const { classifyErrorCode }      = require('../services/triageService');
const { getNextState }           = require('../services/stateMachine');
const { runAgentTurn }           = require('../services/agentCore');
const socket                     = require('../config/socket');

const SEED_FILE = path.resolve(__dirname, '../../data/seed-50-records.json');

// ---------------------------------------------------------------------------
// Concurrency limiter (no external dependency — simple semaphore)
// ---------------------------------------------------------------------------

function createLimiter(concurrency) {
  let running = 0;
  const queue = [];

  function next() {
    if (running >= concurrency || queue.length === 0) return;
    running++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve).catch(reject).finally(() => {
      running--;
      next();
    });
  }

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}

// ---------------------------------------------------------------------------
// Process a single seed record
// ---------------------------------------------------------------------------

async function processSeedRecord(record, io) {
  try {
    const { _scenario, ...payload } = record;

    const validation = validatePaymentPayload(payload);
    if (!validation.valid) {
      console.warn('[Batch] Validation failed for record:', record.customerName, '-', validation.error);
      return { success: false, error: validation.error };
    }

    const { sanitized } = validation;

    const txn = await TransactionRecord.create({
      ...sanitized,
      state: 'FAILED_PAYMENT_INGESTED',
    });

    if (io) io.emit('txn:created', txn.toObject());

    const category = classifyErrorCode(txn.errorCode);
    txn.errorCategory = category;

    if (category === 'infra') {
      txn.state = getNextState(txn.state, 'RETRY_SCHEDULED');
      txn.retryCount = 1;
      await txn.save();
      if (io) io.emit('txn:updated', txn.toObject());
      return { success: true, txnId: txn._id, category, action: 'silent_retry' };
    }

    txn.state = getNextState(txn.state, 'OUTREACH_INITIATED');
    await txn.save();
    if (io) io.emit('txn:updated', txn.toObject());

    if (_scenario === 'dispute_likely') {
      // Non-throwing — dispute keyword is caught by regex pre-filter in runAgentTurn
      try {
        await runAgentTurn(txn._id.toString(), 'I already cancelled this, stop messaging me');
      } catch (err) {
        console.warn('[Batch] Dispute escalation failed for', txn._id.toString(), ':', err.message);
      }
      return { success: true, txnId: txn._id, category, action: 'escalated_dispute' };
    }

    // Fire initial agent turn — errors are caught and logged, not thrown
    try {
      await runAgentTurn(txn._id.toString(), 'PAYMENT_FAILED');
    } catch (err) {
      console.warn('[Batch] Agent turn failed for', txn._id.toString(), ':', err.message);
      // Transaction stays in OUTREACH_INITIATED — poller or manual retry can handle it
    }
    return { success: true, txnId: txn._id, category, action: 'agent_outreach' };

  } catch (err) {
    console.error('[Batch] Record processing error:', err.message);
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function runBatch(req, res) {
  // Check seed file exists
  if (!fs.existsSync(SEED_FILE)) {
    return res.status(400).json({
      success: false,
      error: 'Seed file not found. Run: node scripts/generateSeed.js first.',
    });
  }

  const concurrency     = Math.min(10, Math.max(1, parseInt(req.body.concurrency, 10) || 5));
  const speedMultiplier = Math.min(100, Math.max(1, parseFloat(req.body.speedMultiplier) || 1));

  let records;
  try {
    records = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to read seed file: ' + err.message });
  }

  console.log('[Batch] Starting batch run:', records.length, 'records |',
    'concurrency:', concurrency, '| speedMultiplier:', speedMultiplier + 'x');

  const io = socket.getIO();

  // Respond immediately — batch runs async, results stream via Socket.IO
  res.json({
    success: true,
    message: 'Batch started',
    total:   records.length,
    concurrency,
    speedMultiplier,
  });

  // Emit batch start event
  if (io) io.emit('batch:started', { total: records.length, concurrency, speedMultiplier });

  // Run with concurrency limit + inter-record delay based on speed multiplier
  const limit   = createLimiter(concurrency);
  const results = { processed: 0, success: 0, failed: 0 };
  const INTER_RECORD_DELAY_MS = Math.max(50, Math.floor(500 / speedMultiplier));

  const tasks = records.map((record, i) => limit(async () => {
    // Stagger starts slightly to avoid DB write spikes
    await new Promise(r => setTimeout(r, i * INTER_RECORD_DELAY_MS));

    const result = await processSeedRecord(record, io);
    results.processed++;
    if (result.success) results.success++;
    else results.failed++;

    if (io) io.emit('batch:progress', {
      processed: results.processed,
      total:     records.length,
      success:   results.success,
      failed:    results.failed,
      latest:    result,
    });

    console.log('[Batch]', results.processed + '/' + records.length,
      result.success ? '✓' : '✗',
      record.customerName, '-', record.errorCode);

    return result;
  }));

  Promise.all(tasks).then(() => {
    console.log('[Batch] Complete:', results);
    if (io) io.emit('batch:completed', results);
  }).catch(err => {
    console.error('[Batch] Fatal error:', err.message);
    if (io) io.emit('batch:error', { error: err.message });
  });
}

module.exports = { runBatch };
