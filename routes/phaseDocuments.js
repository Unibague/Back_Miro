const router = require('express').Router();
const upload = require('../config/fileReceive');
const controller = require('../controllers/phaseDocuments');

// Lista documentos de una fase
router.get('/', controller.getByPhase);

// Sube un nuevo documento a una fase
router.post('/:phaseId', upload.single('file'), controller.create);

// Elimina un documento
router.delete('/:id', controller.remove);

module.exports = router;

