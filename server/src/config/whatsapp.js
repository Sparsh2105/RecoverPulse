'use strict';

/**
 * @file config/whatsapp.js
 * @description WhatsApp Cloud API (Meta) client.
 *
 * Uses Meta's free WhatsApp Cloud API — no ContentSid restriction,
 * works on free tier, no trial limitations.
 *
 * Setup:
 *   1. Go to https://developers.facebook.com/apps/
 *   2. Create an app → Add WhatsApp product
 *   3. From WhatsApp > API Setup:
 *      - Copy "Temporary access token" → WHATSAPP_TOKEN
 *      - Copy "Phone number ID"        → WHATSAPP_PHONE_ID
 *   4. Add your phone number as a test recipient
 *   5. For webhooks: set Verify Token = any string → WHATSAPP_VERIFY_TOKEN
 *
 * Free tier allows: 1000 conversations/month, unlimited template messages,
 * free-form messages within 24h customer service window.
 */

const WHATSAPP_API_URL = 'https://graph.facebook.com/v19.0';

function isWhatsAppConfigured() {
  return (
    process.env.WHATSAPP_TOKEN &&
    process.env.WHATSAPP_TOKEN !== 'your_whatsapp_token' &&
    process.env.WHATSAPP_PHONE_ID &&
    process.env.WHATSAPP_PHONE_ID !== 'your_phone_number_id'
  );
}

/**
 * Sends a WhatsApp text message via Meta Cloud API.
 * @param {string} to      - Recipient phone in E.164 format (+919876543210)
 * @param {string} message - Message text (up to 4096 chars)
 * @returns {Promise<{ messageId: string }>}
 */
async function sendWhatsAppMessage(to, message) {
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const token   = process.env.WHATSAPP_TOKEN;

  // Strip + prefix — Meta API expects numbers without +
  const recipient = to.replace(/^\+/, '');

  const response = await fetch(`${WHATSAPP_API_URL}/${phoneId}/messages`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to:                recipient,
      type:              'text',
      text:              { body: message, preview_url: false },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    const errMsg = data?.error?.message || JSON.stringify(data);
    throw new Error('WhatsApp API error: ' + errMsg);
  }

  return { messageId: data.messages?.[0]?.id };
}

module.exports = { sendWhatsAppMessage, isWhatsAppConfigured, WHATSAPP_API_URL };
