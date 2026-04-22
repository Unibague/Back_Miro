const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/pdiSolicitudCambio');

router.get('/',               ctrl.getAll);
router.get('/:id',            ctrl.getById);
router.post('/',              ctrl.create);
router.patch('/:id/revision', ctrl.revisar);
router.delete('/:id',         ctrl.remove);

module.exports = router;
