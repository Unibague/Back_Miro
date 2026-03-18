const router = require("express").Router();
const upload = require("../config/fileReceive");
const controller = require("../controllers/sniesTemplates");

router.get("/", controller.getTemplates);
router.get("/feed-options", controller.getFeedOptions);
router.get("/:id/download-template", controller.downloadTemplateFile);
router.get("/:id/connected-data", controller.getConnectedData);
router.get("/:id/download-connected-data", controller.downloadConnectedData);
router.post("/create", upload.single("template_file"), controller.createTemplate);
router.put("/:id", upload.single("template_file"), controller.updateTemplate);
router.delete("/:id", controller.deleteTemplate);

module.exports = router;
