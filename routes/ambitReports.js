const express = require("express");
const controller = require("../controllers/ambitReports");

const router = express.Router();

router.post("/ai-generate", controller.generateAmbitReportWithAI);

module.exports = router;
