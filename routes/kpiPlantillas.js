const router = require("express").Router();
const upload = require("../config/fileReceive");
const historicoUpload = require("../config/historicoUpload");
const controller = require("../controllers/kpiPlantillas");

router.get("/", controller.getPlantillas);
router.get("/bases", controller.getBases);
router.post("/bases", historicoUpload.singleFile("base_file"), controller.uploadBase);
router.get("/bases/:id/archivo", controller.downloadBase);
router.delete("/bases/:id", controller.deleteBase);
router.post("/carpetas", controller.createCarpeta);
router.patch("/carpetas/:id", controller.renameCarpeta);
router.delete("/carpetas/:id", controller.deleteCarpeta);
router.post("/", upload.single("template_file"), controller.uploadPlantilla);
router.put("/:id", upload.single("template_file"), controller.replacePlantilla);
router.patch("/:id/carpeta", controller.movePlantilla);
router.get("/:id/hojas", controller.getHojas);
router.put("/:id/hojas", controller.saveHojas);
router.get("/:id/archivo", controller.downloadPlantilla);
router.post("/:id/traer", controller.traerInformacion);
router.delete("/:id", controller.deletePlantilla);

module.exports = router;
