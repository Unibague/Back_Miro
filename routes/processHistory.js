const express    = require('express');
const router     = express.Router();
const upload     = require('../config/fileReceive');
const controller = require('../controllers/processHistory');
const importCtrl = require('../controllers/importHistorial');

router.get('/plantilla', importCtrl.descargarPlantilla);
router.post('/importar', importCtrl.uploadMiddleware, importCtrl.importar);
router.post('/revertir', importCtrl.revertir);

router.get('/',    controller.getAll);
router.patch('/:id/resolucion-pdf', upload.single('file'), controller.updateResolucionPdf);
router.get('/:id', controller.getById);

module.exports = router;
