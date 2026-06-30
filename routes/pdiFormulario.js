const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/pdiFormulario');
const { upload } = require('../services/pdiFormularioStorage');

// ── Formularios ────────────────────────────────────────────────────────────
router.get('/',     ctrl.getAll);
router.get('/:id',  ctrl.getById);
router.post('/',    ctrl.create);
router.put('/:id',  ctrl.update);
router.delete('/:id', ctrl.remove);

// ── Respuestas ─────────────────────────────────────────────────────────────
router.get('/respuestas/pendientes-aval',          ctrl.getRespuestasPendientesAval);
router.get('/respuestas/pendientes-lider',         ctrl.getRespuestasPendientesLider);
router.get('/respuestas/pendientes-planeacion',    ctrl.getRespuestasPendientesPlaneacion);
router.get('/respuestas/por-indicador',            ctrl.getRespuestasPorIndicador);
router.get('/respuestas/lider-email-indicador',    ctrl.getLiderEmailIndicador);
router.get('/:id/respuestas',                    ctrl.getRespuestas);
router.get('/:id/respuestas/:respuestaId',        ctrl.getRespuestaById);
router.post('/:id/respuestas',                   ctrl.upsertRespuesta);
router.put('/:id/respuestas/:respuestaId/aval',        ctrl.avalRespuesta);
router.put('/:id/respuestas/:respuestaId/comentarios/:campoId/resuelto', ctrl.marcarComentarioCampoResuelto);
router.put('/:id/respuestas/:respuestaId/planeacion',  ctrl.avalPlaneacion);
router.delete('/:id/respuestas/:respuestaId',    ctrl.deleteRespuesta);

// ── Error handler de multer (tipo de archivo o tamaño rechazado) ──────────
function multerErrorHandler(err, req, res, next) {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'El archivo supera el tamaño máximo permitido de 10 MB.' });
    }
    if (err) {
        return res.status(400).json({ error: err.message || 'Formato de archivo no permitido.' });
    }
    next();
}

// ── Documento de evidencia (PDF o Word) ligado a la respuesta ─────────────
router.post(
    '/:id/respuestas/:respuestaId/documento-final',
    (req, res, next) => upload.array('archivo', 20)(req, res, (err) => multerErrorHandler(err, req, res, next)),
    ctrl.uploadDocumentoFinal
);
router.delete(
    '/:id/respuestas/:respuestaId/documento-final',
    ctrl.deleteDocumentoFinal
);

// ── Archivos PDF por campo ─────────────────────────────────────────────────
router.post(
    '/:id/respuestas/:respuestaId/archivos/:campoId',
    (req, res, next) => upload.single('archivo')(req, res, (err) => multerErrorHandler(err, req, res, next)),
    ctrl.uploadArchivo
);
router.delete(
    '/:id/respuestas/:respuestaId/archivos/:campoId',
    ctrl.deleteArchivo
);

module.exports = router;
