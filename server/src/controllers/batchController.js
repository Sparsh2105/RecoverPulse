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

  const concurrency     = Math.min(3, Math.max(1, parseInt(req.body.concurrency, 10) || 1));
  const speedMultiplier = Math.min(100, Math.max(1, parseFloat(req.body.speedMultiplier) || 1));

  // Calculate inter-record delay to stay under Gemini's 15 RPM limit.
  // Each record may fire 1 Gemini call. At concurrency=1, delay=4000ms stays under 15 RPM.
  // At concurrency=2, delay=8000ms. Formula: delay = (concurrency * 60000) / 15 / speedMultiplier
  const INTER_RECORD_DELAY_MS = Math.max(
    100,
    Math.floor((concurrency * 60000) / 14 / speedMultiplier) // 14 RPM target (buffer below 15)
  );

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

  // Skip LLM compliance tone check during batch to avoid Gemini rate limits.
  process.env.SKIP_LLM_COMPLIANCE = 'true';

  // Create a fresh abort controller for this batch run
  const abortCtrl = { aborted: false };
  batchAbortController = abortCtrl;

  // Run with concurrency limit + inter-record delay
  const limit   = createLimiter(concurrency);
  const results = { processed: 0, success: 0, failed: 0 };

  const tasks = records.map((record, i) => limit(async () => {
    // Check abort flag before every record
    if (abortCtrl.aborted) return { success: false, error: 'aborted' };

    await new Promise(r => setTimeout(r, i * INTER_RECORD_DELAY_MS));

    // Check again after the delay (stop could have been clicked during wait)
    if (abortCtrl.aborted) return { success: false, error: 'aborted' };

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
    if (abortCtrl.aborted) {
      console.log('[Batch] Aborted — not emitting batch:completed');
      return;
    }
    console.log('[Batch] Complete:', results);
    process.env.SKIP_LLM_COMPLIANCE = 'false';
    batchAbortController = null;
    if (io) io.emit('batch:completed', results);
  }).catch(err => {
    console.error('[Batch] Fatal error:', err.message);
    process.env.SKIP_LLM_COMPLIANCE = 'false';
    batchAbortController = null;
    if (io) io.emit('batch:error', { error: err.message });
  });
}

// Global abort controller for the current batch run
let batchAbortController = null;

// ---------------------------------------------------------------------------
// Stop batch
// ---------------------------------------------------------------------------

async function stopBatch(req, res) {
  if (batchAbortController) {
    batchAbortController.aborted = true;
    batchAbortController = null;
  }
  process.env.SKIP_LLM_COMPLIANCE = 'false';
  const io = socket.getIO();
  if (io) io.emit('batch:stopped', {});
  console.log('[Batch] Stopped by user request');
  return res.json({ success: true, message: 'Batch stopped' });
}

// ---------------------------------------------------------------------------
// Complete batch instantly — inserts remaining seed records with final states
// (no LLM calls — used for demo to skip the rate-limited records)
// ---------------------------------------------------------------------------

async function completeBatch(req, res) {
  // First abort any running batch
  if (batchAbortController) {
    batchAbortController.aborted = true;
    batchAbortController = null;
    console.log('[Batch Complete] Aborted running batch first');
  }
  process.env.SKIP_LLM_COMPLIANCE = 'false';

  const io = socket.getIO();

  let records;
  try {
    records = JSON.parse(fs.readFileSync(SEED_FILE, 'utf-8'));
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Failed to read seed file: ' + err.message });
  }

  console.log('[Batch] Demo-completing batch — inserting', records.length, 'records with final states (no LLM)');
  res.json({ success: true, message: 'Batch completion started', total: records.length });

  if (io) io.emit('batch:started', { total: records.length, concurrency: 5, speedMultiplier: 50 });

  const results = { processed: 0, success: 0, failed: 0 };

  for (const record of records) {
    try {
      const { _scenario, ...payload } = record;
      const validation = validatePaymentPayload(payload);
      if (!validation.valid) { results.processed++; results.failed++; continue; }

      const category = classifyErrorCode(validation.sanitized.errorCode);

      // Assign a realistic final state based on category + scenario
      let finalState, escalationReason = null, recoveredAmount = 0;

      if (_scenario === 'dispute_likely') {
        finalState = 'ESCALATED_TO_HUMAN';
        escalationReason = 'dispute_or_opt_out_detected';
      } else if (category === 'infra') {
        // 60% recover silently, 40% go to outreach
        finalState = Math.random() < 0.6 ? 'RECOVERED' : 'OUTREACH_INITIATED';
        recoveredAmount = finalState === 'RECOVERED' ? validation.sanitized.originalAmount : 0;
      } else if (category === 'hard_decline') {
        // Hard declines: 50% recover (updated card), 30% mandate, 20% escalated
        const r = Math.random();
        if (r < 0.5)      { finalState = 'RECOVERED'; recoveredAmount = validation.sanitized.originalAmount; }
        else if (r < 0.8) { finalState = 'MANDATE_PENDING_AUTH'; }
        else               { finalState = 'ESCALATED_TO_HUMAN'; escalationReason = 'outreach_exhausted'; }
      } else {
        // Soft decline: 55% recover, 25% mandate pending, 20% outreach
        const r = Math.random();
        if (r < 0.55)     { finalState = 'RECOVERED'; recoveredAmount = validation.sanitized.originalAmount; }
        else if (r < 0.80){ finalState = 'MANDATE_PENDING_AUTH'; }
        else               { finalState = 'OUTREACH_INITIATED'; }
      }

      const txnData = {
        ...validation.sanitized,
        state:            finalState,
        errorCategory:    category,
        recoveredAmount,
        outreachCount:    ['RECOVERED','MANDATE_PENDING_AUTH','OUTREACH_INITIATED'].includes(finalState) ? Math.floor(Math.random() * 3) + 1 : 0,
        escalationReason,
        promisedDate:     finalState === 'MANDATE_PENDING_AUTH'
          ? new Date(Date.now() + (Math.floor(Math.random() * 25) + 3) * 86400000) // 3-28 days from now
          : null,
      };

      const txn = await TransactionRecord.create(txnData);
      results.processed++;
      results.success++;

      if (io) {
        io.emit('txn:created', txn.toObject());
        io.emit('batch:progress', {
          processed: results.processed,
          total:     records.length,
          success:   results.success,
          failed:    results.failed,
          latest:    { success: true, txnId: txn._id, category, action: finalState },
        });
      }

      // Small delay so the dashboard animation looks smooth
      await new Promise(r => setTimeout(r, 30));
    } catch (err) {
      console.error('[Batch Complete] Error:', err.message);
      results.processed++;
      results.failed++;
    }
  }

  console.log('[Batch] Demo completion done:', results);
  process.env.SKIP_LLM_COMPLIANCE = 'false';
  if (io) io.emit('batch:completed', results);
}

module.exports = { runBatch, stopBatch, completeBatch, clearDatabase };

async function clearDatabase(req, res) {
  try {
    const AgentAuditLog     = require('../models/AgentAuditLog');
    const ConversationMessage = require('../models/ConversationMessage');
    await TransactionRecord.deleteMany({});
    await AgentAuditLog.deleteMany({});
    await ConversationMessage.deleteMany({});
    const io = socket.getIO();
    if (io) io.emit('db:cleared', {});
    console.log('[Clear] Database cleared for demo');
    return res.json({ success: true, message: 'All transactions, audit logs and messages cleared' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
