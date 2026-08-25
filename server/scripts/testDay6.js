/**
 * @file scripts/testDay6.js
 * @description Manual end-to-end test for Day 6 — Razorpay integration.
 *
 * What this tests:
 *   1. Simulates a failed payment (soft_decline) via the webhook endpoint.
 *   2. Polls until the transaction is in OUTREACH_INITIATED state.
 *   3. Sends a UPI mandate request via the agent ("salary 1st ko aayegi").
 *   4. Verifies generate_upi_mandate created a real Razorpay mandate (short_url present).
 *   5. Simulates a payment capture via POST /api/webhooks/razorpay.
 *   6. Verifies the transaction moved to RECOVERED and recoveredAmount is set.
 *
 * Run: node scripts/testDay6.js
 * Requires server to be running on PORT 5000.
 */

'use strict';

require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const BASE = 'http://localhost:' + (process.env.PORT || 5000);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

async function pollState(txnId, targetState, maxWaitMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await sleep(500);
    const data = await get('/api/transactions/' + txnId);
    if (data.data?.state === targetState) return data.data;
  }
  throw new Error('Timed out waiting for state: ' + targetState);
}

async function run() {
  console.log('\n═══════════════════════════════════════');
  console.log('  RecoverPulse Day 6 — Integration Test');
  console.log('═══════════════════════════════════════\n');

  // ── Step 1: Simulate failed payment ────────────────────────────────────────
  console.log('STEP 1: Simulate failed payment (INSUFFICIENT_FUNDS)...');
  const webhookRes = await post('/api/webhooks/payment-failed', {
    customerName:   'Test Customer Day6',
    phone:          '+919999888877',
    email:          'testday6@example.com',
    originalAmount: 3499,
    errorCode:      'INSUFFICIENT_FUNDS',
  });

  if (!webhookRes.success) {
    throw new Error('Webhook ingestion failed: ' + JSON.stringify(webhookRes));
  }
  const txnId = webhookRes.data._id;
  console.log('  ✅ Transaction created:', txnId);

  // ── Step 2: Wait for triage → OUTREACH_INITIATED ──────────────────────────
  console.log('\nSTEP 2: Waiting for triage to route to OUTREACH_INITIATED...');
  const outreachTxn = await pollState(txnId, 'OUTREACH_INITIATED');
  console.log('  ✅ State:', outreachTxn.state, '| ErrorCategory:', outreachTxn.errorCategory);

  // ── Step 3: Agent turn — UPI mandate request ──────────────────────────────
  console.log('\nSTEP 3: Sending agent message (UPI mandate scenario)...');
  const agentRes = await post('/api/agent/process', {
    transactionId: txnId,
    inboundMessage: 'bhai salary 1st ko aayegi, tab pay kar dunga',
  });

  if (!agentRes.success) {
    throw new Error('Agent turn failed: ' + JSON.stringify(agentRes));
  }
  const { toolName, observation } = agentRes.data;
  console.log('  ✅ Tool chosen:', toolName);
  console.log('  ✅ Observation:', observation);

  if (toolName !== 'generate_upi_mandate' && toolName !== 'send_whatsapp_message') {
    console.warn('  ⚠️  Unexpected tool choice (expected generate_upi_mandate or send_whatsapp_message)');
  }

  // ── Step 4: Verify mandate link was created ───────────────────────────────
  console.log('\nSTEP 4: Verifying transaction has activePaymentLink (mandate URL)...');
  const txnAfterMandate = await get('/api/transactions/' + txnId);
  const txnData = txnAfterMandate.data;

  if (txnData.activePaymentLink) {
    console.log('  ✅ Mandate/payment link:', txnData.activePaymentLink);
  } else {
    console.log('  ⚠️  No activePaymentLink yet — agent may have sent a WhatsApp message instead');
    console.log('     (Real Razorpay calls require valid test credentials — check .env)');
  }
  console.log('  State after mandate:', txnData.state);

  // ── Step 5: Simulate Razorpay payment.captured webhook ────────────────────
  console.log('\nSTEP 5: Simulating Razorpay payment.captured webhook...');
  const razorpayWebhookPayload = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id:     'pay_test_day6_' + Date.now(),
          amount: 349900, // paise (Rs. 3499)
          currency: 'INR',
          status:   'captured',
          notes:    { transactionId: txnId },
        },
      },
    },
  };

  const captureRes = await post('/api/webhooks/razorpay', razorpayWebhookPayload);
  console.log('  Razorpay webhook response:', JSON.stringify(captureRes));

  // ── Step 6: Verify RECOVERED state ────────────────────────────────────────
  console.log('\nSTEP 6: Verifying final state is RECOVERED...');
  await sleep(500);
  const finalTxn = await get('/api/transactions/' + txnId);
  const finalData = finalTxn.data;

  console.log('  State:', finalData.state);
  console.log('  Recovered Amount: Rs.' + finalData.recoveredAmount);
  console.log('  Audit Logs:', finalData.auditLogs?.length, 'entries');

  if (finalData.state === 'RECOVERED') {
    console.log('\n  ✅ ✅ ✅  RECOVERED — Day 6 integration test PASSED');
  } else {
    console.log('\n  ❌ Final state is', finalData.state, '— expected RECOVERED');
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════');
  console.log('  Audit Trail Summary');
  console.log('═══════════════════════════════════════');
  if (finalData.auditLogs) {
    finalData.auditLogs.forEach((log, i) => {
      const tool = log.toolName ? ' [' + log.toolName + ']' : '';
      console.log('  ' + (i + 1) + '. ' + log.step + tool);
      if (log.thoughtProcess) console.log('     → ' + log.thoughtProcess.slice(0, 80));
      if (log.toolOutput?.observation) console.log('     → ' + log.toolOutput.observation);
    });
  }
  console.log('');
}

run().catch((err) => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
