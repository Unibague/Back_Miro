const router = require('express').Router();
const controller = require('../controllers/configurationAudit');
const { requireAdmin } = require('../middleware/auth');
const auditMiddleware = require('../middleware/configurationAudit');

// Historial de auditoría por entidad
router.get('/template/:templateId', requireAdmin, controller.getTemplateAuditHistory);
router.get('/report/:reportId', requireAdmin, controller.getReportAuditHistory);
router.get('/producer-report/:reportId', requireAdmin, controller.getProducerReportAuditHistory);

// Historial de auditoría por usuario
router.get('/user/:email', requireAdmin, controller.getUserAuditHistory);

module.exports = router;
