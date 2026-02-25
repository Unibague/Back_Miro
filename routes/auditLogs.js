const express = require('express');
const router = express.Router();
const auditController = require('../controllers/auditLogs');

router.get('/logs', auditController.getLogs);
router.get('/logs-by-entity', auditController.getLogsByEntity);
router.post('/', (req, res) => {
  // Endpoint para recibir logs de audit desde el frontend
  res.status(200).json({ message: 'Audit log received' });
});

module.exports = router;