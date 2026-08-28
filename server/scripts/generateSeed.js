/**
 * @file scripts/generateSeed.js
 * @description Generates 50 synthetic failed-payment records for the batch demo.
 *
 * Distribution (matches blueprint spec):
 *   22 soft_decline   — INSUFFICIENT_FUNDS, PAYMENT_DECLINED, LOW_BALANCE
 *   10 hard_decline   — CARD_EXPIRED, CARD_BLOCKED, INVALID_CARD
 *    8 infra          — BANK_SERVER_DOWN, GATEWAY_TIMEOUT, NETWORK_ERROR
 *    4 price_sensitive — INSUFFICIENT_FUNDS (low amounts, triggers discount flow)
 *    6 dispute/opt-out — will trigger stopping rules when agent contacts them
 *
 * Run: node scripts/generateSeed.js
 * Output: data/seed-50-records.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Data pools
// ---------------------------------------------------------------------------

const FIRST_NAMES = ['Rahul', 'Priya', 'Amit', 'Sneha', 'Vikram', 'Pooja', 'Arjun', 'Kavya',
  'Rohit', 'Ananya', 'Sanjay', 'Divya', 'Karan', 'Meera', 'Aakash', 'Riya',
  'Suresh', 'Neha', 'Manish', 'Shreya', 'Deepak', 'Swati', 'Nikhil', 'Ankita',
  'Rajesh', 'Sunita', 'Vivek', 'Pallavi', 'Ajay', 'Nisha'];

const LAST_NAMES  = ['Sharma', 'Patel', 'Kumar', 'Reddy', 'Singh', 'Joshi', 'Agarwal', 'Gupta',
  'Malhotra', 'Verma', 'Iyer', 'Nair', 'Rao', 'Mehta', 'Shah', 'Chopra',
  'Bose', 'Das', 'Mishra', 'Pandey'];

const PHONE_PREFIXES = ['+9198', '+9197', '+9196', '+9195', '+9189', '+9188', '+9187'];

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr)         { return arr[randInt(0, arr.length - 1)]; }

function generateName() {
  return pick(FIRST_NAMES) + ' ' + pick(LAST_NAMES);
}

function generatePhone() {
  return pick(PHONE_PREFIXES) + String(randInt(10000000, 99999999));
}

function generateEmail(name) {
  const clean = name.toLowerCase().replace(/\s+/g, '.').replace(/[^a-z.]/g, '');
  const domains = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'rediffmail.com'];
  return clean + randInt(1, 999) + '@' + pick(domains);
}

// ---------------------------------------------------------------------------
// Record generators per category
// ---------------------------------------------------------------------------

function makeSoftDecline(i) {
  const name = generateName();
  const amounts = [999, 1499, 1999, 2499, 2999, 3499, 3999, 4499, 4999, 5999, 6999, 7999, 9999, 11999, 14999];
  const codes   = ['INSUFFICIENT_FUNDS', 'PAYMENT_DECLINED', 'PAYMENT_DECLINED', 'INSUFFICIENT_FUNDS'];
  return {
    customerName:   name,
    phone:          generatePhone(),
    email:          generateEmail(name),
    originalAmount: pick(amounts),
    currency:       'INR',
    errorCode:      pick(codes),
    _scenario:      'soft_decline',
  };
}

function makeHardDecline(i) {
  const name = generateName();
  const amounts = [2999, 3999, 4999, 5999, 7999, 9999, 12999, 14999, 19999, 24999];
  const codes   = ['CARD_EXPIRED', 'CARD_EXPIRED', 'CARD_BLOCKED', 'INVALID_CARD', 'CARD_LOST'];
  return {
    customerName:   name,
    phone:          generatePhone(),
    email:          generateEmail(name),
    originalAmount: pick(amounts),
    currency:       'INR',
    errorCode:      pick(codes),
    _scenario:      'hard_decline',
  };
}

function makeInfra(i) {
  const name = generateName();
  const amounts = [4999, 7999, 9999, 12500, 14999, 19999, 24999, 29999];
  const codes   = ['BANK_SERVER_DOWN', 'GATEWAY_TIMEOUT', 'NETWORK_ERROR', 'PAYMENT_GATEWAY_ERROR'];
  return {
    customerName:   name,
    phone:          generatePhone(),
    email:          generateEmail(name),
    originalAmount: pick(amounts),
    currency:       'INR',
    errorCode:      pick(codes),
    _scenario:      'infra',
  };
}

function makePriceSensitive(i) {
  const name = generateName();
  // Low amounts — agent should offer discount
  const amounts = [499, 599, 699, 799, 899, 999];
  return {
    customerName:   name,
    phone:          generatePhone(),
    email:          generateEmail(name),
    originalAmount: pick(amounts),
    currency:       'INR',
    errorCode:      'INSUFFICIENT_FUNDS',
    _scenario:      'price_sensitive',
  };
}

function makeDispute(i) {
  const name = generateName();
  const amounts = [2999, 4999, 7999, 9999, 12999, 14999];
  // These records have notes marking them as likely disputes/opt-outs
  // When the agent contacts them, the customer will (in real demo) reply with dispute keywords
  return {
    customerName:   name,
    phone:          generatePhone(),
    email:          generateEmail(name),
    originalAmount: pick(amounts),
    currency:       'INR',
    errorCode:      'PAYMENT_DECLINED',
    _scenario:      'dispute_likely',
    // Note: in batch simulation these auto-escalate to test stopping rules
  };
}

// ---------------------------------------------------------------------------
// Generate the 50 records
// ---------------------------------------------------------------------------

const records = [];

// 22 soft declines
for (let i = 0; i < 22; i++) records.push(makeSoftDecline(i));

// 10 hard declines
for (let i = 0; i < 10; i++) records.push(makeHardDecline(i));

// 8 infra errors
for (let i = 0; i < 8; i++)  records.push(makeInfra(i));

// 4 price sensitive
for (let i = 0; i < 4; i++)  records.push(makePriceSensitive(i));

// 6 dispute/opt-out likely
for (let i = 0; i < 6; i++)  records.push(makeDispute(i));

// Shuffle so they're not grouped by type in the dashboard
for (let i = records.length - 1; i > 0; i--) {
  const j = randInt(0, i);
  [records[i], records[j]] = [records[j], records[i]];
}

// ---------------------------------------------------------------------------
// Write output
// ---------------------------------------------------------------------------

const outDir  = path.resolve(__dirname, '../data');
const outFile = path.join(outDir, 'seed-50-records.json');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(outFile, JSON.stringify(records, null, 2));

console.log('✅ Generated', records.length, 'seed records →', outFile);

// Print distribution summary
const summary = records.reduce((acc, r) => {
  acc[r._scenario] = (acc[r._scenario] || 0) + 1;
  return acc;
}, {});
console.log('Distribution:', JSON.stringify(summary, null, 2));
