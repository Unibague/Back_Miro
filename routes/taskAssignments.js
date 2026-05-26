const express = require('express');
const router = express.Router();
const controller = require('../controllers/taskAssignments');

router.get('/',       controller.getAll);
router.post('/',      controller.create);
router.put('/:id',    controller.update);
router.delete('/:id', controller.remove);

module.exports = router;
