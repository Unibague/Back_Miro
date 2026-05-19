const router = require('express').Router();
const controller = require('../controllers/pdiPresupuesto');

router.get('/data', controller.getData);

module.exports = router;
