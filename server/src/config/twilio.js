'use strict';

/**
 * @file config/twilio.js
 * @description Twilio SDK singleton.
 *
 * Set in .env:
 *   TWILIO_ACCOUNT_SID  = ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *   TWILIO_AUTH_TOKEN   = your_auth_token
 *   TWILIO_WHATSAPP_NUMBER = whatsapp:+14155238886  (sandbox number)
 */

const twilio = require('twilio');

if (!process.env.TWILIO_ACCOUNT_SID || process.env.TWILIO_ACCOUNT_SID === 'your_twilio_sid') {
  console.warn('[Twilio] WARNING: TWILIO_ACCOUNT_SID not set — WhatsApp messages will be simulated only.');
}

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const FROM_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';

/**
 * Returns true if Twilio is actually configured with real credentials.
 */
function isTwilioConfigured() {
  return (
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_ACCOUNT_SID !== 'your_twilio_sid' &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_AUTH_TOKEN !== 'your_twilio_auth_token'
  );
}

module.exports = { client, FROM_NUMBER, isTwilioConfigured };
