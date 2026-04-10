const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/pdiIndicador');
const { upload } = require('../services/pdiFileStorage');

router.get('/',                                    ctrl.getAll);
router.get('/:id',                                 ctrl.getById);
router.post('/',                                   ctrl.create);
router.put('/:id',                                 ctrl.update);
router.patch('/:id/periodo',                       ctrl.updatePeriodo);
router.delete('/:id',                              ctrl.remove);

// Evidencias
router.get('/:id/evidencias',                      ctrl.getEvidencias);
router.post('/:id/evidencias', upload.single('pdf'), ctrl.uploadEvidencia);
router.delete('/:id/evidencias/:evidenciaId',      ctrl.deleteEvidencia);

module.exports = router;
