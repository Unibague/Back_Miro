const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/pqr');

router.get('/',          controller.getAll);
router.post('/',         controller.create);
router.put('/:id',       controller.update);
router.put('/:id/cerrar',controller.cerrar);
router.delete('/:id',    controller.remove);

module.exports = router;
