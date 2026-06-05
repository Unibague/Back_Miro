const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/pdiDashboard');

// Resumen institucional global
router.get('/resumen',                  ctrl.resumen);
// Red editable de nodos y relaciones del PDI
router.get('/red-nodos',                ctrl.redNodos);
router.put('/red-nodos',                ctrl.guardarRedNodos);
router.post('/red-nodos/reiniciar',     ctrl.reiniciarRedNodos);
// Tablero de un macroproyecto especifico
router.get('/macroproyecto/:id',        ctrl.macroproyecto);
// Resumen de avance y cobertura de un corte/periodo
router.get('/corte/:periodo',           ctrl.corte);

module.exports = router;
