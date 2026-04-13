const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/pdiCorte');

router.get('/',         ctrl.getAll);
router.get('/activos',  ctrl.getActivos);
router.get('/vigentes', ctrl.getVigentes);
router.post('/',        ctrl.create);
router.put('/:id',      ctrl.update);
router.delete('/:id',   ctrl.remove);

module.exports = router;
