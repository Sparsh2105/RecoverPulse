'use strict';

const { runAgentTurn } = require('../services/agentCore');
const TransactionRecord  = require('../models/TransactionRecord');

/**
 * POST /api/agent/process
 *
 * Manually triggers one ReAct agent turn for a transaction.
 * On Day 7, Twilio will call this endpoint automatically when a WhatsApp reply arrives.
 *
 * Body: { transactionId: string, inboundMessage: string }
 */
async function processAgentTurn(req, res) {
  const { transactionId, inboundMessage } = req.body;

  if (!transactionId || typeof transactionId !== 'string') {
    return res.status(400).json({
      success: false,
      errorCode: 'MISSING_TRANSACTION_ID',
      error: 'transactionId is required',
    });
  }

  if (!inboundMessage || typeof inboundMessage !== 'string' || !inboundMessage.trim()) {
    return res.status(400).json({
      success: false,
      errorCode: 'MISSING_MESSAGE',
      error: 'inboundMessage is required',
    });
  }

  const txn = await TransactionRecord.findById(transactionId).lean();
  if (!txn) {
    return res.status(404).json({
      success: false,
      errorCode: 'TRANSACTION_NOT_FOUND',
      error: 'No transaction found with that ID',
    });
  }

  try {
    const result = await runAgentTurn(transactionId, inboundMessage.trim());
    return res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    console.error('[AgentController] runAgentTurn failed:', err.message);
    return res.status(500).json({
      success: false,
      errorCode: 'AGENT_ERROR',
      error: err.message,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    });
  }
}

module.exports = { processAgentTurn };

