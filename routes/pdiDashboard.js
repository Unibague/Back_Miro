const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/pdiDashboard');

// Resumen institucional global
router.get('/resumen',                  ctrl.resumen);
// Excel con la memoria de calculo del avance (formulas auditables)
router.get('/exportar-avance',          ctrl.exportarAvance);
// Igual, pero enfocado en un solo año (por defecto el año en curso)
router.get('/exportar-avance-anio',     ctrl.exportarAvanceAnio);
// Excel base de indicadores PDI con todas las metas por periodo
router.get('/exportar-indicadores-metas', ctrl.exportarIndicadoresMetas);
// Red editable de nodos y relaciones del PDI
router.get('/red-nodos',                ctrl.redNodos);
router.put('/red-nodos',                ctrl.guardarRedNodos);
router.post('/red-nodos/reiniciar',     ctrl.reiniciarRedNodos);
// Tablero de un macroproyecto especifico
router.get('/macroproyecto/:id',        ctrl.macroproyecto);
// Resumen de avance y cobertura de un corte/periodo
router.get('/corte/:periodo',           ctrl.corte);

module.exports = router;
