const express = require('express');
const router  = express.Router();
const controller = require('../controllers/phases');

router.get('/',                                    controller.getByProcess);
router.get('/:id',                                 controller.getById);
router.put('/:id',                                 controller.update);
router.put('/:id/reorder',                         controller.reorderActividades);
router.put('/:id/complete-all',                    controller.completeAll);
router.post('/:id/actividades',                    controller.addActividad);
router.put('/:id/actividades/:actividadId',        controller.updateActividad);
router.delete('/:id/actividades/:actividadId',                                          controller.removeActividad);
router.post('/:id/actividades/:actividadId/subactividades',                             controller.addSubactividad);
router.put('/:id/actividades/:actividadId/subactividades/reorder',                      controller.reorderSubactividades);
router.put('/:id/actividades/:actividadId/subactividades/:subactividadId',              controller.updateSubactividad);
router.delete('/:id/actividades/:actividadId/subactividades/:subactividadId',           controller.removeSubactividad);

module.exports = router;
