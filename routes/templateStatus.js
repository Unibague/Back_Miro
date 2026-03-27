const express = require('express');
const router = express.Router();
const controller = require('../controllers/templateStatus');
const { requireAdmin } = require('../middleware/auth');

// Obtener estado de envío de plantillas (solo admin)
router.get('/submission-status', requireAdmin, controller.getTemplateSubmissionStatus);

// Descargar reporte de estado de plantillas en Excel (solo admin)
router.get('/submission-status/download', requireAdmin, controller.downloadTemplateSubmissionStatus);

module.exports = router;
