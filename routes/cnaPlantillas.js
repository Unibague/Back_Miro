const router = require("express").Router();
const upload = require("../config/fileReceive");
const controller = require("../controllers/cnaPlantillas");

router.get("/", controller.getPlantillas);
router.get("/opciones", controller.getOpciones);
router.post("/", upload.single("template_file"), controller.uploadPlantilla);
router.get("/:id/archivo", controller.downloadPlantilla);
router.post("/:id/generar", controller.generarPlantilla);
router.delete("/:id", controller.deletePlantilla);

module.exports = router;
