const express = require('express');
const router = express.Router();
const controller = require('../controllers/processReminders');
const { requireAdmin } = require('../middleware/auth');

router.get('/', controller.getAll);
router.delete('/:id', requireAdmin, controller.remove);

module.exports = router;
