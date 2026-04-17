const express = require('express');
const router = express.Router();
const controller = require('../controllers/processReminders');

router.get('/', controller.getAll);

module.exports = router;
