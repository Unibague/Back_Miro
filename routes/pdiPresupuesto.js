const router = require('express').Router();
const controller = require('../controllers/pdiPresupuesto');

router.get('/data',        controller.getData);
router.get('/user-macros', controller.getUserMacros);

module.exports = router;
