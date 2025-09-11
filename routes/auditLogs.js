const express = require('express');
const router = express.Router();
const auditController = require('../controllers/auditLogs');

router.get('/logs', auditController.getLogs);

module.exports = router;