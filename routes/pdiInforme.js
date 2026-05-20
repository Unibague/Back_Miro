const router = require('express').Router();
const ctrl   = require('../controllers/pdiInforme');

router.get('/lista',           ctrl.lista);
router.get('/cortes',          ctrl.cortes);
router.get('/indicador/:id',   ctrl.informeIndicador);
router.get('/accion/:id',      ctrl.informeAccion);
router.get('/proyecto/:id',    ctrl.informeProyecto);
router.get('/macro/:id',       ctrl.informeMacro);

module.exports = router;
