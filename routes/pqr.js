const express    = require('express');
const router     = express.Router();
const controller = require('../controllers/pqr');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 2 } }).single('file');
const recibirExcel = (req, res, next) => upload(req, res, error => {
  if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'El Excel debe pesar como máximo 5 MB.' : 'No se pudo recibir el archivo Excel.' });
  if (!req.file || !/\.xlsx$/i.test(req.file.originalname)) return res.status(400).json({ error: 'Selecciona un archivo Excel .xlsx.' });
  next();
});

router.get('/',          controller.getAll);
router.post('/importar/preview', recibirExcel, controller.previewImport);
router.post('/importar', recibirExcel, controller.importExcel);
router.post('/',         controller.create);
router.put('/:id',       controller.update);
router.put('/:id/cerrar',controller.cerrar);
router.delete('/:id',    controller.remove);

module.exports = router;
