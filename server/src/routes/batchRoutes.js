'use strict';

const express = require('express');
const { runBatch, stopBatch, completeBatch, clearDatabase } = require('../controllers/batchController');

const router = express.Router();

router.post('/run',      runBatch);
router.post('/stop',     stopBatch);
router.post('/complete', completeBatch);
router.post('/clear',    clearDatabase);

module.exports = router;
