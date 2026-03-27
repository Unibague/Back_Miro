const router = require('express').Router();
const upload = require('../config/fileReceive');
const controller = require('../controllers/phaseDocuments');

// Lista documentos de una fase
router.get('/', controller.getByPhase);

// Lista documentos asociados a un proceso
router.get('/by-process', controller.getByProcess);

// Sube un nuevo documento a una fase
router.post('/:phaseId', upload.single('file'), controller.create);

// Sube un nuevo documento asociado a un proceso
router.post('/process/:processId', upload.single('file'), controller.createForProcess);

// Elimina un documento
router.delete('/:id', controller.remove);

module.exports = router;

