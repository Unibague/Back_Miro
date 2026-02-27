const express = require('express');
const router  = express.Router();
const controller = require('../controllers/phases');

router.get('/',                                    controller.getByProcess);
router.get('/:id',                                 controller.getById);
router.put('/:id',                                 controller.update);
router.post('/:id/actividades',                    controller.addActividad);
router.put('/:id/actividades/:actividadId',        controller.updateActividad);
router.delete('/:id/actividades/:actividadId',     controller.removeActividad);

module.exports = router;
