'use strict';

const express = require('express');
const { processAgentTurn } = require('../controllers/agentController');

const router = express.Router();

// POST /api/agent/process
router.post('/process', processAgentTurn);

module.exports = router;

