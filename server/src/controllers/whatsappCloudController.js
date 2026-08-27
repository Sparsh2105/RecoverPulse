'use strict';

/**
 * @file controllers/whatsappCloudController.js
 * @description Handles inbound WhatsApp messages from Meta's Cloud API.
 *
 * Two endpoints:
 *   GET  /api/webhooks/whatsapp-cloud  — webhook verification (Meta sends this once)
 *   POST /api/webhooks/whatsapp-cloud  — inbound messages from customers
 */

const TransactionRecord   = require('../models/TransactionRecord');
const { runAgentTurn }    = require('../services/agentCore');

const ACTIVE_STATES = new Set([
  'OUTREACH_INITIATED',
  'MANDATE_PENDING_AUTH',
  'DISCOUNT_GATED_LINK',
  'SILENT_RETRY_SCHEDULED',
  'FAILED_PAYMENT_INGESTED',
]);

// GET — Meta sends this to verify your webhook URL
function verifyWebhook(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'recoverpulse_verify';

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[WhatsApp Cloud] Webhook verified successfully');
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
}

// POST — inbound messages from customers
async function handleInbound(req, res) {
  // Respond immediately — Meta retries if no 200 within 20s
  res.status(200).send('OK');

  try {
    const body = req.body;

    // Meta sends a nested structure — drill down to the message
    const entry    = body?.entry?.[0];
    const changes  = entry?.changes?.[0];
    const value    = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) return; // not a message event (status update etc.)

    const msg      = messages[0];
    const from     = msg.from;           // phone number WITHOUT + e.g. "918954003032"
    const msgText  = msg.text?.body;     // message body (null for media etc.)
    const msgType  = msg.type;

    if (msgType !== 'text' || !msgText) {
      console.log('[WhatsApp Cloud] Non-text message from', from, '— ignoring');
      return;
    }

    console.log('[WhatsApp Cloud] Inbound from:', from, '| Message:', msgText);

    // Normalise phone — add + prefix to match our DB format
    const phone = '+' + from;

    // Find most recent active transaction for this phone
    const txn = await TransactionRecord.findOne({
      phone,
      state: { $in: [...ACTIVE_STATES] },
    }).sort({ createdAt: -1 });

    if (!txn) {
      console.log('[WhatsApp Cloud] No active transaction for:', phone);
      return;
    }

    console.log('[WhatsApp Cloud] Routing to txn:', txn._id.toString(), '| State:', txn.state);
    await runAgentTurn(txn._id.toString(), msgText.trim());

  } catch (err) {
    console.error('[WhatsApp Cloud] Error:', err.message);
  }
}

module.exports = { verifyWebhook, handleInbound };
