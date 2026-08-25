'use strict';

/**
 * Day 5 Test Script — Compliance Cop + Stopping Rules
 *
 * Covers:
 *   A. Hard rule: discount bounds (boundaries + non-number)
 *   B. Hard rule: outreach cap (at-limit and under-limit)
 *   C. Hard rule: contact window (uses overridden IST hour)
 *   D. Regex stopping rule end-to-end via HTTP
 *   E. Compliance approved for normal action end-to-end via HTTP
 *   F. COMPLIANCE_CHECK audit log entry saved
 *
 * Usage: node server/scripts/testDay5.js
 * Server must be running: cd server && npm run dev
 */

const path = require('path');

// Load env vars so complianceCop can initialise groq-sdk
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { reviewAction } = require('../src/services/complianceCop');

const BASE = process.argv[2] || 'http://localhost:5000/api';

async function httpPost(route, body) {
  const res = await fetch(BASE + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function httpGet(route) {
  const res = await fetch(BASE + route);
  return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pass  = label => console.log('  PASS', label);
const fail  = (label, got) => console.log('  FAIL', label, '|', JSON.stringify(got).slice(0, 180));
const section = t => console.log('\n---', t, '---');

// Fake transaction stub for unit-testing complianceCop directly
const fakeTxn = (overrides = {}) => ({
  customerName: 'Test User',
  originalAmount: 4999,
  outreachCount: 0,
  ...overrides,
});

async function createTxn(errorCode, suffix) {
  const r = await httpPost('/webhooks/payment-failed', {
    customerName: 'Compliance Test',
    phone: '+919876543210',
    email: 'test@example.com',
    originalAmount: 4999,
    errorCode,
    paymentId: 'pay_d5_' + suffix + '_' + Date.now(),
  });
  if (!r.success) throw new Error('Could not create txn: ' + JSON.stringify(r));
  await sleep(700);
  return r.data._id;
}

async function run() {
  console.log('\nRecoverPulse AI - Day 5 Compliance Cop Tests');
  console.log('Target:', BASE);

  try { await httpGet('/health'); console.log('Server reachable\n'); }
  catch { console.error('Server unreachable. Run: cd server && npm run dev'); process.exit(1); }

  // ── A. DISCOUNT BOUNDS ──────────────────────────────────────────────────
  section('A. Discount hard-rule bounds');

  let v;

  v = await reviewAction('apply_settlement_discount', { discountPercent: 5 }, fakeTxn());
  v.approved ? pass('5% approved (lower boundary)') : fail('5% should be approved', v);

  v = await reviewAction('apply_settlement_discount', { discountPercent: 10 }, fakeTxn());
  v.approved ? pass('10% approved (upper boundary)') : fail('10% should be approved', v);

  v = await reviewAction('apply_settlement_discount', { discountPercent: 4.9 }, fakeTxn());
  !v.approved && v.reason.includes('out_of_bounds')
    ? pass('4.9% blocked (below 5% min)')
    : fail('4.9% should be blocked', v);

  v = await reviewAction('apply_settlement_discount', { discountPercent: 10.1 }, fakeTxn());
  !v.approved && v.reason.includes('out_of_bounds')
    ? pass('10.1% blocked (above 10% max)')
    : fail('10.1% should be blocked', v);

  v = await reviewAction('apply_settlement_discount', { discountPercent: 25, reason: 'test' }, fakeTxn());
  !v.approved ? pass('25% blocked') : fail('25% should be blocked', v);

  v = await reviewAction('apply_settlement_discount', { discountPercent: 'ten' }, fakeTxn());
  !v.approved ? pass('Non-number discount blocked') : fail('String discount should be blocked', v);

  v = await reviewAction('apply_settlement_discount', { discountPercent: null }, fakeTxn());
  !v.approved ? pass('null discount blocked') : fail('null discount should be blocked', v);

  // ── Helper to mock time so night-time runs don't fail outreach tests ──
  const OrigDate = Date;
  const mockDate = (utcHour, utcMin = 0) => {
    global.Date = class extends OrigDate {
      getUTCHours() { return utcHour; }
      getUTCMinutes() { return utcMin; }
    };
  };

  // ── B. OUTREACH CAP ──────────────────────────────────────────────────────
  section('B. Outreach cap hard-rule');
  
  // Force time to 12:00 PM IST (UTC 6:30) so contact window passes
  mockDate(6, 30);

  v = await reviewAction('send_whatsapp_message', { message: 'Hi' }, fakeTxn({ outreachCount: 4 }));
  v.approved ? pass('outreachCount=4 approved (under limit)') : fail('4 should pass', v);

  v = await reviewAction('send_whatsapp_message', { message: 'Hi' }, fakeTxn({ outreachCount: 5 }));
  !v.approved && v.reason.includes('outreach_limit_exceeded')
    ? pass('outreachCount=5 blocked (at limit)')
    : fail('5 should be blocked', v);

  v = await reviewAction('send_whatsapp_message', { message: 'Hi' }, fakeTxn({ outreachCount: 99 }));
  !v.approved && v.reason.includes('outreach_limit_exceeded') 
    ? pass('outreachCount=99 blocked') 
    : fail('99 should be blocked', v);

  // ── C. CONTACT WINDOW ───────────────────────────────────────────────────
  section('C. Contact window hard-rule (monkey-patching IST time)');

  // 2:30 AM IST = UTC 21:00 → blocked
  mockDate(21, 0);
  v = await reviewAction('send_whatsapp_message', { message: 'Hi' }, fakeTxn());
  !v.approved && v.reason.includes('contact_window')
    ? pass('2:30 AM IST blocked')
    : fail('2:30 AM should be blocked', v);

  // 8:00 AM IST = UTC 02:30 → utcHour=2, minutes=30 → 2.5 + 5.5 = 8.0 → approved
  global.Date = class extends OrigDate {
    getUTCHours() { return 2; }
    getUTCMinutes() { return 30; }
  };
  v = await reviewAction('send_whatsapp_message', { message: 'Hi' }, fakeTxn());
  v.approved
    ? pass('8:00 AM IST approved (window start boundary)')
    : fail('8:00 AM should be approved', v);

  // 7:00 PM IST exactly = UTC 13:30 → getISTHour = 19.0 → blocked (hour >= 19)
  global.Date = class extends OrigDate {
    getUTCHours() { return 13; }
    getUTCMinutes() { return 30; }
  };
  v = await reviewAction('send_whatsapp_message', { message: 'Hi' }, fakeTxn());
  !v.approved
    ? pass('7:00 PM IST blocked (window end boundary)')
    : fail('7:00 PM should be blocked', v);

  global.Date = OrigDate; // Restore

  // ── D. END-TO-END: Regex stopping rule ──────────────────────────────────
  section('D. End-to-end: Dispute message -> ESCALATED_TO_HUMAN');

  const txnD = await createTxn('INSUFFICIENT_FUNDS', 'dispute');
  const rD = await httpPost('/agent/process', {
    transactionId: txnD,
    inboundMessage: 'I already cancelled this, stop messaging me immediately',
  });
  if (rD.success && rD.data.toolName === 'escalate_to_human') {
    const det = await httpGet('/transactions/' + txnD);
    det.data.state === 'ESCALATED_TO_HUMAN'
      ? pass('State = ESCALATED_TO_HUMAN in DB')
      : fail('Wrong DB state', det.data.state);
    det.data.escalationReason?.includes('dispute')
      ? pass('escalationReason = dispute_or_opt_out_detected')
      : fail('Wrong escalationReason', det.data.escalationReason);
  } else {
    fail('Expected escalate_to_human', rD);
  }

  // ── E. END-TO-END: Normal action approved ───────────────────────────────
  section('E. End-to-end: Normal message -> compliance approved');

  const txnE = await createTxn('INSUFFICIENT_FUNDS', 'approve');
  const rE = await httpPost('/agent/process', {
    transactionId: txnE,
    inboundMessage: 'okay bhai, pay karna chahta hoon abhi',
  });
  if (rE.success && !rE.data.complianceBlocked) {
    pass('Action executed without compliance block');
    pass('Tool used: ' + rE.data.toolName);
  } else {
    fail('Expected non-blocked action', rE);
  }

  // ── F. COMPLIANCE_CHECK in AuditLog ─────────────────────────────────────
  section('F. COMPLIANCE_CHECK entries in AgentAuditLog');

  const det = await httpGet('/transactions/' + txnE);
  const compLogs = (det.data.auditLogs || []).filter(l => l.step === 'COMPLIANCE_CHECK');
  compLogs.length > 0
    ? pass('COMPLIANCE_CHECK entries: ' + compLogs.length + ', approved=' + compLogs[0].complianceVerified)
    : fail('No COMPLIANCE_CHECK log entries', det.data.auditLogs?.map(l => l.step));

  console.log('\nDay 5 tests complete.\n');
}

run().catch(err => { console.error('Runner error:', err.message); process.exit(1); });
