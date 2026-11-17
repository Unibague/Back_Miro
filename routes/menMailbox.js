const express = require('express');
const router = express.Router();
const controller = require('../controllers/menMailbox');
const { requireAdmin } = require('../middleware/auth');

router.get('/', requireAdmin, controller.getAll);
router.post('/enviar', requireAdmin, controller.enviar);
router.post('/enviar-general', requireAdmin, controller.enviar);

module.exports = router;
