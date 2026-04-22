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
router.get('/respuestas/por-indicador',            ctrl.getRespuestasPorIndicador);
router.get('/respuestas/lider-email-indicador',    ctrl.getLiderEmailIndicador);
router.get('/:id/respuestas',                    ctrl.getRespuestas);
router.get('/:id/respuestas/:respuestaId',        ctrl.getRespuestaById);
router.post('/:id/respuestas',                   ctrl.upsertRespuesta);
router.put('/:id/respuestas/:respuestaId/aval',  ctrl.avalRespuesta);
router.delete('/:id/respuestas/:respuestaId',    ctrl.deleteRespuesta);

// ── Archivos PDF por campo ─────────────────────────────────────────────────
router.post(
    '/:id/respuestas/:respuestaId/archivos/:campoId',
    upload.single('archivo'),
    ctrl.uploadArchivo
);
router.delete(
    '/:id/respuestas/:respuestaId/archivos/:campoId',
    ctrl.deleteArchivo
);

module.exports = router;
