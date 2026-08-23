/**
 * @file controllers/transactionController.js
 * @description CRUD and analytics handlers for TransactionRecord documents.
 * Each exported function maps 1-to-1 with a route in transactionRoutes.js.
 */

'use strict';

const TransactionRecord  = require('../models/TransactionRecord');
const AgentAuditLog      = require('../models/AgentAuditLog');
const ConversationMessage = require('../models/ConversationMessage');

// ---------------------------------------------------------------------------
// In-progress lifecycle states (used in stats query)
// ---------------------------------------------------------------------------

const IN_PROGRESS_STATES = [
  'FAILED_PAYMENT_INGESTED',
  'SILENT_RETRY_SCHEDULED',
  'OUTREACH_INITIATED',
  'MANDATE_PENDING_AUTH',
  'DISCOUNT_GATED_LINK',
];

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

/**
 * GET /api/transactions
 *
 * Returns a paginated list of transactions, optionally filtered by `state`
 * and/or `errorCategory` query parameters.
 *
 * Query params:
 *   - page          {number}  Page number, 1-indexed (default: 1)
 *   - limit         {number}  Items per page (default: 50)
 *   - state         {string}  Filter by transaction state (optional)
 *   - errorCategory {string}  Filter by error category (optional)
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function listTransactions(req, res) {
  try {
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.max(1, parseInt(req.query.limit, 10) || 50);
    const skip  = (page - 1) * limit;

    /** @type {Record<string, string>} */
    const filter = {};
    if (req.query.state)         filter.state         = req.query.state;
    if (req.query.errorCategory) filter.errorCategory = req.query.errorCategory;

    console.log(`ðŸ“Š listTransactions â€” page=${page} limit=${limit} filter=${JSON.stringify(filter)}`);

    const [transactions, total] = await Promise.all([
      TransactionRecord.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      TransactionRecord.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: transactions,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('âŒ listTransactions error:', error.message);
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
 *
 * Returns aggregate counts and monetary totals across all transactions.
 * Fields returned:
 *   - totalTransactions     {number}
 *   - recovered             {number}
 *   - failed                {number}
 *   - escalated             {number}
 *   - inProgress            {number}
 *   - grossValueAtRisk      {number}  Sum of originalAmount for all transactions
 *   - totalRecoveredAmount  {number}  Sum of recoveredAmount for RECOVERED transactions
 *   - recoveryRate          {string}  Percentage string e.g. "42.3"
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function getTransactionStats(req, res) {
  try {
    console.log('ðŸ“Š getTransactionStats â€” computing summary');

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
      TransactionRecord.aggregate([
        { $group: { _id: null, total: { $sum: '$originalAmount' } } },
      ]),
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
    console.error('âŒ getTransactionStats error:', error.message);
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
 *
 * Returns a single TransactionRecord by its MongoDB _id, joined with its
 * related AgentAuditLog entries and ConversationMessage entries (both sorted
 * chronologically ascending).
 *
 * @param {import('express').Request}  req - `req.params.id` must be a valid ObjectId string.
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function getTransactionById(req, res) {
  try {
    const { id } = req.params;
    console.log(`ðŸ“Š getTransactionById â€” id=${id}`);

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
    console.error('âŒ getTransactionById error:', error.message);
    return res.status(500).json({
      success: false,
      errorCode: 'INTERNAL_SERVER_ERROR',
      error: 'Failed to fetch transaction',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  listTransactions,
  getTransactionStats,
  getTransactionById,
};
