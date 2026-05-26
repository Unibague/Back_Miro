const express    = require('express');
const router     = express.Router();
const upload     = require('../config/fileReceive');
const controller = require('../controllers/processHistory');
const importCtrl = require('../controllers/importHistorial');
const importVigentesCtrl = require('../controllers/importVigentes');

router.get('/plantilla', importCtrl.descargarPlantilla);
router.post('/importar', importCtrl.uploadMiddleware, importCtrl.importar);
router.post('/revertir', importCtrl.revertir);

router.get('/vigentes/plantilla', importVigentesCtrl.descargarPlantilla);
router.post('/vigentes/importar', importVigentesCtrl.uploadMiddleware, importVigentesCtrl.importar);
router.post('/vigentes/revertir', importVigentesCtrl.revertir);

router.get('/',    controller.getAll);
router.patch('/:id/resolucion-pdf', upload.single('file'), controller.updateResolucionPdf);
router.get('/:id', controller.getById);

module.exports = router;
