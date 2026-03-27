const upload = require('../config/fileReceive.js')
const controller = require('../controllers/reports.js')
const auditMiddleware = require('../middleware/configurationAudit');

const router = require('express').Router()

router.get("/all", controller.getReports)

router.post("/create", upload.single('report_example'), auditMiddleware('report'), controller.createReport)


router.delete("/delete/:id", auditMiddleware('report'), controller.deleteReport)

router.get("/:id", controller.getReport)

router.put("/:id", upload.single('report_example'), auditMiddleware('report'), controller.updateReport)

module.exports = router