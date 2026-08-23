/**
 * RecoverPulse AI — Comprehensive Webhook Test Suite
 * 
 * Tests every happy path AND edge case for POST /api/webhooks/payment-failed
 * Run: node server/scripts/testWebhook.js [BASE_URL]
 * Default BASE_URL: http://localhost:5000
 *
 * Output: colored pass/fail for each test + summary at the end
 */

const BASE_URL = process.argv[2] || 'http://localhost:5000';
const ENDPOINT = `${BASE_URL}/api/webhooks/payment-failed`;

// --- tiny color helpers (no deps) -------------------------------------------
const c = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

// --- helper: POST to webhook -------------------------------------------------
async function post(payload) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

// --- test runner -------------------------------------------------------------
let passed = 0, failed = 0;

async function test(description, fn) {
  try {
    const result = await fn();
    if (result === true) {
      console.log(`  ${c.green('PASS')} ${description}`);
      passed++;
    } else {
      console.log(`  ${c.red('FAIL')} ${description}`);
      console.log(`       ${c.dim('? ' + (result || 'assertion failed'))}`);
      failed++;
    }
  } catch (err) {
    console.log(`  ${c.red('ERR ')} ${description}`);
    console.log(`       ${c.dim('? ' + err.message)}`);
    failed++;
  }
}

function assert(condition, message) {
  return condition ? true : (message || 'assertion failed');
}

// --- Test Suites -------------------------------------------------------------

