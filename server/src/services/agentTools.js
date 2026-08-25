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
      // TODO Day 7: Replace with real Twilio WhatsApp API call.
      await ConversationMessage.create({
        transactionId: transaction._id,
        direction: 'outbound',
        channel: 'whatsapp',
        body: toolArgs.message,
        deliveryStatus: 'queued',
      });
      console.log('[Tool] send_whatsapp_message ->', toolArgs.message);
      return {
        observation: 'WhatsApp message queued for delivery to ' + transaction.phone,
        stateChanged: false,
      };
    }

    case 'generate_payment_link': {
      // TODO Day 6: Replace with real Razorpay Payment Links API call.
      const fakeLink = 'https://rzp.io/l/stub-' + transaction._id.toString().slice(-6);
      transaction.activePaymentLink = fakeLink;
      await transaction.save();
      console.log('[Tool] generate_payment_link -> stub link:', fakeLink);
      return {
        observation: 'Payment link generated: ' + fakeLink,
        stateChanged: false,
      };
    }

    case 'generate_upi_mandate': {
      // TODO Day 6: Replace with real Razorpay Subscriptions API call.
      const fakeMandateId = 'sub_stub_' + Date.now();
      transaction.mandateId = fakeMandateId;
      transaction.promisedDate = new Date(toolArgs.startDate);
      const fromState = transaction.state;
      transaction.state = getNextState(transaction.state, 'MANDATE_CREATED');
      await transaction.save();
      console.log('[Tool] generate_upi_mandate -> stub mandate:', fakeMandateId, 'start:', toolArgs.startDate);
      return {
        observation: 'UPI mandate created (' + fakeMandateId + ') starting ' + toolArgs.startDate + '. Customer will be auto-charged.',
        stateChanged: true,
        fromState,
        toState: transaction.state,
      };
    }

    case 'apply_settlement_discount': {
      // TODO Day 6: Replace with real Razorpay discounted payment link.
      const pct = Math.min(10, Math.max(5, toolArgs.discountPercent)); // enforce 5–10% hard cap
      const discountedAmount = transaction.originalAmount * (1 - pct / 100);
      transaction.settlementDiscountApplied = pct;
      const fakeLink = 'https://rzp.io/l/disc-' + transaction._id.toString().slice(-6);
      transaction.activePaymentLink = fakeLink;
      const fromState = transaction.state;
      transaction.state = getNextState(transaction.state, 'DISCOUNT_APPLIED');
      await transaction.save();
      console.log('[Tool] apply_settlement_discount -> ' + pct + '% -> Rs.' + discountedAmount);
      return {
        observation: pct + '% discount applied. Discounted amount: Rs.' + discountedAmount + '. Link: ' + fakeLink,
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

