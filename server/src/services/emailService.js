'use strict';

/**
 * @file services/emailService.js
 * @description Sends payment recovery emails via Resend.
 *
 * Used for hard-decline scenarios (CARD_EXPIRED, CARD_BLOCKED, INVALID_CARD)
 * where the customer needs to update their payment credentials.
 * WhatsApp outreach handles soft-declines; email handles hard-declines.
 */

const { resendClient, FROM_EMAIL, isResendConfigured } = require('../config/resend');
const ConversationMessage = require('../models/ConversationMessage');

/**
 * Builds the HTML body for a payment recovery email.
 */
function buildEmailHTML(txn, paymentLink) {
  const amount = txn.originalAmount.toLocaleString('en-IN');
  const errorLabel = {
    CARD_EXPIRED:    'your card has expired',
    CARD_BLOCKED:    'your card has been blocked',
    CARD_LOST:       'your card was reported lost',
    CARD_STOLEN:     'your card was reported stolen',
    INVALID_CARD:    'your card details are invalid',
    FRAUD_SUSPECTED: 'a security concern was flagged',
  }[txn.errorCode] || 'your payment method needs to be updated';

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
    .container { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .header { background: linear-gradient(135deg, #ff3b5c, #ff8c42); padding: 32px 40px; color: white; }
    .header h1 { margin: 0; font-size: 22px; font-weight: 700; }
    .header p { margin: 6px 0 0; opacity: 0.9; font-size: 14px; }
    .body { padding: 32px 40px; }
    .body p { color: #444; line-height: 1.6; margin: 0 0 16px; }
    .amount-box { background: #fff5f5; border: 1px solid #ffd0d8; border-radius: 8px; padding: 16px 20px; margin: 20px 0; }
    .amount-box .label { font-size: 12px; color: #999; text-transform: uppercase; letter-spacing: 0.5px; }
    .amount-box .value { font-size: 28px; font-weight: 700; color: #ff3b5c; margin-top: 4px; }
    .cta { display: block; background: linear-gradient(135deg, #ff3b5c, #ff8c42); color: white !important; text-decoration: none; text-align: center; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 16px; margin: 24px 0; }
    .footer { background: #f9f9f9; padding: 20px 40px; border-top: 1px solid #eee; }
    .footer p { font-size: 12px; color: #999; margin: 0; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Action Required — Payment Failed</h1>
      <p>RecoverPulse AI · Payment Recovery</p>
    </div>
    <div class="body">
      <p>Hi ${txn.customerName},</p>
      <p>We weren't able to process your recent payment because ${errorLabel}. No worries — this happens, and we can get it sorted quickly.</p>

      <div class="amount-box">
        <div class="label">Outstanding Amount</div>
        <div class="value">₹${amount}</div>
      </div>

      <p>To complete your payment, please use the secure link below. You can update your payment method directly on the payment page.</p>

      ${paymentLink ? `<a href="${paymentLink}" class="cta">Complete Payment →</a>` : ''}

      <p>The link is valid for 24 hours. If you have any questions or need help, simply reply to this email.</p>

      <p>Thank you for your patience,<br><strong>RecoverPulse AI Team</strong></p>
    </div>
    <div class="footer">
      <p>This is an automated payment reminder. To opt out of future reminders, reply with "STOP".<br>
      RecoverPulse AI · Autonomous Revenue Recovery System</p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Sends a payment recovery email for a hard-decline transaction.
 *
 * @param {object} txn       - TransactionRecord Mongoose document
 * @param {string} [subject] - Optional custom subject line
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
async function sendRecoveryEmail(txn, subject) {
  if (!txn.email) {
    return { success: false, error: 'No email address on transaction' };
  }

  const emailSubject = subject ||
    `Action Required: Complete your ₹${txn.originalAmount.toLocaleString('en-IN')} payment`;

  const html = buildEmailHTML(txn, txn.activePaymentLink);

  // Save to ConversationMessage
  const msgRecord = await ConversationMessage.create({
    transactionId:  txn._id,
    direction:      'outbound',
    channel:        'email',
    body:           `[Email] ${emailSubject}` + (txn.activePaymentLink ? `\n${txn.activePaymentLink}` : ''),
    deliveryStatus: 'queued',
  });

  if (!isResendConfigured()) {
    console.log('[Email] SIMULATED — Resend not configured. Subject:', emailSubject, '| To:', txn.email);
    await ConversationMessage.findByIdAndUpdate(msgRecord._id, { deliveryStatus: 'sent' });
    return { success: true, messageId: 'simulated_' + Date.now() };
  }

  try {
    const result = await resendClient.emails.send({
      from:    FROM_EMAIL,
      to:      [txn.email],
      subject: emailSubject,
      html,
    });

    await ConversationMessage.findByIdAndUpdate(msgRecord._id, {
      deliveryStatus:    'sent',
      externalMessageId: result.data?.id,
    });

    console.log('[Email] Sent via Resend | ID:', result.data?.id, '| To:', txn.email);
    return { success: true, messageId: result.data?.id };
  } catch (err) {
    await ConversationMessage.findByIdAndUpdate(msgRecord._id, { deliveryStatus: 'failed' });
    console.error('[Email] Resend error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendRecoveryEmail };
