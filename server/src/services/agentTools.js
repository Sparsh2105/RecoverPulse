'use strict';

/**
 * @file services/agentTools.js
 * @description Tool definitions (Groq/OpenAI function-calling format) and their stub executors.
 *
 * Each tool has two parts:
 *   1. A schema — the JSON description Groq uses to decide WHEN and HOW to call the tool.
 *   2. An executor — the async function that runs when Groq chooses that tool.
 *
 * Executors marked "Day 6" or "Day 7" are stubs that log and return simulated data.
 * They will be replaced with real API calls on those days without changing this file's interface.
 */

const TransactionRecord   = require('../models/TransactionRecord');
const ConversationMessage = require('../models/ConversationMessage');
const { getNextState }    = require('./stateMachine');
const { scheduleRetry }   = require('./retryScheduler');
const razorpay            = require('../config/razorpay');
const { sendWhatsAppMessage, isWhatsAppConfigured } = require('../config/whatsapp');
// Twilio kept as fallback — will be used if WhatsApp Cloud API not configured
const { client: twilioClient, FROM_NUMBER, isTwilioConfigured } = require('../config/twilio');

// ---------------------------------------------------------------------------
// Tool schemas (sent to Groq on every agent call)
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
          message: {
            type: 'string',
            description: 'The message text to send. Friendly, empathetic Hinglish tone.',
          },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_payment_link',
      description: 'Generates a Razorpay payment link for the full outstanding amount and shares it with the customer. Use when customer is ready to pay immediately.',
      parameters: {
        type: 'object',
        properties: {
          amount: {
            type: 'number',
            description: 'Amount in INR to charge. Must match the originalAmount on the transaction.',
          },
          description: {
            type: 'string',
            description: 'Short description for the payment link (e.g. "Subscription renewal - June").',
          },
        },
        required: ['amount', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_upi_mandate',
      description: 'Creates a UPI AutoPay mandate (recurring payment) with a future start date. Use when customer says they will pay on a specific date (salary date, etc). Extract the date from their message.',
      parameters: {
        type: 'object',
        properties: {
          startDate: {
            type: 'string',
            description: 'ISO 8601 date string for when the mandate should start charging (e.g. "2024-02-01").',
          },
          amount: {
            type: 'number',
            description: 'Amount in INR for the mandate.',
          },
          reason: {
            type: 'string',
            description: 'Brief reason extracted from customer message (e.g. "salary arrives 1st of month").',
          },
        },
        required: ['startDate', 'amount', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_settlement_discount',
      description: 'Applies a settlement discount to reduce the amount owed. ONLY use when customer explicitly says they cannot pay the full amount. Discount must be between 5% and 10% — never more.',
      parameters: {
        type: 'object',
        properties: {
          discountPercent: {
            type: 'number',
            description: 'Discount percentage to apply. Must be between 5 and 10 inclusive.',
          },
          reason: {
            type: 'string',
            description: 'Reason for the discount (e.g. "customer financial hardship").',
          },
        },
        required: ['discountPercent', 'reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'schedule_retry',
      description: 'Schedules a silent automatic retry for the payment. Use ONLY for infra/technical errors where the customer is not at fault (bank server down, gateway timeout, etc).',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Technical reason for the retry.',
          },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description: 'Escalates this transaction to a human agent and stops all further automated outreach. Use when customer disputes the charge, uses legal/threatening language, requests cancellation, or the situation is too complex.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Specific reason for escalation (e.g. "customer_dispute", "legal_threat", "opt_out_requested").',
          },
        },
        required: ['reason'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

/**
 * Executes a tool chosen by the LLM and returns a plain-text observation.
 *
 * @param {string} toolName - The function name the LLM called.
 * @param {object} toolArgs - Parsed arguments from the LLM.
 * @param {object} transaction - The Mongoose TransactionRecord document.
 * @returns {Promise<{ observation: string, stateChanged: boolean }>}
 */
async function executeTool(toolName, toolArgs, transaction) {
  switch (toolName) {
    case 'send_whatsapp_message': {
      // Build the final message — append payment link if one exists
      let body = toolArgs.message;
      if (transaction.activePaymentLink) {
        const linkLine = '\n\nPayment link: ' + transaction.activePaymentLink;
        body = (body + linkLine).slice(0, 1500);
      }

      // Save to ConversationMessage regardless of channel availability
      const msgRecord = await ConversationMessage.create({
        transactionId: transaction._id,
        direction:     'outbound',
        channel:       'whatsapp',
        body,
        deliveryStatus: 'queued',
      });

      // Increment outreach count — compliance cop checks this cap
      transaction.outreachCount   = (transaction.outreachCount || 0) + 1;
      transaction.lastContactedAt = new Date();
      await transaction.save();

      // ── Try WhatsApp Cloud API (Meta) first — no ContentSid restriction ──
      if (isWhatsAppConfigured()) {
        try {
          const { messageId } = await sendWhatsAppMessage(transaction.phone, body);
          await ConversationMessage.findByIdAndUpdate(msgRecord._id, {
            deliveryStatus:    'sent',
            externalMessageId: messageId,
          });
          console.log('[Tool] send_whatsapp_message -> WhatsApp Cloud API | MsgId:', messageId, '| To:', transaction.phone);
          return {
            observation: 'WhatsApp message sent via Meta Cloud API to ' + transaction.phone + ' (ID: ' + messageId + ')',
            stateChanged: false,
          };
        } catch (err) {
          await ConversationMessage.findByIdAndUpdate(msgRecord._id, { deliveryStatus: 'failed' });
          console.error('[Tool] WhatsApp Cloud API error:', err.message);
          return {
            observation: 'WhatsApp send failed (' + err.message + ') — message saved to conversation log only.',
            stateChanged: false,
          };
        }
      }

      // ── Fallback: Twilio ──
      if (isTwilioConfigured()) {
        try {
          const twilioMsg = await twilioClient.messages.create({
            from: FROM_NUMBER,
            to:   'whatsapp:' + transaction.phone,
            body,
          });
          await ConversationMessage.findByIdAndUpdate(msgRecord._id, {
            deliveryStatus:    'sent',
            externalMessageId: twilioMsg.sid,
          });
          console.log('[Tool] send_whatsapp_message -> Twilio SID:', twilioMsg.sid, '| To:', transaction.phone);
          return {
            observation: 'WhatsApp message sent via Twilio to ' + transaction.phone + ' (SID: ' + twilioMsg.sid + ')',
            stateChanged: false,
          };
        } catch (err) {
          await ConversationMessage.findByIdAndUpdate(msgRecord._id, { deliveryStatus: 'failed' });
          console.error('[Tool] send_whatsapp_message Twilio error:', err.message);
          return {
            observation: 'WhatsApp send failed (' + err.message + ') — message saved to conversation log only.',
            stateChanged: false,
          };
        }
      }

      // ── Simulation mode — neither configured ──
      console.log('[Tool] send_whatsapp_message [SIMULATED] ->', body);
      return {
        observation: '[SIMULATED] WhatsApp message queued for delivery to ' + transaction.phone + '. Configure WHATSAPP_TOKEN + WHATSAPP_PHONE_ID to send for real.',
        stateChanged: false,
      };
    }

    case 'generate_payment_link': {
      const link = await razorpay.paymentLink.create({
        amount: Math.round(toolArgs.amount * 100), // amount in paise
        currency: transaction.currency || 'INR',
        accept_partial: false,
        description: toolArgs.description || 'Payment Recovery',
        reference_id: transaction._id.toString(), // To catch in webhook
        customer: {
          name: transaction.customerName,
          contact: transaction.phone,
          email: transaction.email || undefined,
        },
        notify: { sms: false, email: false }, // We handle our own WhatsApp notifications
      });

      transaction.activePaymentLink = link.short_url;
      await transaction.save();
      console.log('[Tool] generate_payment_link -> real link:', link.short_url);
      return {
        observation: 'Payment link generated: ' + link.short_url,
        stateChanged: false,
      };
    }

    case 'generate_upi_mandate': {
      const plan = await razorpay.plans.create({
        period: 'monthly',
        interval: 1,
        item: {
          name: 'Mandate - ' + transaction.customerName,
          amount: Math.round(toolArgs.amount * 100),
          currency: transaction.currency || 'INR',
        }
      });
      
      let startAt = Math.floor(new Date(toolArgs.startDate).getTime() / 1000);
      const tomorrow = Math.floor(Date.now() / 1000) + 86400;
      if (isNaN(startAt) || startAt < tomorrow) {
        startAt = tomorrow; // Enforce minimum +24h start date for Razorpay subscriptions
      }

      const sub = await razorpay.subscriptions.create({
        plan_id: plan.id,
        total_count: 12,
        start_at: startAt,
        customer_notify: 0,
        notes: {
          transactionId: transaction._id.toString()
        }
      });

      transaction.mandateId = sub.id;
      transaction.promisedDate = new Date(startAt * 1000);
      transaction.activePaymentLink = sub.short_url;
      const fromState = transaction.state;
      transaction.state = getNextState(transaction.state, 'MANDATE_CREATED');
      await transaction.save();

      console.log('[Tool] generate_upi_mandate -> mandate:', sub.id, 'start:', transaction.promisedDate);
      return {
        observation: 'UPI mandate created (' + sub.id + ') starting ' + transaction.promisedDate.toISOString().split('T')[0] + '. Link: ' + sub.short_url,
        stateChanged: true,
        fromState,
        toState: transaction.state,
      };
    }

    case 'apply_settlement_discount': {
      const pct = Math.min(10, Math.max(5, toolArgs.discountPercent)); // enforce 5–10% hard cap
      const discountedAmount = Math.floor(transaction.originalAmount * (1 - pct / 100));

      const link = await razorpay.paymentLink.create({
        amount: discountedAmount * 100, // paise
        currency: transaction.currency || 'INR',
        accept_partial: false,
        description: 'Settlement Offer - ' + pct + '% off',
        reference_id: transaction._id.toString(),
        customer: {
          name: transaction.customerName,
          contact: transaction.phone,
          email: transaction.email || undefined,
        },
        notify: { sms: false, email: false },
      });

      transaction.settlementDiscountApplied = pct;
      transaction.activePaymentLink = link.short_url;
      const fromState = transaction.state;
      transaction.state = getNextState(transaction.state, 'DISCOUNT_APPLIED');
      await transaction.save();
      
      console.log('[Tool] apply_settlement_discount -> ' + pct + '% -> Rs.' + discountedAmount, link.short_url);
      return {
        observation: pct + '% discount applied. Discounted amount: Rs.' + discountedAmount + '. Link: ' + link.short_url,
        stateChanged: true,
        fromState,
        toState: transaction.state,
      };
    }

    case 'schedule_retry': {
      await scheduleRetry(transaction, (transaction.retryCount || 0) + 1);
      console.log('[Tool] schedule_retry -> attempt', transaction.retryCount);
      return {
        observation: 'Retry scheduled. Attempt ' + (transaction.retryCount) + ' of ' + transaction.maxRetries,
        stateChanged: true,
        fromState: 'FAILED_PAYMENT_INGESTED',
        toState: 'SILENT_RETRY_SCHEDULED',
      };
    }

    case 'escalate_to_human': {
      const fromState = transaction.state;
      // Move to a terminal stopping state before escalating
      if (transaction.state === 'OUTREACH_INITIATED') {
        transaction.state = getNextState(transaction.state, 'STOPPING_RULE_HIT');
      }
      transaction.state = getNextState(transaction.state, 'ESCALATED');
      transaction.escalationReason = toolArgs.reason;
      await transaction.save();
      console.log('[Tool] escalate_to_human -> reason:', toolArgs.reason);
      return {
        observation: 'Transaction escalated to human agent. Reason: ' + toolArgs.reason + '. All automated outreach halted.',
        stateChanged: true,
        fromState,
        toState: transaction.state,
      };
    }

    default:
      return {
        observation: 'Unknown tool: ' + toolName,
        stateChanged: false,
      };
  }
}

module.exports = { TOOL_SCHEMAS, executeTool };

