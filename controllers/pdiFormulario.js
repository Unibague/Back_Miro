const svc     = require('../services/pdiFormulario');
const { buildUrl, deleteFile } = require('../services/pdiFormularioStorage');
const Respuesta = require('../models/pdiFormularioRespuesta');
const fs = require('fs/promises');
const { uploadFile: uploadDriveFile, deleteFile: deleteDriveFile } = require('../services/pdiDriveStorage');
const { getHierarchyForIndicador } = require('../services/pdiDriveHierarchy');

const ctrl = {};

async function uploadFormularioFileToDrive(file, indicadorId) {
    if (!indicadorId) return null;
    const { jerarquia } = await getHierarchyForIndicador(indicadorId);
    const buffer = await fs.readFile(file.path);
    return uploadDriveFile(buffer, file.originalname, file.mimetype, jerarquia);
}

function applyDriveFileData(base, uploaded) {
    if (!uploaded) return base;
    return {
        ...base,
        url: uploaded.webViewLink || uploaded.webContentLink || base.url,
        drive_file_id: uploaded.fileId,
        drive_web_view_link: uploaded.webViewLink || '',
        drive_web_content_link: uploaded.webContentLink || '',
    };
}

// ── Formularios ────────────────────────────────────────────────────────────

ctrl.getAll = async (req, res) => {
    try {
        const { indicador_id, activo } = req.query;
        const docs = await svc.getAll({
            indicador_id,
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
        const { formulario_id, indicador_id, respondido_por, corte } = req.query;
        const docs = await svc.getRespuestas({ formulario_id, indicador_id, respondido_por, corte });
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
        const { respondido_por, corte, respuestas, estado, indicador_id } = req.body;
        const { doc } = await svc.upsertRespuesta({
            formulario_id: req.params.id,
            indicador_id,
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

// PUT /pdi/formularios/:id/respuestas/:respuestaId/aval
ctrl.avalRespuesta = async (req, res) => {
    try {
        const { estado_aval, aval_por, aval_comentario } = req.body;
        if (!['Aprobado', 'Rechazado'].includes(estado_aval)) {
            return res.status(400).json({ error: 'estado_aval debe ser Aprobado o Rechazado' });
        }
        const doc = await svc.avalRespuesta(req.params.respuestaId, { estado_aval, aval_por, aval_comentario });
        res.json(doc);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

// GET /pdi/formularios/respuestas/lider-email-indicador?indicador_id=xxx
ctrl.getLiderEmailIndicador = async (req, res) => {
    try {
        const { indicador_id } = req.query;
        if (!indicador_id) return res.json({ lider_email: '' });
        const lider_email = await svc.getLiderEmailForIndicador(indicador_id);
        res.json({ lider_email });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

// GET /pdi/formularios/respuestas/por-indicador?indicador_id=xxx
ctrl.getRespuestasPorIndicador = async (req, res) => {
    try {
        const { indicador_id } = req.query;
        if (!indicador_id) return res.json([]);
        const docs = await svc.getRespuestas({ indicador_id });
        res.json(docs);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

// GET /pdi/formularios/respuestas/pendientes-aval?lider_email=xxx
ctrl.getRespuestasPendientesAval = async (req, res) => {
    try {
        const { lider_email } = req.query;
        if (!lider_email) return res.json([]);
        const docs = await svc.getRespuestasPendientesAval(lider_email);
        res.json(docs);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
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
    let uploaded = null;
    try {
        if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo PDF' });

        const doc = await svc.getRespuestaById(req.params.respuestaId);
        if (!doc) {
            deleteFile(req.file.filename);
            return res.status(404).json({ error: 'Respuesta no encontrada' });
        }

        const campoId = req.params.campoId;
        const idx = doc.respuestas.findIndex(r => r.campo_id.toString() === campoId);
        uploaded = await uploadFormularioFileToDrive(req.file, doc.indicador_id);
        if (uploaded) deleteFile(req.file.filename);

        const archivoData = applyDriveFileData({
            nombre_original: req.file.originalname,
            filename:        req.file.filename,
            url:             buildUrl(req.file.filename),
        }, uploaded);

        if (idx >= 0) {
            // Eliminar archivo anterior si existe
            if (doc.respuestas[idx].filename) deleteFile(doc.respuestas[idx].filename);
            await deleteDriveFile(doc.respuestas[idx].drive_file_id);
            doc.respuestas[idx].nombre_original = archivoData.nombre_original;
            doc.respuestas[idx].filename        = archivoData.filename;
            doc.respuestas[idx].url             = archivoData.url;
            doc.respuestas[idx].drive_file_id   = archivoData.drive_file_id || '';
            doc.respuestas[idx].drive_web_view_link = archivoData.drive_web_view_link || '';
            doc.respuestas[idx].drive_web_content_link = archivoData.drive_web_content_link || '';
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
        if (req.file?.filename) deleteFile(req.file.filename);
        if (uploaded?.fileId) await deleteDriveFile(uploaded.fileId);
        res.status(500).json({ error: e.message });
    }
};

// POST /pdi/formularios/:id/respuestas/:respuestaId/documento-final
// Guarda el archivo localmente; se subirá a Drive junto con el Word al dar Enviar
ctrl.uploadDocumentoFinal = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });

        const doc = await Respuesta.findById(req.params.respuestaId);
        if (!doc) {
            deleteFile(req.file.filename);
            return res.status(404).json({ error: 'Respuesta no encontrada' });
        }

        if (doc.estado_aval === 'Aprobado') {
            deleteFile(req.file.filename);
            return res.status(400).json({ error: 'No se puede reemplazar una evidencia aprobada' });
        }

        // Eliminar archivo anterior local (si no está en Drive)
        if (doc.documento_filename && !doc.documento_drive_file_id) deleteFile(doc.documento_filename);
        if (doc.documento_drive_file_id) await deleteDriveFile(doc.documento_drive_file_id);

        const updated = await Respuesta.findByIdAndUpdate(
            req.params.respuestaId,
            {
                documento_filename:              req.file.filename,
                documento_url:                   buildUrl(req.file.filename),
                documento_nombre_original:       req.file.originalname,
                documento_mimetype:              req.file.mimetype,
                documento_size:                  req.file.size || 0,
                documento_drive_file_id:         '',
                documento_drive_web_view_link:   '',
                documento_drive_web_content_link: '',
            },
            { new: true }
        );

        res.status(201).json({
            documento_filename:              updated.documento_filename,
            documento_url:                   updated.documento_url,
            documento_nombre_original:       updated.documento_nombre_original,
            documento_mimetype:              updated.documento_mimetype,
            documento_size:                  updated.documento_size,
            documento_drive_file_id:         updated.documento_drive_file_id,
            documento_drive_web_view_link:   updated.documento_drive_web_view_link,
            documento_drive_web_content_link: updated.documento_drive_web_content_link,
        });
    } catch (e) {
        if (req.file?.filename) deleteFile(req.file.filename);
        res.status(500).json({ error: e.message });
    }
};

// DELETE /pdi/formularios/:id/respuestas/:respuestaId/documento-final
ctrl.deleteDocumentoFinal = async (req, res) => {
    try {
        const doc = await Respuesta.findById(req.params.respuestaId);
        if (!doc) return res.status(404).json({ error: 'Respuesta no encontrada' });
        if (doc.estado_aval === 'Aprobado') {
            return res.status(400).json({ error: 'No se puede eliminar una evidencia aprobada' });
        }
        if (doc.documento_filename) deleteFile(doc.documento_filename);
        await deleteDriveFile(doc.documento_drive_file_id);
        await Respuesta.findByIdAndUpdate(req.params.respuestaId, {
            documento_filename:        '',
            documento_url:             '',
            documento_nombre_original: '',
            documento_mimetype:        '',
            documento_drive_file_id:   '',
            documento_drive_web_view_link: '',
            documento_drive_web_content_link: '',
        });
        res.json({ message: 'Documento eliminado' });
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
        await deleteDriveFile(doc.respuestas[idx].drive_file_id);
        doc.respuestas[idx].filename        = '';
        doc.respuestas[idx].nombre_original = '';
        doc.respuestas[idx].url             = '';
        doc.respuestas[idx].drive_file_id   = '';
        doc.respuestas[idx].drive_web_view_link = '';
        doc.respuestas[idx].drive_web_content_link = '';
        doc.markModified('respuestas');
        await doc.save();
        res.json({ message: 'Archivo eliminado' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

module.exports = ctrl;
