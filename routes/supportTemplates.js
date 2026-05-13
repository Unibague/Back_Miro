const router = require("express").Router();
const upload = require("../config/fileReceive");
const controller = require("../controllers/supportTemplates");

router.post("/preview", upload.single("template_file"), controller.preview);
router.post("/download", upload.single("template_file"), controller.download);

module.exports = router;
