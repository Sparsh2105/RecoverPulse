'use strict';

/**
 * @file controllers/twilioWebhookController.js
 * @description Handles inbound WhatsApp messages from Twilio.
 *
 * Flow:
 *   Customer replies on WhatsApp
 *     → Twilio POSTs to POST /api/webhooks/whatsapp
 *     → We extract the sender's phone number and message body
 *     → Look up the most recent active transaction for that phone number
 *     → Append message to ConversationMessage as 'inbound'
 *     → Trigger the ReAct agent turn
 *     → Agent responds → send_whatsapp_message tool fires → Twilio sends reply
 *
 * Twilio sends form-encoded POST bodies (application/x-www-form-urlencoded).
 * Express urlencoded() middleware must be active (it is in index.js).
 *
 * Required env vars:
 *   TWILIO_AUTH_TOKEN   — used to validate webhook signatures
 */

const twilio           = require('twilio');
const TransactionRecord = require('../models/TransactionRecord');
const ConversationMessage = require('../models/ConversationMessage');
const { runAgentTurn } = require('../services/agentCore');
const socket           = require('../config/socket');

// States where the agent should still respond to inbound messages
const ACTIVE_STATES = new Set([
  'OUTREACH_INITIATED',
  'MANDATE_PENDING_AUTH',
  'DISCOUNT_GATED_LINK',
  'SILENT_RETRY_SCHEDULED',
  'FAILED_PAYMENT_INGESTED',
]);

/**
 * Validates the Twilio webhook signature to prevent spoofed requests.
 * In dev (no authToken configured) we skip this check.
 */
function validateTwilioSignature(req) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken || authToken === 'your_twilio_auth_token') {
    return true; // dev mode — skip validation
  }

  try {
    const twilioSignature = req.headers['x-twilio-signature'];
    // Build the full URL Twilio signed — must match exactly what you configured
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host     = req.headers['x-forwarded-host']  || req.headers.host;
    const url      = protocol + '://' + host + req.originalUrl;

    return twilio.validateRequest(authToken, twilioSignature, url, req.body);
  } catch (err) {
    console.error('[TwilioWebhook] Signature validation error:', err.message);
    return false;
  }
}

/**
 * Finds the most recently active transaction for a given phone number.
 * Strips the 'whatsapp:' prefix Twilio adds to numbers.
 */
async function findActiveTransaction(rawFrom) {
  // Twilio sends 'whatsapp:+919876543210' — strip prefix
  const phone = rawFrom.replace(/^whatsapp:/i, '').trim();

  // Look for the most recent non-terminal transaction for this phone
  const txn = await TransactionRecord.findOne({
    phone,
    state: { $in: [...ACTIVE_STATES] },
  }).sort({ createdAt: -1 });

  return txn;
}

async function handleTwilioWhatsApp(req, res) {
  // Always respond quickly — Twilio will retry if we don't reply in 15s
  // We respond with empty TwiML immediately and process async
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  try {
    // Validate signature in production
    if (process.env.NODE_ENV === 'production' && !validateTwilioSignature(req)) {
      console.warn('[TwilioWebhook] Invalid signature — ignoring request');
      return;
    }

    // Twilio sends form fields: From, Body, MessageSid, etc.
    const from       = req.body.From;       // e.g. 'whatsapp:+919876543210'
    const body       = req.body.Body;       // message text from customer
    const messageSid = req.body.MessageSid; // Twilio message SID

    if (!from || !body) {
      console.warn('[TwilioWebhook] Missing From or Body in request:', req.body);
      return;
    }

    console.log('[TwilioWebhook] Inbound from:', from, '| Message:', body);

    // Find the active transaction for this phone number
    const txn = await findActiveTransaction(from);

    if (!txn) {
      console.log('[TwilioWebhook] No active transaction found for:', from);
      // Optionally send a "no active case" reply — for now just log and exit
      return;
    }

    if (!ACTIVE_STATES.has(txn.state)) {
      console.log('[TwilioWebhook] Transaction', txn._id, 'is in terminal state:', txn.state, '— ignoring reply');
      return;
    }

    console.log('[TwilioWebhook] Routing to txn:', txn._id.toString(), '| State:', txn.state);

    // Run the ReAct agent turn — this will call send_whatsapp_message which sends the reply
    await runAgentTurn(txn._id.toString(), body.trim());

  } catch (err) {
    console.error('[TwilioWebhook] Unhandled error:', err.message);
  }
}

module.exports = { handleTwilioWhatsApp };
