const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/processes');
const historyController = require('../controllers/processHistory');

router.patch('/bulk-fases',      controller.bulkFases);
router.get('/',                  controller.getAll);
router.get('/:id',               controller.getById);
router.post('/',                 controller.create);
router.post('/:id/activate-pm',  controller.activatePM);
router.post('/:id/close',        historyController.close);
router.put('/:id',               controller.update);
router.delete('/:id',            controller.remove);

module.exports = router;
