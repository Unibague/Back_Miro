const router = require('express').Router();
const controller = require('../controllers/templates');
const auditMiddleware = require('../middleware/configurationAudit');

router.get('/sync-published-templates', controller.syncAllPublishedTemplates);
router.get("/creator", controller.getPlantillasByCreator);
router.get("/all", controller.getPlantillas);
router.get("/all/no-pagination", controller.getTemplatesWithoutPagination)
router.get("/:id", controller.getPlantilla);
router.post("/create", auditMiddleware('template'), controller.createPlantilla);
router.put("/:id", auditMiddleware('template'), controller.updatePlantilla);
router.delete("/delete", auditMiddleware('template'), controller.deletePlantilla);


module.exports = router