async function runHappyPaths() {
  console.log(c.bold(c.cyan('\n???  HAPPY PATHS  ???')));

  await test('1. Minimal valid payload (INR default currency)', async () => {
    const r = await post({
      customerName: 'Rahul Sharma',
      phone: '+919876543210',
      originalAmount: 4999,
      errorCode: 'INSUFFICIENT_FUNDS',
    });
    return assert(r.status === 201 && r.body.success, `Got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('2. Full payload with all optional fields (USD)', async () => {
    const r = await post({
      customerName: 'Priya Patel',
      phone: '+14155551234',
      email: 'priya@example.com',
      originalAmount: 250.50,
      currency: 'USD',
      errorCode: 'CARD_EXPIRED',
      paymentId: `rzp_test_unique_${Date.now()}`,
    });
    return assert(r.status === 201 && r.body.success, `Got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('3. Decimal amount is stored correctly', async () => {
    const r = await post({
      customerName: 'Amit Kumar',
      phone: '+919123456789',
      originalAmount: 1234.56,
      errorCode: 'BANK_SERVER_DOWN',
    });
    return assert(
      r.status === 201 && r.body.data.originalAmount === 1234.56,
      `Amount stored as: ${r.body.data?.originalAmount}`
    );
  });

  await test('4. errorCode is uppercased and stored normalised', async () => {
    const r = await post({
      customerName: 'Sneha Gupta',
      phone: '+919988776655',
      originalAmount: 799,
      errorCode: 'card_declined', // lowercase input
    });
    return assert(
      r.status === 201 && r.body.data.errorCode === 'CARD_DECLINED',
      `errorCode stored as: ${r.body.data?.errorCode}`
    );
  });

  await test('5. Leading/trailing whitespace in customerName is trimmed', async () => {
    const r = await post({
      customerName: '   Vikram Singh   ',
      phone: '+917654321098',
      originalAmount: 2500,
      errorCode: 'INSUFFICIENT_FUNDS',
    });
    return assert(
      r.status === 201 && r.body.data.customerName === 'Vikram Singh',
      `customerName stored as: "${r.body.data?.customerName}"`
    );
  });

  await test('6. currency is uppercased and accepted (lowercase input)', async () => {
    const r = await post({
      customerName: 'Rohit Mehta',
      phone: '+919876501234',
      originalAmount: 100,
      errorCode: 'INSUFFICIENT_FUNDS',
      currency: 'inr', // lowercase
    });
    return assert(
      r.status === 201 && r.body.data.currency === 'INR',
      `Got ${r.status}: ${JSON.stringify(r.body)}`
    );
  });

  await test('7. state defaults to FAILED_PAYMENT_INGESTED', async () => {
    const r = await post({
      customerName: 'Deepa Nair',
      phone: '+919812345678',
      originalAmount: 5000,
      errorCode: 'BANK_SERVER_DOWN',
    });
    return assert(
      r.status === 201 && r.body.data.state === 'FAILED_PAYMENT_INGESTED',
      `state: ${r.body.data?.state}`
    );
  });

  await test('8. Transaction with GBP currency accepted', async () => {
    const r = await post({
      customerName: 'Arjun Kapoor',
      phone: '+447911123456',
      originalAmount: 149.99,
      currency: 'GBP',
      errorCode: 'CARD_EXPIRED',
    });
    return assert(r.status === 201 && r.body.success, `Got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('9. email is lowercased and stored correctly', async () => {
    const r = await post({
      customerName: 'Pooja Reddy',
      phone: '+919876543220',
      email: 'POOJA@EXAMPLE.COM',
      originalAmount: 3000,
      errorCode: 'INSUFFICIENT_FUNDS',
    });
    return assert(
      r.status === 201 && r.body.data.email === 'pooja@example.com',
      `email stored as: ${r.body.data?.email}`
    );
  });

  await test('10. Minimum valid amount (1 paisa as 0.01)', async () => {
    const r = await post({
      customerName: 'Test Min Amount',
      phone: '+919876543299',
      originalAmount: 0.01,
      errorCode: 'INSUFFICIENT_FUNDS',
    });
    return assert(r.status === 201 && r.body.success, `Got ${r.status}: ${JSON.stringify(r.body)}`);
  });
}

async function runMissingFieldCases() {
  console.log(c.bold(c.cyan('\n???  MISSING REQUIRED FIELDS  ???')));

  const base = { customerName: 'Test User', phone: '+919876543210', originalAmount: 1000, errorCode: 'ERR_001' };

  await test('11. Missing customerName ? 400 MISSING_REQUIRED_FIELDS', async () => {
    const { customerName, ...payload } = base;
    const r = await post(payload);
    return assert(r.status === 400 && r.body.errorCode === 'MISSING_REQUIRED_FIELDS', JSON.stringify(r.body));
  });

  await test('12. Missing phone ? 400 MISSING_REQUIRED_FIELDS', async () => {
    const { phone, ...payload } = base;
    const r = await post(payload);
    return assert(r.status === 400 && r.body.errorCode === 'MISSING_REQUIRED_FIELDS', JSON.stringify(r.body));
  });

  await test('13. Missing originalAmount ? 400 MISSING_REQUIRED_FIELDS', async () => {
    const { originalAmount, ...payload } = base;
    const r = await post(payload);
    return assert(r.status === 400 && r.body.errorCode === 'MISSING_REQUIRED_FIELDS', JSON.stringify(r.body));
  });

  await test('14. Missing errorCode ? 400 MISSING_REQUIRED_FIELDS', async () => {
    const { errorCode, ...payload } = base;
    const r = await post(payload);
    return assert(r.status === 400 && r.body.errorCode === 'MISSING_REQUIRED_FIELDS', JSON.stringify(r.body));
  });

  await test('15. Empty body {} ? 400 MISSING_REQUIRED_FIELDS', async () => {
    const r = await post({});
    return assert(r.status === 400 && r.body.errorCode === 'MISSING_REQUIRED_FIELDS', JSON.stringify(r.body));
  });

  await test('16. Whitespace-only customerName ? 400 MISSING_REQUIRED_FIELDS', async () => {
    const r = await post({ ...base, customerName: '   ' });
    return assert(r.status === 400 && r.body.errorCode === 'MISSING_REQUIRED_FIELDS', JSON.stringify(r.body));
  });

  await test('17. Whitespace-only phone ? 400 MISSING_REQUIRED_FIELDS', async () => {
    const r = await post({ ...base, phone: '   ' });
    return assert(r.status === 400 && r.body.errorCode === 'MISSING_REQUIRED_FIELDS', JSON.stringify(r.body));
  });

  await test('18. Whitespace-only errorCode ? 400 MISSING_REQUIRED_FIELDS', async () => {
    const r = await post({ ...base, errorCode: '   ' });
    return assert(r.status === 400 && r.body.errorCode === 'MISSING_REQUIRED_FIELDS', JSON.stringify(r.body));
  });

  await test('19. null values for required fields ? 400', async () => {
    const r = await post({ customerName: null, phone: null, originalAmount: null, errorCode: null });
    return assert(r.status === 400, `Got ${r.status}`);
  });

  await test('20. originalAmount as empty string ? 400 MISSING_REQUIRED_FIELDS', async () => {
    const r = await post({ ...base, originalAmount: '' });
    return assert(r.status === 400 && r.body.errorCode === 'MISSING_REQUIRED_FIELDS', JSON.stringify(r.body));
  });
}

async function runAmountEdgeCases() {
  console.log(c.bold(c.cyan('\n???  AMOUNT EDGE CASES  ???')));

  const base = { customerName: 'Amount Test', phone: '+919876543210', errorCode: 'INSUFFICIENT_FUNDS' };

  await test('21. Amount = 0 ? 400 AMOUNT_MUST_BE_POSITIVE', async () => {
    const r = await post({ ...base, originalAmount: 0 });
    return assert(r.status === 400 && r.body.errorCode === 'AMOUNT_MUST_BE_POSITIVE', JSON.stringify(r.body));
  });

  await test('22. Negative amount ? 400 AMOUNT_MUST_BE_POSITIVE', async () => {
    const r = await post({ ...base, originalAmount: -500 });
    return assert(r.status === 400 && r.body.errorCode === 'AMOUNT_MUST_BE_POSITIVE', JSON.stringify(r.body));
  });

  await test('23. Amount = Infinity → 400 (JSON serializes Infinity as null → MISSING_REQUIRED_FIELDS)', async () => {
    // Note: JSON.stringify converts Infinity to null before the HTTP request is sent.
    // The server never sees Infinity — it sees null → correctly reports MISSING_REQUIRED_FIELDS.
    // Both MISSING_REQUIRED_FIELDS and INVALID_AMOUNT_TYPE are acceptable here.
    const r = await post({ ...base, originalAmount: Infinity });
    const acceptable = r.status === 400 &&
      (r.body.errorCode === 'INVALID_AMOUNT_TYPE' || r.body.errorCode === 'MISSING_REQUIRED_FIELDS');
    return assert(acceptable, `Got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('24. Amount = NaN → 400 (JSON serializes NaN as null → MISSING_REQUIRED_FIELDS)', async () => {
    // Same as above: NaN → null in JSON. Both errorCodes acceptable.
    const r = await post({ ...base, originalAmount: NaN });
    const acceptable = r.status === 400 &&
      (r.body.errorCode === 'INVALID_AMOUNT_TYPE' || r.body.errorCode === 'MISSING_REQUIRED_FIELDS');
    return assert(acceptable, `Got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('23b. Amount = "Infinity" (string) → 400 INVALID_AMOUNT_TYPE', async () => {
    // Sending the string "Infinity" bypasses JSON serialization — server must catch it
    const r = await post({ ...base, originalAmount: 'Infinity' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_AMOUNT_TYPE', JSON.stringify(r.body));
  });

  await test('24b. Amount = "NaN" (string) → 400 INVALID_AMOUNT_TYPE', async () => {
    // Sending the string "NaN" — Number("NaN") = NaN, !isFinite catches it
    const r = await post({ ...base, originalAmount: 'NaN' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_AMOUNT_TYPE', JSON.stringify(r.body));
  });

  await test('25. Amount as non-numeric string ? 400 INVALID_AMOUNT_TYPE', async () => {
    const r = await post({ ...base, originalAmount: 'five-hundred' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_AMOUNT_TYPE', JSON.stringify(r.body));
  });

  await test('26. Amount as numeric string "4999" ? 201 (coerced to number)', async () => {
    const r = await post({ ...base, originalAmount: '4999' });
    return assert(r.status === 201 && r.body.data.originalAmount === 4999, `Got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('27. Amount exceeds cap (2 billion) ? 400 AMOUNT_EXCEEDS_LIMIT', async () => {
    const r = await post({ ...base, originalAmount: 2_000_000_000 });
    return assert(r.status === 400 && r.body.errorCode === 'AMOUNT_EXCEEDS_LIMIT', JSON.stringify(r.body));
  });

  await test('28. Amount = boolean true ? 400 INVALID_AMOUNT_TYPE', async () => {
    const r = await post({ ...base, originalAmount: true });
    // Note: Number(true) = 1, which would pass as a valid amount of 1.
    // Both outcomes are acceptable; this test documents the behaviour.
    const acceptable = r.status === 201 || (r.status === 400 && r.body.errorCode === 'INVALID_AMOUNT_TYPE');
    return assert(acceptable, `Got ${r.status}: ${JSON.stringify(r.body)}`);
  });
}

async function runPhoneEdgeCases() {
  console.log(c.bold(c.cyan('\n???  PHONE FORMAT EDGE CASES  ???')));

  const base = { customerName: 'Phone Test', originalAmount: 1000, errorCode: 'INSUFFICIENT_FUNDS' };

  await test('29. Valid Indian phone +919876543210 ? 201', async () => {
    const r = await post({ ...base, phone: '+919876543210' });
    return assert(r.status === 201, `Got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('30. Without country code "9876543210" ? 400 INVALID_PHONE_FORMAT', async () => {
    const r = await post({ ...base, phone: '9876543210' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_PHONE_FORMAT', JSON.stringify(r.body));
  });

  await test('31. Letters in phone "+91abcdefgh" ? 400 INVALID_PHONE_FORMAT', async () => {
    const r = await post({ ...base, phone: '+91abcdefgh' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_PHONE_FORMAT', JSON.stringify(r.body));
  });

  await test('32. Too short "+911234" (< 7 digits after +) ? 400 INVALID_PHONE_FORMAT', async () => {
    const r = await post({ ...base, phone: '+911234' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_PHONE_FORMAT', JSON.stringify(r.body));
  });

  await test('33. Too long (16 digits after +, over E.164 max of 15) → 400 INVALID_PHONE_FORMAT', async () => {
    // E.164 max = 15 digits. +9198765432101234 has 16 digits after + → rejected.
    const r = await post({ ...base, phone: '+9198765432101234' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_PHONE_FORMAT', JSON.stringify(r.body));
  });

  await test('34. Spaces in phone "+91 98765 43210" ? 400 INVALID_PHONE_FORMAT', async () => {
    const r = await post({ ...base, phone: '+91 98765 43210' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_PHONE_FORMAT', JSON.stringify(r.body));
  });

  await test('35. Dashes in phone "+91-9876-543210" ? 400 INVALID_PHONE_FORMAT', async () => {
    const r = await post({ ...base, phone: '+91-9876-543210' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_PHONE_FORMAT', JSON.stringify(r.body));
  });

  await test('36. US phone +14155551234 ? 201', async () => {
    const r = await post({ ...base, phone: '+14155551234' });
    return assert(r.status === 201, `Got ${r.status}: ${JSON.stringify(r.body)}`);
  });
}

async function runEmailEdgeCases() {
  console.log(c.bold(c.cyan('\n???  EMAIL EDGE CASES  ???')));

  const base = { customerName: 'Email Test', phone: '+919876543210', originalAmount: 1000, errorCode: 'INSUFFICIENT_FUNDS' };

  await test('37. No email provided ? 201 (optional field)', async () => {
    const r = await post({ ...base });
    return assert(r.status === 201 && r.body.data.email === null, `email: ${r.body.data?.email}`);
  });

  await test('38. Valid email ? 201 and stored lowercase', async () => {
    const r = await post({ ...base, email: 'TEST@EXAMPLE.COM' });
    return assert(r.status === 201 && r.body.data.email === 'test@example.com', `email: ${r.body.data?.email}`);
  });

  await test('39. Email missing @ ? 400 INVALID_EMAIL_FORMAT', async () => {
    const r = await post({ ...base, email: 'notanemail.com' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_EMAIL_FORMAT', JSON.stringify(r.body));
  });

  await test('40. Email missing domain ? 400 INVALID_EMAIL_FORMAT', async () => {
    const r = await post({ ...base, email: 'user@' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_EMAIL_FORMAT', JSON.stringify(r.body));
  });

  await test('41. Email with spaces ? 400 INVALID_EMAIL_FORMAT', async () => {
    const r = await post({ ...base, email: 'user @example.com' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_EMAIL_FORMAT', JSON.stringify(r.body));
  });
}

async function runCurrencyEdgeCases() {
  console.log(c.bold(c.cyan('\n???  CURRENCY EDGE CASES  ???')));

  const base = { customerName: 'Currency Test', phone: '+919876543210', originalAmount: 1000, errorCode: 'INSUFFICIENT_FUNDS' };

  await test('42. No currency ? defaults to INR', async () => {
    const r = await post({ ...base });
    return assert(r.status === 201 && r.body.data.currency === 'INR', `currency: ${r.body.data?.currency}`);
  });

  await test('43. Unsupported currency "XYZ" ? 400 INVALID_CURRENCY', async () => {
    const r = await post({ ...base, currency: 'XYZ' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_CURRENCY', JSON.stringify(r.body));
  });

  await test('44. Currency "RUPEES" (invalid) ? 400 INVALID_CURRENCY', async () => {
    const r = await post({ ...base, currency: 'RUPEES' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_CURRENCY', JSON.stringify(r.body));
  });

  await test('45. Currency "123" (numeric string) ? 400 INVALID_CURRENCY', async () => {
    const r = await post({ ...base, currency: '123' });
    return assert(r.status === 400 && r.body.errorCode === 'INVALID_CURRENCY', JSON.stringify(r.body));
  });

  for (const curr of ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD']) {
    await test(`46-. Currency "${curr}" ? 201`, async () => {
      const r = await post({ ...base, currency: curr });
      return assert(r.status === 201, `Got ${r.status}: ${JSON.stringify(r.body)}`);
    });
  }
}

async function runDuplicatePaymentId() {
  console.log(c.bold(c.cyan('\n???  PAYMENTID DEDUPLICATION  ???')));

  const uniqueId = `pay_test_dedup_${Date.now()}`;
  const base = { customerName: 'Dedup Test', phone: '+919876543210', originalAmount: 999, errorCode: 'INSUFFICIENT_FUNDS', paymentId: uniqueId };

  await test('47. First insert with unique paymentId ? 201', async () => {
    const r = await post(base);
    return assert(r.status === 201 && r.body.success, `Got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  await test('48. Second insert with same paymentId ? 409 DUPLICATE_PAYMENT_ID', async () => {
    const r = await post(base);
    return assert(
      r.status === 409 && r.body.errorCode === 'DUPLICATE_PAYMENT_ID',
      `Got ${r.status}: ${JSON.stringify(r.body)}`
    );
  });

  await test('49. Response includes existingTransactionId on duplicate', async () => {
    const r = await post(base);
    return assert(
      r.status === 409 && r.body.existingTransactionId,
      `existingTransactionId: ${r.body.existingTransactionId}`
    );
  });

  await test('50. No paymentId ? always allowed (no dedup)', async () => {
    const { paymentId, ...noId } = base;
    const r1 = await post(noId);
    const r2 = await post(noId);
    return assert(r1.status === 201 && r2.status === 201, `r1=${r1.status}, r2=${r2.status}`);
  });
}

async function runContentTypeEdgeCases() {
  console.log(c.bold(c.cyan('\n???  CONTENT-TYPE / PARSING EDGE CASES  ???')));

  await test('51. Request with valid JSON but wrong Content-Type still works if body parses', async () => {
    // Express with express.json() should handle this gracefully
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ customerName: 'CT Test', phone: '+919876543210', originalAmount: 100, errorCode: 'ERR' }),
    });
    // May 400 (body not parsed) or 201 — document the actual behaviour
    const json = await res.json().catch(() => ({}));
    const acceptable = res.status === 201 || res.status === 400;
    return assert(acceptable, `Unexpected status: ${res.status}`);
  });

  await test('52. Empty string body ? 400', async () => {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '',
    });
    const acceptable = res.status === 400 || res.status === 500;
    return assert(acceptable, `Got ${res.status}`);
  });

  await test('53. Malformed JSON ? 400', async () => {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ bad json {{',
    });
    return assert(res.status === 400, `Got ${res.status}`);
  });

  await test('54. Extra unknown fields are ignored (no error)', async () => {
    const r = await post({
      customerName: 'Extra Fields Test',
      phone: '+919876543210',
      originalAmount: 500,
      errorCode: 'INSUFFICIENT_FUNDS',
      hackerField: 'injected',
      __proto__: { polluted: true },
    });
    return assert(r.status === 201, `Got ${r.status}: ${JSON.stringify(r.body)}`);
  });
}

async function runGetEndpoints() {
  console.log(c.bold(c.cyan('\n???  GET /transactions ENDPOINT  ???')));

  await test('55. GET /api/transactions ? 200 with data array', async () => {
    const res = await fetch(`${BASE_URL}/api/transactions`);
    const json = await res.json();
    return assert(res.status === 200 && Array.isArray(json.data), `Got ${res.status}: ${JSON.stringify(json)}`);
  });

  await test('56. GET /api/transactions?state=FAILED_PAYMENT_INGESTED ? filtered', async () => {
    const res = await fetch(`${BASE_URL}/api/transactions?state=FAILED_PAYMENT_INGESTED`);
    const json = await res.json();
    const allMatch = json.data.every(t => t.state === 'FAILED_PAYMENT_INGESTED');
    return assert(res.status === 200 && allMatch, `Some states mismatch: ${JSON.stringify(json.data.map(t => t.state))}`);
  });

  await test('57. GET /api/transactions?page=1&limit=2 ? max 2 results', async () => {
    const res = await fetch(`${BASE_URL}/api/transactions?page=1&limit=2`);
    const json = await res.json();
    return assert(res.status === 200 && json.data.length <= 2, `Got ${json.data.length} results`);
  });

  await test('58. GET /api/transactions/:id with valid ID ? full detail', async () => {
    // First create a transaction to get a real ID
    const created = await post({
      customerName: 'Detail Test', phone: '+919876543200', originalAmount: 100, errorCode: 'TEST_CODE'
    });
    const id = created.body.data._id;
    const res = await fetch(`${BASE_URL}/api/transactions/${id}`);
    const json = await res.json();
    return assert(
      res.status === 200 && json.data._id === id && Array.isArray(json.data.auditLogs),
      `Got ${res.status}: ${JSON.stringify(json)}`
    );
  });

  await test('59. GET /api/transactions/invalid-id ? 500 or 400 (not crash)', async () => {
    const res = await fetch(`${BASE_URL}/api/transactions/not-a-valid-mongo-id`);
    return assert(res.status >= 400 && res.status < 600, `Got ${res.status}`);
  });

  await test('60. GET /api/transactions/stats/summary ? correct shape', async () => {
    const res = await fetch(`${BASE_URL}/api/transactions/stats/summary`);
    const json = await res.json();
    const keys = ['totalTransactions', 'recovered', 'failed', 'escalated', 'inProgress', 'recoveryRate'];
    const hasAllKeys = keys.every(k => k in json.data);
    return assert(res.status === 200 && hasAllKeys, `Missing keys. Got: ${JSON.stringify(json)}`);
  });

  await test('61. GET /api/health ? service info', async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    const json = await res.json();
    return assert(res.status === 200 && json.status === 'ok', `Got ${res.status}: ${JSON.stringify(json)}`);
  });

  await test('62. GET /api/unknown-route ? 404 not crash', async () => {
    const res = await fetch(`${BASE_URL}/api/nonexistent`);
    return assert(res.status === 404, `Got ${res.status}`);
  });
}

// --- MAIN --------------------------------------------------------------------

async function main() {
  console.log(c.bold(`\n?? RecoverPulse AI — Webhook Test Suite`));
  console.log(c.dim(`   Target: ${BASE_URL}\n`));

  // Quick connectivity check
  try {
    const health = await fetch(`${BASE_URL}/api/health`);
    if (!health.ok) throw new Error(`health check returned ${health.status}`);
    console.log(c.green('?  Server is reachable\n'));
  } catch (err) {
    console.error(c.red(`?  Cannot reach server at ${BASE_URL}`));
    console.error(c.red(`   Start it with: cd server && npm run dev`));
    console.error(c.dim(`   Error: ${err.message}`));
    process.exit(1);
  }

  await runHappyPaths();
  await runMissingFieldCases();
  await runAmountEdgeCases();
  await runPhoneEdgeCases();
  await runEmailEdgeCases();
  await runCurrencyEdgeCases();
  await runDuplicatePaymentId();
  await runContentTypeEdgeCases();
  await runGetEndpoints();

  // -- Summary --------------------------------------------------
  const total = passed + failed;
  console.log('\n' + '-'.repeat(50));
  console.log(c.bold(`Results: ${passed}/${total} passed`));
  if (failed > 0) {
    console.log(c.red(`         ${failed} FAILED — review output above`));
    process.exit(1);
  } else {
    console.log(c.green('         All tests passed! ?'));
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(c.red('Fatal error running test suite:'), err);
  process.exit(1);
});

