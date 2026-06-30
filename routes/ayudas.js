const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/ayudas');

function multerErrorHandler(err, req, res, next) {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'El archivo supera el tamaño máximo permitido (500 MB).' });
  }
  if (err) {
    return res.status(400).json({ error: err.message || 'Archivo no permitido.' });
  }
  next();
}

router.get('/', ctrl.getAll);

router.post(
  '/',
  (req, res, next) => ctrl.upload(req, res, (err) => multerErrorHandler(err, req, res, next)),
  ctrl.create
);

router.put('/:id', ctrl.updateById);
router.delete('/:id', ctrl.deleteById);

module.exports = router;
