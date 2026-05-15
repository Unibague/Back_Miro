const router = require("express").Router();
const upload = require("../config/fileReceive");
const controller = require("../controllers/historicoDocentes");

router.get("/list", controller.listFiles);
router.get("/data", controller.getData);
router.get("/download", controller.downloadFile);
router.post("/upload", upload.single("excel_file"), controller.upload);
router.patch("/:id/rename", controller.renameFile);
router.delete("/:id", controller.deleteFile);

module.exports = router;
