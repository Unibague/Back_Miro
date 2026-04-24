const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/pdiProyecto');
const upload  = require('../config/fileReceive');

router.get('/',     ctrl.getAll);
router.post('/importar-ejecutado', upload.single('file'), ctrl.importExecuted);
router.get('/:id',  ctrl.getById);
router.post('/',    ctrl.create);
router.put('/:id',  ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
