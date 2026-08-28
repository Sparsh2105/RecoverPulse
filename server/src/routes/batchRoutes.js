'use strict';

const express = require('express');
const { runBatch } = require('../controllers/batchController');

const router = express.Router();

// POST /api/batch/run
router.post('/run', runBatch);

module.exports = router;
