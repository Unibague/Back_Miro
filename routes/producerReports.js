const controller = require('../controllers/producerReports')
const router = require('express').Router()
const fileUpload = require('../config/fileReceive')
const auditMiddleware = require('../middleware/configurationAudit');

router.get("/all", controller.getReports)
router.get("/", controller.getReportsPagination)
router.post("/create", fileUpload.single('report_example'), auditMiddleware('producerReport'), controller.createReport)
router.get("/:id", controller.getReport)
router.put("/", fileUpload.single('report_example'), auditMiddleware('producerReport'), controller.updateReport)
router.delete("/:id", auditMiddleware('producerReport'), controller.deleteProducerReport);


module.exports = router