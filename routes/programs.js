const express = require('express');
const router = express.Router();
const controller = require('../controllers/programs');
const importCatalogo = require('../controllers/importProgramasCatalogo');

router.get('/import/plantilla', importCatalogo.descargarPlantilla);
router.post('/import/catalogo', importCatalogo.uploadMiddleware, importCatalogo.importarCatalogo);

router.get('/',         controller.getAll);
router.post('/',        controller.create);
router.get('/:id',      controller.getById);
router.put('/:id',      controller.update);
router.delete('/:id',   controller.remove);

module.exports = router;
