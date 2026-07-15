const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/processes');
const historyController = require('../controllers/processHistory');
const { requireAdmin, requireReadAccess } = require('../middleware/auth');

router.patch('/bulk-fases',         requireAdmin,      controller.bulkFases);
router.get('/',                     requireReadAccess, controller.getAll);
router.get('/:id',                  requireReadAccess, controller.getById);
router.post('/',                    requireAdmin,       controller.create);
router.post('/:id/activate-pm',     requireAdmin,       controller.activatePM);
router.post('/:id/repair-pm-alert', requireAdmin,       controller.repairPMAlert);
router.post('/:id/close',           requireAdmin,       historyController.close);
router.put('/:id',                  requireAdmin,       controller.update);
router.delete('/:id',               requireAdmin,       controller.remove);

module.exports = router;
