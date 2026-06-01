const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/pdiCorte');

router.get('/',         ctrl.getAll);
router.get('/activos',  ctrl.getActivos);
router.get('/vigentes', ctrl.getVigentes);
router.get('/:id/resumen', ctrl.getResumenCorte);
router.post('/',        ctrl.create);
router.post('/:id/notificar-usuarios', ctrl.notificarUsuarios);
router.put('/:id',      ctrl.update);
router.delete('/:id',   ctrl.remove);

module.exports = router;
