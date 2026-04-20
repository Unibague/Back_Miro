const svc     = require('../services/pdiFormulario');
const { buildUrl, deleteFile } = require('../services/pdiFormularioStorage');
const Respuesta = require('../models/pdiFormularioRespuesta');

const ctrl = {};

// ── Formularios ────────────────────────────────────────────────────────────

ctrl.getAll = async (req, res) => {
    try {
        const { indicador_id, accion_id, activo } = req.query;
        const docs = await svc.getAll({
            indicador_id,
            accion_id,
            activo: activo !== undefined ? activo === 'true' : undefined,
        });
        res.json(docs);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.getById = async (req, res) => {
    try {
        const doc = await svc.getById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        res.json(doc);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.create = async (req, res) => {
    try {
        const doc = await svc.create(req.body);
        res.status(201).json(doc);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.update = async (req, res) => {
    try {
        const doc = await svc.update(req.params.id, req.body);
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        res.json(doc);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.remove = async (req, res) => {
    try {
        const doc = await svc.remove(req.params.id);
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        res.json({ message: 'Formulario eliminado' });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

// ── Respuestas ─────────────────────────────────────────────────────────────

ctrl.getRespuestas = async (req, res) => {
    try {
        const { formulario_id, respondido_por, corte } = req.query;
        const docs = await svc.getRespuestas({ formulario_id, respondido_por, corte });
        res.json(docs);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.getRespuestaById = async (req, res) => {
    try {
        const doc = await svc.getRespuestaById(req.params.respuestaId);
        if (!doc) return res.status(404).json({ error: 'No encontrada' });
        res.json(doc);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

// POST /pdi/formularios/:id/respuestas
// Crea o actualiza la respuesta (upsert por formulario+respondido_por+corte)
ctrl.upsertRespuesta = async (req, res) => {
    try {
        const { respondido_por, corte, respuestas, estado } = req.body;
        const doc = await svc.upsertRespuesta({
            formulario_id: req.params.id,
            respondido_por,
            corte,
            respuestas,
            estado,
        });
        res.status(200).json(doc);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.deleteRespuesta = async (req, res) => {
    try {
        const doc = await svc.deleteRespuesta(req.params.respuestaId);
        if (!doc) return res.status(404).json({ error: 'No encontrada' });
        res.json({ message: 'Respuesta eliminada' });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

// POST /pdi/formularios/:id/respuestas/:respuestaId/archivos/:campoId
// Sube un PDF para un campo específico de una respuesta
ctrl.uploadArchivo = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo PDF' });

        const doc = await svc.getRespuestaById(req.params.respuestaId);
        if (!doc) return res.status(404).json({ error: 'Respuesta no encontrada' });

        const campoId = req.params.campoId;
        const idx = doc.respuestas.findIndex(r => r.campo_id.toString() === campoId);

        const archivoData = {
            nombre_original: req.file.originalname,
            filename:        req.file.filename,
            url:             buildUrl(req.file.filename),
        };

        if (idx >= 0) {
            // Eliminar archivo anterior si existe
            if (doc.respuestas[idx].filename) deleteFile(doc.respuestas[idx].filename);
            doc.respuestas[idx].nombre_original = archivoData.nombre_original;
            doc.respuestas[idx].filename        = archivoData.filename;
            doc.respuestas[idx].url             = archivoData.url;
        } else {
            doc.respuestas.push({
                campo_id: campoId,
                tipo: 'archivo_pdf',
                ...archivoData,
            });
        }

        doc.markModified('respuestas');
        await doc.save();
        res.status(201).json(archivoData);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// DELETE /pdi/formularios/:id/respuestas/:respuestaId/archivos/:campoId
ctrl.deleteArchivo = async (req, res) => {
    try {
        const doc = await Respuesta.findById(req.params.respuestaId);
        if (!doc) return res.status(404).json({ error: 'Respuesta no encontrada' });

        const idx = doc.respuestas.findIndex(r => r.campo_id.toString() === req.params.campoId);
        if (idx < 0) return res.status(404).json({ error: 'Campo no encontrado' });

        if (doc.respuestas[idx].filename) deleteFile(doc.respuestas[idx].filename);
        doc.respuestas[idx].filename        = '';
        doc.respuestas[idx].nombre_original = '';
        doc.respuestas[idx].url             = '';
        doc.markModified('respuestas');
        await doc.save();
        res.json({ message: 'Archivo eliminado' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

module.exports = ctrl;
