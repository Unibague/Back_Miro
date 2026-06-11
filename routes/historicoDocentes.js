const router = require("express").Router();
const upload = require("../config/fileReceive");
const controller = require("../controllers/historicoDocentes");

router.get("/list", controller.listFiles);
router.get("/data", controller.getData);
router.get("/download", controller.downloadFile);
router.post("/upload", upload.single("excel_file"), controller.upload);
router.patch("/:id/rename", controller.renameFile);
router.delete("/:id", controller.deleteFile);

// PDF principal
router.get("/:id/pdf", controller.viewPdf);

// Anexos
router.get("/:id/anexos", controller.listAnexos);
router.post("/:id/anexos", upload.single("anexo_file"), controller.addAnexo);
router.patch("/:id/anexos/:anexoId/rename", controller.renameAnexo);
router.get("/:id/anexos/:anexoId", controller.viewAnexo);
router.delete("/:id/anexos/:anexoId", controller.deleteAnexo);

module.exports = router;
