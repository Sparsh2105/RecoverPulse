'use strict';

const TransactionRecord   = require('../models/TransactionRecord');
const AgentAuditLog       = require('../models/AgentAuditLog');
const ConversationMessage = require('../models/ConversationMessage');

const IN_PROGRESS_STATES = [
  'FAILED_PAYMENT_INGESTED',
  'SILENT_RETRY_SCHEDULED',
  'OUTREACH_INITIATED',
  'MANDATE_PENDING_AUTH',
  'DISCOUNT_GATED_LINK',
];

/**
 * GET /api/transactions
 * Paginated list, filterable by state and errorCategory.
 */
async function listTransactions(req, res) {
  try {
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 50);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.state)         filter.state         = req.query.state;
    if (req.query.errorCategory) filter.errorCategory = req.query.errorCategory;

    const [transactions, total] = await Promise.all([
      TransactionRecord.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      TransactionRecord.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('listTransactions error:', error.message);
    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_SERVER_ERROR',
      error: 'Failed to fetch transactions',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}

/**
 * GET /api/transactions/stats/summary
 * Aggregate counts and monetary totals.
 */
async function getTransactionStats(req, res) {
  try {
    const [
      totalTransactions,
      recovered,
      failed,
      escalated,
      inProgress,
      totalAtRisk,
      totalRecovered,
    ] = await Promise.all([
      TransactionRecord.countDocuments(),
      TransactionRecord.countDocuments({ state: 'RECOVERED' }),
      TransactionRecord.countDocuments({ state: 'RECOVERY_FAILED' }),
      TransactionRecord.countDocuments({ state: 'ESCALATED_TO_HUMAN' }),
      TransactionRecord.countDocuments({ state: { $in: IN_PROGRESS_STATES } }),
      TransactionRecord.aggregate([{ $group: { _id: null, total: { $sum: '$originalAmount' } } }]),
      TransactionRecord.aggregate([
        { $match: { state: 'RECOVERED' } },
        { $group: { _id: null, total: { $sum: '$recoveredAmount' } } },
      ]),
    ]);

    const recoveryRate =
      totalTransactions > 0
        ? ((recovered / totalTransactions) * 100).toFixed(1)
        : '0.0';

    return res.json({
      success: true,
      data: {
        totalTransactions,
        recovered,
        failed,
        escalated,
        inProgress,
        grossValueAtRisk:     totalAtRisk[0]?.total    || 0,
        totalRecoveredAmount: totalRecovered[0]?.total || 0,
        recoveryRate,
      },
    });
  } catch (error) {
    console.error('getTransactionStats error:', error.message);
    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_SERVER_ERROR',
      error: 'Failed to fetch transaction stats',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}

/**
 * GET /api/transactions/:id
 * Single transaction joined with audit logs and conversation messages.
 */
async function getTransactionById(req, res) {
  try {
    const { id } = req.params;

    const transaction = await TransactionRecord.findById(id).lean();
    if (!transaction) {
      return res.status(404).json({
        success: false,
        errorCode: 'TRANSACTION_NOT_FOUND',
        error: 'Transaction not found',
      });
    }

    const [auditLogs, conversations] = await Promise.all([
      AgentAuditLog.find({ transactionId: id }).sort({ createdAt: 1 }).lean(),
      ConversationMessage.find({ transactionId: id }).sort({ createdAt: 1 }).lean(),
    ]);

    return res.json({
      success: true,
      data: { ...transaction, auditLogs, conversations },
    });
  } catch (error) {
    console.error('getTransactionById error:', error.message);
    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_SERVER_ERROR',
      error: 'Failed to fetch transaction',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}

module.exports = { listTransactions, getTransactionStats, getTransactionById };
