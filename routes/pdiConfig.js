const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/pdiConfig');

router.get('/',  ctrl.get);
router.put('/',  ctrl.update);
router.post('/redistribuir-pesos', ctrl.redistribuirPesos);

module.exports = router;
