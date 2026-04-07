const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/casos');

router.get('/',       controller.getByProcess);
router.post('/',      controller.create);
router.put('/:id',    controller.update);
router.delete('/:id', controller.remove);

module.exports = router;
