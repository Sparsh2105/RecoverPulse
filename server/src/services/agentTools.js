'use strict';

/**
 * @file services/agentTools.js
 * @description Tool definitions + executors. All external API calls (Razorpay,
 * Twilio, Meta, Resend) are wrapped in try/catch — a single provider failure
 * logs to audit and returns a non-crashing observation instead of throwing.
 */

const TransactionRecord   = require('../models/TransactionRecord');
const ConversationMessage = require('../models/ConversationMessage');
const AgentAuditLog       = require('../models/AgentAuditLog');
const { getNextState }    = require('./stateMachine');
const { scheduleRetry }   = require('./retryScheduler');
const razorpay            = require('../config/razorpay');
const { sendWhatsAppMessage, isWhatsAppConfigured } = require('../config/whatsapp');
const { client: twilioClient, FROM_NUMBER, isTwilioConfigured } = require('../config/twilio');
const { sendRecoveryEmail } = require('./emailService');

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'send_whatsapp_message',
      description: 'Sends a WhatsApp message to the customer. Use this to initiate contact, follow up, or respond to a customer reply. Write in friendly Hinglish. Keep under 300 characters.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The message text to send. Friendly, empathetic Hinglish tone.' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_payment_link',
      description: 'Generates a Razorpay payment link for the full outstanding amount. Use when customer is ready to pay immediately.',
      parameters: {
        type: 'object',
        properties: {
          amount:      { type: 'number', description: 'Amount in INR.' },
          description: { type: 'string', description: 'Short description for the payment link.' },
        },
        required: ['amount', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_upi_mandate',
      description: 'Creates a UPI AutoPay mandate with a future start date. Use when customer says they will pay on a specific date.',
      parameters: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'ISO 8601 date string (e.g. "2024-02-01").' },
          amount:    { type: 'number', description: 'Amount in INR.' },
          reason:    { type: 'string', description: 'Reason extracted from customer message.' },
        },
        required: ['startDate', 'amount', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_settlement_discount',
      description: 'Applies a settlement discount (5–10% only). Use when customer cannot pay the full amount.',
      parameters: {
        type: 'object',
        properties: {
          discountPercent: { type: 'number', description: 'Discount percentage (5–10 inclusive).' },
          reason:          { type: 'string', description: 'Reason for the discount.' },
        },
        required: ['discountPercent', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_retry',
      description: 'Schedules a silent automatic retry. Use ONLY for infra/technical errors.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Technical reason for the retry.' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description: 'Escalates to a human agent and stops all automated outreach.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Specific reason for escalation.' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Sends a payment recovery email. Use for hard-decline errors (CARD_EXPIRED, CARD_BLOCKED, INVALID_CARD) where customer needs to update credentials.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Email subject line.' },
        },
        required: ['subject'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Helper: log a tool error to AgentAuditLog without throwing
// ---------------------------------------------------------------------------

async function logToolError(transactionId, toolName, toolArgs, errorMessage) {
  try {
    await AgentAuditLog.create({
      transactionId,
      step:      'OBSERVATION',
      toolName,
      toolInput: toolArgs,
      toolOutput: { error: errorMessage },
      error:     errorMessage,
    });
  } catch { /* audit log failure should never crash the caller */ }
}

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

async function executeTool(toolName, toolArgs, transaction) {
  switch (toolName) {

    // ── WhatsApp ─────────────────────────────────────────────────────────────
    case 'send_whatsapp_message': {
      let body = toolArgs.message;
      if (transaction.activePaymentLink) {
        body = (body + '\n\nPayment link: ' + transaction.activePaymentLink).slice(0, 1500);
      }

      const msgRecord = await ConversationMessage.create({
        transactionId:  transaction._id,
        direction:      'outbound',
        channel:        'whatsapp',
        body,
        deliveryStatus: 'queued',
      });

      transaction.outreachCount   = (transaction.outreachCount || 0) + 1;
      transaction.lastContactedAt = new Date();
      await transaction.save();

      if (isWhatsAppConfigured()) {
        try {
          const { messageId } = await sendWhatsAppMessage(transaction.phone, body);
          await ConversationMessage.findByIdAndUpdate(msgRecord._id, {
            deliveryStatus: 'sent', externalMessageId: messageId,
          });
          console.log('[Tool] send_whatsapp_message → Meta | MsgId:', messageId);
          return { observation: 'WhatsApp sent via Meta to ' + transaction.phone + ' (ID: ' + messageId + ')', stateChanged: false };
        } catch (err) {
          await ConversationMessage.findByIdAndUpdate(msgRecord._id, { deliveryStatus: 'failed' });
          console.error('[Tool] Meta WhatsApp error:', err.message);
          await logToolError(transaction._id, toolName, toolArgs, err.message);
          return { observation: 'WhatsApp send failed (' + err.message + ') — saved to log only.', stateChanged: false };
        }
      }

      if (isTwilioConfigured()) {
        try {
          const msg = await twilioClient.messages.create({ from: FROM_NUMBER, to: 'whatsapp:' + transaction.phone, body });
          await ConversationMessage.findByIdAndUpdate(msgRecord._id, {
            deliveryStatus: 'sent', externalMessageId: msg.sid,
          });
          console.log('[Tool] send_whatsapp_message → Twilio SID:', msg.sid);
          return { observation: 'WhatsApp sent via Twilio to ' + transaction.phone + ' (SID: ' + msg.sid + ')', stateChanged: false };
        } catch (err) {
          await ConversationMessage.findByIdAndUpdate(msgRecord._id, { deliveryStatus: 'failed' });
          console.error('[Tool] Twilio error:', err.message);
          await logToolError(transaction._id, toolName, toolArgs, err.message);
          return { observation: 'WhatsApp send failed (' + err.message + ') — saved to log only.', stateChanged: false };
        }
      }

      console.log('[Tool] send_whatsapp_message [SIMULATED] ->', body);
      return { observation: '[SIMULATED] WhatsApp queued for ' + transaction.phone + '.', stateChanged: false };
    }

    // ── Payment Link ──────────────────────────────────────────────────────────
    case 'generate_payment_link': {
      try {
        const link = await razorpay.paymentLink.create({
          amount:       Math.round(toolArgs.amount * 100),
          currency:     transaction.currency || 'INR',
          accept_partial: false,
          description:  toolArgs.description || 'Payment Recovery',
          reference_id: transaction._id.toString(),
          customer: {
            name:    transaction.customerName,
            contact: transaction.phone,
            email:   transaction.email || undefined,
          },
          notify: { sms: false, email: false },
        });
        transaction.activePaymentLink = link.short_url;
        await transaction.save();
        console.log('[Tool] generate_payment_link →', link.short_url);
        return { observation: 'Payment link generated: ' + link.short_url, stateChanged: false };
      } catch (err) {
        console.error('[Tool] generate_payment_link Razorpay error:', err.message);
        await logToolError(transaction._id, toolName, toolArgs, err.message);
        return { observation: 'Failed to generate payment link: ' + err.message, stateChanged: false };
      }
    }

    // ── UPI Mandate ───────────────────────────────────────────────────────────
    case 'generate_upi_mandate': {
      try {
        const plan = await razorpay.plans.create({
          period: 'monthly', interval: 1,
          item: {
            name:     'Mandate - ' + transaction.customerName,
            amount:   Math.round(toolArgs.amount * 100),
            currency: transaction.currency || 'INR',
          },
        });

        let startAt = Math.floor(new Date(toolArgs.startDate).getTime() / 1000);
        const tomorrow = Math.floor(Date.now() / 1000) + 86400;
        if (isNaN(startAt) || startAt < tomorrow) startAt = tomorrow;

        const sub = await razorpay.subscriptions.create({
          plan_id:         plan.id,
          total_count:     12,
          start_at:        startAt,
          customer_notify: 0,
          notes:           { transactionId: transaction._id.toString() },
        });

        transaction.mandateId          = sub.id;
        transaction.promisedDate       = new Date(startAt * 1000);
        transaction.activePaymentLink  = sub.short_url;
        const fromState = transaction.state;
        transaction.state = getNextState(transaction.state, 'MANDATE_CREATED');
        await transaction.save();

        console.log('[Tool] generate_upi_mandate → mandate:', sub.id, 'start:', transaction.promisedDate);
        return {
          observation: 'UPI mandate (' + sub.id + ') starting ' + transaction.promisedDate.toISOString().split('T')[0] + '. Link: ' + sub.short_url,
          stateChanged: true, fromState, toState: transaction.state,
        };
      } catch (err) {
        console.error('[Tool] generate_upi_mandate Razorpay error:', err.message);
        await logToolError(transaction._id, toolName, toolArgs, err.message);
        return { observation: 'Failed to create UPI mandate: ' + err.message, stateChanged: false };
      }
    }

    // ── Settlement Discount ───────────────────────────────────────────────────
    case 'apply_settlement_discount': {
      const pct = Math.min(10, Math.max(5, toolArgs.discountPercent));
      const discountedAmount = Math.floor(transaction.originalAmount * (1 - pct / 100));
      try {
        const link = await razorpay.paymentLink.create({
          amount:         discountedAmount * 100,
          currency:       transaction.currency || 'INR',
          accept_partial: false,
          description:    'Settlement Offer - ' + pct + '% off',
          reference_id:   transaction._id.toString(),
          customer: {
            name:    transaction.customerName,
            contact: transaction.phone,
            email:   transaction.email || undefined,
          },
          notify: { sms: false, email: false },
        });

        transaction.settlementDiscountApplied = pct;
        transaction.activePaymentLink         = link.short_url;
        const fromState = transaction.state;
        transaction.state = getNextState(transaction.state, 'DISCOUNT_APPLIED');
        await transaction.save();

        console.log('[Tool] apply_settlement_discount →', pct + '%', 'Rs.' + discountedAmount, link.short_url);
        return {
          observation: pct + '% discount. Discounted amount: Rs.' + discountedAmount + '. Link: ' + link.short_url,
          stateChanged: true, fromState, toState: transaction.state,
        };
      } catch (err) {
        console.error('[Tool] apply_settlement_discount Razorpay error:', err.message);
        await logToolError(transaction._id, toolName, toolArgs, err.message);
        return { observation: 'Failed to create discounted payment link: ' + err.message, stateChanged: false };
      }
    }

    // ── Schedule Retry ────────────────────────────────────────────────────────
    case 'schedule_retry': {
      try {
        await scheduleRetry(transaction, (transaction.retryCount || 0) + 1);
        return {
          observation: 'Retry scheduled. Attempt ' + transaction.retryCount + ' of ' + transaction.maxRetries,
          stateChanged: true, fromState: 'FAILED_PAYMENT_INGESTED', toState: 'SILENT_RETRY_SCHEDULED',
        };
      } catch (err) {
        console.error('[Tool] schedule_retry error:', err.message);
        await logToolError(transaction._id, toolName, toolArgs, err.message);
        return { observation: 'Failed to schedule retry: ' + err.message, stateChanged: false };
      }
    }

    // ── Escalate to Human ─────────────────────────────────────────────────────
    case 'escalate_to_human': {
      try {
        const fromState = transaction.state;
        if (transaction.state === 'OUTREACH_INITIATED') {
          transaction.state = getNextState(transaction.state, 'STOPPING_RULE_HIT');
        }
        transaction.state = getNextState(transaction.state, 'ESCALATED');
        transaction.escalationReason = toolArgs.reason;
        await transaction.save();
        console.log('[Tool] escalate_to_human → reason:', toolArgs.reason);
        return {
          observation: 'Escalated to human. Reason: ' + toolArgs.reason + '. Automated outreach halted.',
          stateChanged: true, fromState, toState: transaction.state,
        };
      } catch (err) {
        console.error('[Tool] escalate_to_human error:', err.message);
        await logToolError(transaction._id, toolName, toolArgs, err.message);
        return { observation: 'Escalation failed: ' + err.message, stateChanged: false };
      }
    }

    // ── Send Email ────────────────────────────────────────────────────────────
    case 'send_email': {
      if (!transaction.email) {
        return { observation: 'Cannot send email — no email address on transaction.', stateChanged: false };
      }

      // Generate payment link first if none exists
      if (!transaction.activePaymentLink) {
        try {
          const link = await razorpay.paymentLink.create({
            amount:         Math.round(transaction.originalAmount * 100),
            currency:       transaction.currency || 'INR',
            accept_partial: false,
            description:    'Payment Recovery — update card details',
            reference_id:   transaction._id.toString(),
            customer: {
              name:    transaction.customerName,
              contact: transaction.phone,
              email:   transaction.email,
            },
            notify: { sms: false, email: false },
          });
          transaction.activePaymentLink = link.short_url;
          await transaction.save();
          console.log('[Tool] send_email — generated payment link:', link.short_url);
        } catch (err) {
          console.warn('[Tool] send_email — could not generate payment link:', err.message);
          // Continue — email will send without a link button
        }
      }

      try {
        const result = await sendRecoveryEmail(transaction, toolArgs.subject);
        console.log('[Tool] send_email →', result.success ? 'sent ' + result.messageId : 'failed ' + result.error);
        if (!result.success) {
          await logToolError(transaction._id, toolName, toolArgs, result.error);
        }
        return {
          observation: result.success
            ? 'Recovery email sent to ' + transaction.email + (transaction.activePaymentLink ? ' with payment link' : '')
            : 'Email send failed: ' + result.error,
          stateChanged: false,
        };
      } catch (err) {
        console.error('[Tool] send_email unexpected error:', err.message);
        await logToolError(transaction._id, toolName, toolArgs, err.message);
        return { observation: 'Email send failed unexpectedly: ' + err.message, stateChanged: false };
      }
    }

    // ── Unknown ───────────────────────────────────────────────────────────────
    default:
      return { observation: 'Unknown tool: ' + toolName, stateChanged: false };
  }
}

module.exports = { TOOL_SCHEMAS, executeTool };
