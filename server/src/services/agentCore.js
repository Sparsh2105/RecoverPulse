'use strict';

/**
 * @file services/agentCore.js
 * @description The ReAct (Reason + Act) agent loop powered by Groq LLM.
 *
 * Loop per turn:
 *   1. Load context  — fetch TransactionRecord + conversation history
 *   2. Pre-check     — fast regex screen for dispute/opt-out keywords (before LLM)
 *   3. THOUGHT       — Groq LLM call: given context, choose a tool
 *   4. ACTION        — execute the chosen tool stub
 *   5. OBSERVATION   — capture tool result
 *   6. Persist+Emit  — write AgentAuditLog, emit txn:updated via Socket.IO
 */

const Groq = require('groq-sdk');

const TransactionRecord   = require('../models/TransactionRecord');
const ConversationMessage = require('../models/ConversationMessage');
const AgentAuditLog       = require('../models/AgentAuditLog');
const socket              = require('../config/socket');
const { TOOL_SCHEMAS, executeTool } = require('./agentTools');
const { reviewAction } = require('./complianceCop');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const MODEL = 'openai/gpt-oss-120b';

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
    lines.push(
      'ACTION REQUIRED: This is the FIRST contact with the customer. Their payment just failed.',
      'You must call send_whatsapp_message to send a warm, empathetic opening message in Hinglish.',
      'Mention the failed amount (Rs.' + txn.originalAmount + ') and ask how you can help.',
      'Do NOT call generate_payment_link or generate_upi_mandate yet — wait for their reply.',
      '',
    );
  } else {
    lines.push(
      'DECISION RULES (follow strictly):',
      '  - If payment failed due to infra/bank error → use schedule_retry first.',
      '  - If customer mentions a future date for payment → use generate_upi_mandate with that date.',
      '  - If customer is ready to pay now → use generate_payment_link.',
      '  - If customer says they cannot afford full amount → use apply_settlement_discount (5-10% only).',
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

  // Step 3: THOUGHT — call Groq LLM
  console.log('[Agent] Calling Groq for txn', transactionId, '| message:', inboundMessage);

  const isInitialTrigger = inboundMessage === 'PAYMENT_FAILED';
  const systemPrompt = buildSystemPrompt(txn, isInitialTrigger);

  // For initial trigger, don't include it as a user message — the system prompt already explains the context
  const conversationHistory = isInitialTrigger
    ? []
    : buildConversationMessages(history, inboundMessage);

  let groqResponse;
  try {
    groqResponse = await groq.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        // For initial trigger, add a minimal user message so the model has something to respond to
        ...(isInitialTrigger
          ? [{ role: 'user', content: 'Payment failed. Start outreach.' }]
          : conversationHistory
        ),
      ],
      tools: TOOL_SCHEMAS,
      tool_choice: 'auto',
      temperature: 0.3,
      max_tokens: 1024,
    });
  } catch (err) {
    throw new Error('Groq API error: ' + err.message);
  }

  const choice = groqResponse.choices[0];
  const thoughtText = choice.message.content || 'LLM selected a tool.';

  // Log THOUGHT step
  const thoughtLog = await logStep(transactionId, {
    step: 'THOUGHT',
    thoughtProcess: thoughtText,
  });
  auditLogIds.push(thoughtLog._id.toString());

  // Step 4: ACTION — parse the tool call
  // Fallback: if LLM returned plain text instead of a tool call, treat it as a WhatsApp message
  const toolCalls = choice.message.tool_calls;
  let toolName, toolArgs;

  if (!toolCalls || toolCalls.length === 0) {
    // LLM chose to respond with text — send it as a WhatsApp message
    console.log('[Agent] LLM returned text (no tool call) — routing to send_whatsapp_message');
    toolName = 'send_whatsapp_message';
    toolArgs = { message: thoughtText || 'Namaskar! Aapka payment issue resolve karne mein hum madad karna chahte hain.' };
  } else {
    const toolCall = toolCalls[0];
    toolName = toolCall.function.name;
    try {
      toolArgs = JSON.parse(toolCall.function.arguments);
    } catch {
      throw new Error('Failed to parse tool arguments: ' + toolCall.function.arguments);
    }
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

  return {
    toolName,
    observation: result.observation,
    auditLogIds,
    paymentLink: updatedTxn.activePaymentLink || null,
    mandateId:   updatedTxn.mandateId         || null,
  };
}

module.exports = { runAgentTurn };

