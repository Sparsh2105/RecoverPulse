'use strict';

/**
 * @file services/agentCore.js
 * @description The ReAct (Reason + Act) agent loop — Gemini 2.0 Flash.
 *
 * Loop per turn:
 *   1. Load context  — fetch TransactionRecord + conversation history
 *   2. Pre-check     — fast regex screen for dispute/opt-out keywords
 *   3. THOUGHT       — Gemini LLM call: given context, choose a tool
 *   4. ACTION        — execute the chosen tool
 *   5. OBSERVATION   — capture tool result
 *   6. Persist+Emit  — write AgentAuditLog, emit txn:updated via Socket.IO
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const TransactionRecord   = require('../models/TransactionRecord');
const ConversationMessage = require('../models/ConversationMessage');
const AgentAuditLog       = require('../models/AgentAuditLog');
const socket              = require('../config/socket');
const { TOOL_SCHEMAS, executeTool } = require('./agentTools');
const { reviewAction } = require('./complianceCop');

const genAI = new GoogleGenerativeAI(process.env.GROQ_API_KEY);
const MODEL = 'gemini-2.5-flash';

// Regex pre-filter — fast check before touching the LLM.
// If any of these match, immediately escalate without an LLM call.
const DISPUTE_KEYWORDS = /\b(cancel|sue|legal|lawyer|court|chargeback|fraud|harassment|stop messaging|stop contacting|opt.?out|remove me|do not contact|refund dispute)\b/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function logStep(transactionId, fields) {
  return AgentAuditLog.create({ transactionId, ...fields });
}

function buildSystemPrompt(txn, isInitialTrigger) {
  const lines = [
    'You are RecoverPulse AI, an empathetic payment recovery agent for an Indian SaaS company.',
    'Your goal is to help customers resolve their failed payment in a way that works for both them and the business.',
    '',
    'TRANSACTION CONTEXT:',
    '  Customer: ' + txn.customerName,
    '  Phone: ' + txn.phone,
    '  Failed Amount: Rs.' + txn.originalAmount + ' ' + txn.currency,
    '  Failure Reason: ' + txn.errorCode + ' (' + (txn.errorCategory || 'unknown') + ')',
    '  Current State: ' + txn.state,
    '  Retry Count: ' + txn.retryCount + '/' + txn.maxRetries,
    '',
  ];

  if (isInitialTrigger) {
    const isHardDecline = ['CARD_EXPIRED', 'CARD_BLOCKED', 'INVALID_CARD', 'CARD_LOST', 'CARD_STOLEN'].includes(txn.errorCode);
    if (isHardDecline && txn.email) {
      lines.push(
        'ACTION REQUIRED: This is the FIRST contact. Payment failed due to ' + txn.errorCode + ' — this is a card credential issue.',
        'Call send_email FIRST to send an HTML payment recovery email to ' + txn.email + '.',
        'Subject should be clear e.g. "Action Required: Update your card for ₹' + txn.originalAmount + ' payment".',
        'After sending email, the system will auto-send a WhatsApp notification too.',
        '',
      );
    } else {
      lines.push(
        'ACTION REQUIRED: This is the FIRST contact with the customer. Their payment just failed.',
        'You must call send_whatsapp_message to send a warm, empathetic opening message in Hinglish.',
        'Mention the failed amount (Rs.' + txn.originalAmount + ') and ask how you can help.',
        'Do NOT call generate_payment_link or generate_upi_mandate yet — wait for their reply.',
        '',
      );
    }
  } else {
    lines.push(
      'DECISION RULES (follow strictly):',
      '  - If payment failed due to infra/bank error → use schedule_retry first.',
      '  - If customer mentions a future date for payment → use generate_upi_mandate with that date.',
      '  - If customer is ready to pay now → use generate_payment_link.',
      '  - If customer says they cannot afford full amount → use apply_settlement_discount (5-10% only).',
      '  - If error is CARD_EXPIRED, CARD_BLOCKED, INVALID_CARD, CARD_LOST → use send_email to send credential-update reminder (if email exists), then send_whatsapp_message.',
      '  - If customer disputes charge, threatens legal action, or asks to stop contact → use escalate_to_human immediately.',
      '  - Always send a WhatsApp message to the customer after taking any action.',
      '',
    );
  }

  lines.push(
    'TONE: Friendly, empathetic, Hinglish (mix Hindi and English naturally). Never threatening. Keep messages under 300 chars.',
    'IMPORTANT: You MUST call exactly one tool. Do not respond with plain text.',
  );

  return lines.join('\n');
}

function buildConversationMessages(history, inboundMessage) {
  const msgs = [];
  for (const msg of history) {
    msgs.push({
      role: msg.direction === 'inbound' ? 'user' : 'assistant',
      content: msg.body,
    });
  }
  msgs.push({ role: 'user', content: inboundMessage });
  return msgs;
}

// ---------------------------------------------------------------------------
// Main export: run one full ReAct turn
// ---------------------------------------------------------------------------

/**
 * Runs one ReAct agent turn for a transaction.
 *
 * @param {string} transactionId - MongoDB ObjectId string.
 * @param {string} inboundMessage - Message from the customer (or 'PAYMENT_FAILED' for initial trigger).
 * @returns {Promise<{ toolName: string, observation: string, auditLogIds: string[] }>}
 */
