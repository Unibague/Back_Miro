const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/pdiIndicadorHistorial');

router.get('/', ctrl.getHistorial);

module.exports = router;
