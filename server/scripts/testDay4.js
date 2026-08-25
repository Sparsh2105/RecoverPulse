/**
 * Day 4 Test Script — Groq ReAct Agent
 *
 * Creates a transaction and runs 4 agent turns to verify routing:
 *   1. "bhai salary 1st ko aayegi"   → should choose generate_upi_mandate
 *   2. "pay karna chahta hoon abhi"  → should choose generate_payment_link
 *   3. "afford nahi ho raha"         → should choose apply_settlement_discount
 *   4. "sue karo tum log"            → should escalate immediately (stopping rule)
 *
 * Usage: node server/scripts/testDay4.js
 * Server must be running: cd server && npm run dev
 */

'use strict';

const BASE = process.argv[2] || 'http://localhost:5000/api';

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function get(path) {
  const res = await fetch(BASE + path);
  return res.json();
}

function pass(label) { console.log('  PASS', label); }
function fail(label, got) { console.log('  FAIL', label, '| got:', JSON.stringify(got)); }
function section(title) { console.log('\n---', title, '---'); }

async function createTransaction(errorCode, suffix) {
  const r = await post('/webhooks/payment-failed', {
    customerName: 'Test Customer',
    phone: '+919876543210',
    email: 'test@example.com',
    originalAmount: 4999,
    errorCode,
    paymentId: 'pay_test_d4_' + suffix + '_' + Date.now(),
  });
  if (!r.success) throw new Error('Failed to create transaction: ' + JSON.stringify(r));
  // Wait a moment for async triage to run
  await new Promise(r => setTimeout(r, 800));
  return r.data._id;
}

async function agentProcess(transactionId, inboundMessage) {
  return post('/agent/process', { transactionId, inboundMessage });
}

async function run() {
  console.log('\nRecoverPulse AI - Day 4 Agent Tests');
  console.log('Target:', BASE);

  // Check server is up
  try {
    await get('/health');
    console.log('Server is reachable\n');
  } catch {
    console.error('Server unreachable. Start it with: cd server && npm run dev');
    process.exit(1);
  }

  section('Test 1: Salary date mention -> generate_upi_mandate');
  const txnId1 = await createTransaction('INSUFFICIENT_FUNDS', 'mandate');
  const r1 = await agentProcess(txnId1, 'bhai salary 1st ko aayegi, tab pay kar dunga');
  if (r1.success && r1.data.toolName === 'generate_upi_mandate') {
    pass('Agent chose generate_upi_mandate');
  } else {
    fail('Expected generate_upi_mandate', r1);
  }

  section('Test 2: Ready to pay now -> generate_payment_link');
  const txnId2 = await createTransaction('INSUFFICIENT_FUNDS', 'paylink');
  const r2 = await agentProcess(txnId2, 'okay bhai, pay karna chahta hoon abhi');
  if (r2.success && r2.data.toolName === 'generate_payment_link') {
    pass('Agent chose generate_payment_link');
  } else {
    fail('Expected generate_payment_link', r2);
  }

  section('Test 3: Cannot afford full -> apply_settlement_discount');
  const txnId3 = await createTransaction('INSUFFICIENT_FUNDS', 'discount');
  const r3 = await agentProcess(txnId3, 'poora amount afford nahi ho raha bhai, kuch discount milega?');
  if (r3.success && r3.data.toolName === 'apply_settlement_discount') {
    pass('Agent chose apply_settlement_discount');
  } else {
    fail('Expected apply_settlement_discount', r3);
  }

  section('Test 4: Legal threat -> escalate_to_human (stopping rule)');
  const txnId4 = await createTransaction('CARD_EXPIRED', 'escalate');
  const r4 = await agentProcess(txnId4, 'tum log fraud kar rahe ho, main sue karunga');
  if (r4.success && r4.data.toolName === 'escalate_to_human') {
    pass('Stopping rule triggered -> escalate_to_human');
  } else {
    fail('Expected escalate_to_human', r4);
  }

  section('Test 5: Verify AgentAuditLog entries were saved');
  const detail = await get('/transactions/' + txnId1);
  if (detail.success && detail.data.auditLogs && detail.data.auditLogs.length > 0) {
    pass('AgentAuditLog has ' + detail.data.auditLogs.length + ' entries for txn 1');
  } else {
    fail('Expected audit log entries', detail.data?.auditLogs);
  }

  console.log('\nDay 4 tests complete.\n');
}

run().catch(err => {
  console.error('Test runner error:', err.message);
  process.exit(1);
});

