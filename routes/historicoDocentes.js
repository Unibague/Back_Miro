const router = require("express").Router();
const upload = require("../config/fileReceive");
const controller = require("../controllers/historicoDocentes");

router.get("/data", controller.getData);
router.get("/download", controller.downloadFile);
router.post("/upload", upload.single("excel_file"), controller.upload);

module.exports = router;
