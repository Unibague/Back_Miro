const router = require("express").Router();
const upload = require("../config/fileReceive");
const controller = require("../controllers/supportTemplates");
const { requireAdmin } = require("../middleware/auth");

router.post("/preview", requireAdmin, upload.single("template_file"), controller.preview);
router.post("/download", requireAdmin, upload.single("template_file"), controller.download);

module.exports = router;
