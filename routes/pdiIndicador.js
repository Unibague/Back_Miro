const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/pdiIndicador');

router.get('/',                    ctrl.getAll);
router.get('/:id',                 ctrl.getById);
router.post('/',                   ctrl.create);
router.put('/:id',                 ctrl.update);
router.patch('/:id/periodo',       ctrl.updatePeriodo);
router.delete('/:id',              ctrl.remove);

module.exports = router;
