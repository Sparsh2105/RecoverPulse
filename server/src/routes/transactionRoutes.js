/**
 * @file routes/transactionRoutes.js
 * @description Thin router â€” maps transaction endpoints to controller handlers.
 * No business logic lives here.
 */

'use strict';

const express = require('express');
const {
  listTransactions,
  getTransactionStats,
  getTransactionById,
} = require('../controllers/transactionController');

const router = express.Router();

// GET /api/transactions
router.get('/', listTransactions);

// GET /api/transactions/stats/summary  (must be registered BEFORE /:id)
router.get('/stats/summary', getTransactionStats);

// GET /api/transactions/:id
router.get('/:id', getTransactionById);

module.exports = router;
