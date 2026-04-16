const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/pdiDashboard');

// Resumen institucional global
router.get('/resumen',                  ctrl.resumen);
// Tablero de un macroproyecto específico
router.get('/macroproyecto/:id',        ctrl.macroproyecto);
// Resumen de avance y cobertura de un corte/periodo
router.get('/corte/:periodo',           ctrl.corte);

module.exports = router;
