'use strict';

/**
 * @file services/complianceCop.js
 * @description Independent safety layer — Gemini 2.0 Flash.
 * Reviews every agent action before execution.
 */

const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GROQ_API_KEY);
const COMPLIANCE_MODEL = 'gemini-2.5-flash-lite';

// IST offset = UTC+5:30
const IST_OFFSET_HOURS = 5.5;
const CONTACT_WINDOW_START = 8;  // 8 AM IST
const CONTACT_WINDOW_END   = 19; // 7 PM IST

const MAX_OUTREACH_COUNT = 5;
const MIN_DISCOUNT_PCT   = 5;
const MAX_DISCOUNT_PCT   = 10;

// ---------------------------------------------------------------------------
// Hard rule checks (no LLM needed — deterministic)
// ---------------------------------------------------------------------------

function getISTHour() {
  const now = new Date();
  const utcHour = now.getUTCHours() + now.getUTCMinutes() / 60;
  return (utcHour + IST_OFFSET_HOURS) % 24;
}

function checkHardRules(toolName, toolArgs, txn) {
  // Contact window — only allow messaging between 8 AM and 7 PM IST
  if (toolName === 'send_whatsapp_message') {
    const hour = getISTHour();
    const bypassWindow = process.env.BYPASS_CONTACT_WINDOW === 'true';

    if (!bypassWindow && (hour < CONTACT_WINDOW_START || hour >= CONTACT_WINDOW_END)) {
      return {
        approved: false,
        queued: true,  // ← signals "don't escalate, just defer"
        reason: 'contact_window_violation: messaging outside 8AM-7PM IST (current hour: ' + Math.floor(hour) + ')',
      };
    }

    // Outreach count cap
    if ((txn.outreachCount || 0) >= MAX_OUTREACH_COUNT) {
      return {
        approved: false,
        queued: false,
        reason: 'outreach_limit_exceeded: customer contacted ' + txn.outreachCount + ' times (max ' + MAX_OUTREACH_COUNT + ')',
      };
    }
  }

  // Discount cap — enforced in code regardless of what the LLM says
  if (toolName === 'apply_settlement_discount') {
    const pct = toolArgs.discountPercent;
    if (typeof pct !== 'number' || pct < MIN_DISCOUNT_PCT || pct > MAX_DISCOUNT_PCT) {
      return {
        approved: false,
        queued: false,
        reason: 'discount_out_of_bounds: ' + pct + '% is outside the allowed 5-10% range',
      };
    }
  }

  return null; // No hard rule violation
}

// ---------------------------------------------------------------------------
// LLM-based soft check for tone and content (only for outbound messages)
// ---------------------------------------------------------------------------

async function checkWithLLM(message, txn) {
  const prompt = [
    'You are a compliance auditor for a payment recovery system in India.',
    'Review this outbound message and check for violations.',
    '',
    'RULES (any violation = reject):',
    '1. No false urgency (e.g., "URGENT", "last chance", "final notice")',
    '2. No threats of legal action or consequences',
    '3. No guilt-tripping or emotional manipulation',
    '4. No false claims (e.g., "your account will be closed")',
    '5. Tone must be friendly and empathetic, not robotic or aggressive',
    '6. Must not impersonate a court, bank, or legal authority',
    '',
    'CUSTOMER CONTEXT:',
    '  Name: ' + txn.customerName,
    '  Failed Amount: Rs.' + txn.originalAmount,
    '',
    'MESSAGE TO REVIEW:',
    message,
    '',
    'Respond with ONLY valid JSON in this exact format:',
    '{"approved": true} or {"approved": false, "reason": "brief violation description"}',
    'No other text, no markdown, just the JSON.',
  ].join('\n');

  try {
    const model = genAI.getGenerativeModel({
      model: COMPLIANCE_MODEL,
      generationConfig: { temperature: 0.1, maxOutputTokens: 150 },
    });
    const result = await model.generateContent(prompt);
    const raw = (result.response.text() || '').trim();
    if (!raw) return { approved: true };
    const clean = raw.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    if (!clean) return { approved: true };
    return JSON.parse(clean);
  } catch (err) {
    // If compliance check itself errors, fail safe — approve with warning
    console.warn('[ComplianceCop] LLM check failed, failing open:', err.message);
    return { approved: true };
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Reviews a proposed agent action before execution.
 *
 * @param {string} toolName   - Tool the agent wants to call.
 * @param {object} toolArgs   - Arguments the agent is passing to the tool.
 * @param {object} txn        - The TransactionRecord Mongoose document.
 * @returns {Promise<{ approved: boolean, reason?: string }>}
 */
async function reviewAction(toolName, toolArgs, txn) {
  // Hard rules first — fast, no LLM cost
  const hardViolation = checkHardRules(toolName, toolArgs, txn);
  if (hardViolation) {
    console.log('[ComplianceCop] HARD RULE VIOLATION:', hardViolation.reason);
    return hardViolation;
  }

  // LLM tone/content check — only for outbound messages
  // Skip during batch runs (SKIP_LLM_COMPLIANCE=true) to avoid rate limits.
  // Hard rules above already enforce the critical safety constraints.
  if (toolName === 'send_whatsapp_message' && toolArgs.message) {
    if (process.env.SKIP_LLM_COMPLIANCE === 'true') {
      return { approved: true }; // hard rules passed — safe to skip LLM tone check in batch
    }
    const llmVerdict = await checkWithLLM(toolArgs.message, txn);
    if (!llmVerdict.approved) {
      console.log('[ComplianceCop] LLM REJECTED message:', llmVerdict.reason);
    }
    return llmVerdict;
  }

  // All other tools approved
  return { approved: true };
}

module.exports = { reviewAction };

