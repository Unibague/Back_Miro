const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/processHistory');

router.get('/',    controller.getAll);
router.get('/:id', controller.getById);

module.exports = router;
