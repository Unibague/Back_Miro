const express = require('express');
const router = express.Router();
const controller = require('../controllers/programs');
const importCatalogo = require('../controllers/importProgramasCatalogo');
const { requireAdmin, requireReadAccess } = require('../middleware/auth');

router.get('/import/plantilla', requireAdmin, importCatalogo.descargarPlantilla);
router.post('/import/catalogo', requireAdmin, importCatalogo.uploadMiddleware, importCatalogo.importarCatalogo);

router.get('/',         requireReadAccess, controller.getAll);
router.post('/',        requireAdmin,      controller.create);
router.get('/:id',      requireReadAccess, controller.getById);
router.put('/:id',      requireAdmin,      controller.update);
router.delete('/:id',   requireAdmin,      controller.remove);

module.exports = router;