async function runAgentTurn(transactionId, inboundMessage) {
  const auditLogIds = [];

  // Step 1: Load context
  const txn = await TransactionRecord.findById(transactionId);
  if (!txn) throw new Error('Transaction not found: ' + transactionId);

  const history = await ConversationMessage
    .find({ transactionId })
    .sort({ createdAt: 1 })
    .lean();

  // Save the inbound message to conversation history
  if (inboundMessage && inboundMessage !== 'PAYMENT_FAILED') {
    await ConversationMessage.create({
      transactionId,
      direction: 'inbound',
      channel: 'whatsapp',
      body: inboundMessage,
      deliveryStatus: 'delivered',
    });
  }

  // Step 2: Stopping-rule pre-check (fast regex — no LLM cost)
  if (DISPUTE_KEYWORDS.test(inboundMessage)) {
    const reason = 'dispute_or_opt_out_detected';
    console.log('[Agent] Stopping rule triggered for txn', transactionId, '- escalating immediately');

    const log = await logStep(transactionId, {
      step: 'THOUGHT',
      thoughtProcess: 'Stopping rule triggered: customer message contains dispute/opt-out keyword. Escalating without LLM call.',
    });
    auditLogIds.push(log._id.toString());

    const fromState = txn.state;
    if (txn.state === 'OUTREACH_INITIATED') txn.state = 'STOPPING_RULE_TRIGGERED';
    txn.state = 'ESCALATED_TO_HUMAN';
    txn.escalationReason = reason;
    await txn.save();

    const obsLog = await logStep(transactionId, {
      step: 'OBSERVATION',
      toolName: 'escalate_to_human',
      toolInput: { reason },
      toolOutput: { observation: 'Escalated due to dispute keyword detection.' },
      fromState,
      toState: txn.state,
    });
    auditLogIds.push(obsLog._id.toString());

    const io = socket.getIO();
    if (io) io.emit('txn:updated', txn.toObject());

    return { toolName: 'escalate_to_human', observation: 'Escalated (stopping rule).', auditLogIds };
  }

  // Step 3: THOUGHT — call Gemini
  console.log('[Agent] Calling Gemini for txn', transactionId, '| message:', inboundMessage);

  const isInitialTrigger = inboundMessage === 'PAYMENT_FAILED';

  // Build conversation history for Gemini format
  const geminiContents = [];
  if (!isInitialTrigger) {
    for (const msg of history) {
      geminiContents.push({
        role:  msg.direction === 'inbound' ? 'user' : 'model',
        parts: [{ text: msg.body }],
      });
    }
    geminiContents.push({ role: 'user', parts: [{ text: inboundMessage }] });
  } else {
    geminiContents.push({ role: 'user', parts: [{ text: 'Payment failed. Start outreach.' }] });
  }

  let geminiResponse;
  try {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const model = genAI.getGenerativeModel({
          model: MODEL,
          systemInstruction: buildSystemPrompt(txn, isInitialTrigger),
          tools: [{
            functionDeclarations: TOOL_SCHEMAS.map(t => ({
              name:        t.function.name,
              description: t.function.description,
              parameters:  t.function.parameters,
            })),
          }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
        });
        geminiResponse = await model.generateContent({ contents: geminiContents });
        break;
      } catch (err) {
        lastError = err;
        const isRateLimit = err.status === 429 || String(err.message).includes('429') || String(err.message).includes('quota');
        if (isRateLimit && attempt < 2) {
          const delay = (attempt + 1) * 8000;
          console.warn('[Agent] Gemini rate limit, retrying in', delay + 'ms');
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw err;
        }
      }
    }
    if (!geminiResponse) throw lastError;
  } catch (err) {
    console.error('[Agent] Gemini API error for txn', transactionId, ':', err.message);
    await logStep(transactionId, {
      step: 'OBSERVATION', toolName: 'gemini_api_error',
      toolInput: { inboundMessage }, toolOutput: { error: err.message }, error: err.message,
    });
    const io = socket.getIO();
    if (io) io.emit('audit:created', { transactionId, toolName: 'gemini_api_error', observation: 'Gemini API unavailable: ' + err.message + '. Agent turn skipped.' });
    return { toolName: 'gemini_api_error', observation: 'Gemini API error: ' + err.message, auditLogIds };
  }

  // Parse Gemini response — getGenerativeModel returns response.response
  const resp      = geminiResponse.response;
  const candidate = resp.candidates?.[0];
  const parts     = candidate?.content?.parts || [];
  const thoughtText = parts.find(p => p.text)?.text || 'Gemini selected a tool.';
  const funcPart    = parts.find(p => p.functionCall);

  // Log THOUGHT step
  const thoughtLog = await logStep(transactionId, {
    step: 'THOUGHT',
    thoughtProcess: thoughtText,
  });
  auditLogIds.push(thoughtLog._id.toString());

  // Step 4: ACTION — parse function call
  let toolName, toolArgs;
  if (!funcPart) {
    console.log('[Agent] Gemini returned text (no function call) — routing to send_whatsapp_message');
    toolName = 'send_whatsapp_message';
    toolArgs = { message: thoughtText || 'Namaskar! Aapka payment issue resolve karne mein hum madad karna chahte hain.' };
  } else {
    toolName = funcPart.functionCall.name;
    toolArgs  = funcPart.functionCall.args || {};
  }

  console.log('[Agent] LLM chose tool:', toolName, '| args:', JSON.stringify(toolArgs));

  const actionLog = await logStep(transactionId, {
    step: 'ACTION',
    toolName,
    toolInput: toolArgs,
  });
  auditLogIds.push(actionLog._id.toString());

  // Step 5: Compliance Cop — second independent Groq call reviews the action
  const compliance = await reviewAction(toolName, toolArgs, txn);

  const complianceLog = await logStep(transactionId, {
    step: 'COMPLIANCE_CHECK',
    toolName,
    toolInput: toolArgs,
    complianceVerified: compliance.approved,
    complianceReason: compliance.reason || null,
  });
  auditLogIds.push(complianceLog._id.toString());

  if (!compliance.approved) {
    console.log('[Agent] Compliance rejected action', toolName, '-', compliance.reason);

    // Contact window violation — save message as queued, don't escalate
    if (compliance.queued) {
      console.log('[Agent] Contact window violation — saving message as queued, NOT escalating');

      // Save the message as queued in conversation history so it's not lost
      if (toolName === 'send_whatsapp_message' && toolArgs.message) {
        const { ConversationMessage } = require('../models/ConversationMessage');
        await require('../models/ConversationMessage').create({
          transactionId,
          direction:      'outbound',
          channel:        'whatsapp',
          body:           toolArgs.message,
          deliveryStatus: 'queued',
        });
      }

      const queueLog = await logStep(transactionId, {
        step:              'COMPLIANCE_CHECK',
        toolName,
        toolInput:         toolArgs,
        complianceVerified: false,
        complianceReason:  compliance.reason,
      });
      auditLogIds.push(queueLog._id.toString());

      return {
        toolName,
        observation: 'Message queued — will send when contact window opens (8AM-7PM IST). ' + compliance.reason,
        auditLogIds,
        complianceBlocked: false,  // not a hard block — transaction stays active
      };
    }

    // Hard block (outreach cap, discount out of bounds, etc.) — escalate
    const fromState = txn.state;
    if (txn.state === 'OUTREACH_INITIATED') txn.state = 'STOPPING_RULE_TRIGGERED';
    txn.state = 'ESCALATED_TO_HUMAN';
    txn.escalationReason = 'compliance_violation: ' + compliance.reason;
    await txn.save();

    const escalationLog = await logStep(transactionId, {
      step: 'OBSERVATION',
      toolName: 'escalate_to_human',
      toolInput: { reason: txn.escalationReason },
      toolOutput: { observation: 'Action blocked by compliance cop. Escalated to human.' },
      fromState,
      toState: txn.state,
    });
    auditLogIds.push(escalationLog._id.toString());

    const io = socket.getIO();
    if (io) io.emit('txn:updated', txn.toObject());

    return {
      toolName: 'escalate_to_human',
      observation: 'Compliance rejected: ' + compliance.reason,
      auditLogIds,
      complianceBlocked: true,
    };
  }

  // Step 6: OBSERVATION — execute the tool
  const result = await executeTool(toolName, toolArgs, txn);

  const obsLog = await logStep(transactionId, {
    step: 'OBSERVATION',
    toolName,
    toolInput: toolArgs,
    toolOutput: { observation: result.observation },
    fromState: result.fromState || null,
    toState: result.toState || null,
  });
  auditLogIds.push(obsLog._id.toString());

  // Step 7: Emit real-time update to dashboard
  const updatedTxn = await TransactionRecord.findById(transactionId).lean();
  const io = socket.getIO();
  if (io) io.emit('txn:updated', updatedTxn);
  if (io) io.emit('audit:created', { transactionId, toolName, observation: result.observation });

  console.log('[Agent] Turn complete. Tool:', toolName, '| Observation:', result.observation);

  // Step 8: Auto follow-up — if the tool generated a payment link/mandate,
  // directly send a WhatsApp message with the link without another LLM call.
  const LINK_TOOLS = new Set(['generate_payment_link', 'generate_upi_mandate', 'apply_settlement_discount']);
  if (LINK_TOOLS.has(toolName) && updatedTxn.activePaymentLink) {
    console.log('[Agent] Auto follow-up: sending WhatsApp with payment link...');
    try {
      const freshTxn = await TransactionRecord.findById(transactionId);
      const linkMsg = toolName === 'generate_upi_mandate'
        ? 'Link aa gaya! Mandate authorize karein: ' + updatedTxn.activePaymentLink +
          '\n\nYeh ' + (updatedTxn.promisedDate
            ? new Date(updatedTxn.promisedDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
            : 'scheduled date') + ' ko auto-debit ho jaayega. Koi dikkat? Hum yahan hain! 😊'
        : toolName === 'apply_settlement_discount'
          ? 'Special offer! Discounted payment link: ' + updatedTxn.activePaymentLink +
            '\n\nAbhi pay karein — offer limited time ke liye hai! 🙏'
          : 'Payment link ready hai: ' + updatedTxn.activePaymentLink +
            '\n\nAbhi secure payment karein! 🙏';

      await executeTool('send_whatsapp_message', { message: linkMsg }, freshTxn);
      console.log('[Agent] Auto follow-up WhatsApp sent with link');
    } catch (err) {
      console.error('[Agent] Auto follow-up failed:', err.message);
    }
  }

  // Auto follow-up after send_email — notify on WhatsApp to check inbox
  if (toolName === 'send_email' && updatedTxn.email) {
    try {
      const freshTxn = await TransactionRecord.findById(transactionId);
      const notifyMsg = 'Aapke email (' + updatedTxn.email.split('@')[0] + '@...) pe payment link bhej diya hai. ' +
        'Email check karein aur apna card update karein. Koi help? Hum yahan hain! 😊';
      await executeTool('send_whatsapp_message', { message: notifyMsg }, freshTxn);
      console.log('[Agent] Auto follow-up WhatsApp sent after email');
    } catch (err) {
      console.error('[Agent] Email follow-up WhatsApp failed:', err.message);
    }
  }

  return {
    toolName,
    observation: result.observation,
    auditLogIds,
    paymentLink: updatedTxn.activePaymentLink || null,
    mandateId:   updatedTxn.mandateId         || null,
  };
}

module.exports = { runAgentTurn };

