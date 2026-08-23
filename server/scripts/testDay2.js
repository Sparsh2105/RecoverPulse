const http = require('http');

const BASE_URL = process.argv[2] || 'http://localhost:5000/api';

async function post(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(BASE_URL + '/webhooks/payment-failed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getTxn(id) {
  return new Promise((resolve, reject) => {
    const req = http.request(BASE_URL + `/transactions/${id}`, { method: 'GET' }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runTests() {
  console.log('--- Day 2 Triage & State Machine Tests ---');

  // Test 1: Soft Decline
  console.log('\n1. Testing Soft Decline (INSUFFICIENT_FUNDS)...');
  let r1 = await post({
    customerName: 'Soft Test',
    phone: '+919876543210',
    originalAmount: 1000,
    errorCode: 'INSUFFICIENT_FUNDS'
  });
  
  await sleep(500); // give async triage time to run
  let tx1 = await getTxn(r1.body.data._id);
  console.assert(tx1.body.data.errorCategory === 'soft_decline', `Expected soft_decline, got ${tx1.body.data.errorCategory}`);
  console.assert(tx1.body.data.state === 'OUTREACH_INITIATED', `Expected OUTREACH_INITIATED, got ${tx1.body.data.state}`);
  console.log('✅ Soft decline routed correctly.');

  // Test 2: Hard Decline
  console.log('\n2. Testing Hard Decline (CARD_EXPIRED)...');
  let r2 = await post({
    customerName: 'Hard Test',
    phone: '+919876543210',
    originalAmount: 1000,
    errorCode: 'CARD_EXPIRED'
  });
  
  await sleep(500);
  let tx2 = await getTxn(r2.body.data._id);
  console.assert(tx2.body.data.errorCategory === 'hard_decline', 'Expected hard_decline');
  console.assert(tx2.body.data.state === 'OUTREACH_INITIATED', 'Expected OUTREACH_INITIATED');
  console.log('✅ Hard decline routed correctly.');

  // Test 3: Infra Error & Silent Retries
  console.log('\n3. Testing Infra Error (BANK_SERVER_DOWN) + Retries...');
  let r3 = await post({
    customerName: 'Infra Test',
    phone: '+919876543210',
    originalAmount: 1000,
    errorCode: 'BANK_SERVER_DOWN',
    paymentId: `pay_infra_${Date.now()}`
  });
  
  await sleep(200); 
  let tx3 = await getTxn(r3.body.data._id);
  console.assert(tx3.body.data.errorCategory === 'infra', 'Expected infra');
  console.assert(tx3.body.data.state === 'SILENT_RETRY_SCHEDULED', 'Expected SILENT_RETRY_SCHEDULED');
  console.log('✅ Initially routed to SILENT_RETRY_SCHEDULED');

  console.log('Waiting for retries to exhaust (~6 seconds)...');
  await sleep(6500);
  
  tx3 = await getTxn(r3.body.data._id);
  console.assert(tx3.body.data.state === 'OUTREACH_INITIATED', `Expected OUTREACH_INITIATED, got ${tx3.body.data.state}`);
  console.assert(tx3.body.data.retryCount === 3, `Expected 3 retries, got ${tx3.body.data.retryCount}`);
  console.log('✅ Retries exhausted and escalated to OUTREACH_INITIATED successfully.');
  
  console.log('\nAll Day 2 tests passed! 🎉');
}

runTests().catch(console.error);
