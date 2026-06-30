const svc     = require('../services/pdiFormulario');
const { buildUrl, deleteFile, MAX_FILE_SIZE_BYTES } = require('../services/pdiFormularioStorage');
const Respuesta = require('../models/pdiFormularioRespuesta');
const fs = require('fs/promises');
const { uploadFile: uploadDriveFile, deleteFile: deleteDriveFile } = require('../services/pdiDriveStorage');
const { getHierarchyForIndicador } = require('../services/pdiDriveHierarchy');
const { sendIndicadorUploadNotification } = require('../services/pdiIndicadorUploadNotification');

const ctrl = {};

function fixFilename(originalname) {
    try { return Buffer.from(originalname, 'latin1').toString('utf8'); } catch { return originalname; }
}

async function uploadFormularioFileToDrive(file, indicadorId) {
    if (!indicadorId) return null;
    const { jerarquia } = await getHierarchyForIndicador(indicadorId);
    const buffer = await fs.readFile(file.path);
    return uploadDriveFile(buffer, fixFilename(file.originalname), file.mimetype, jerarquia);
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

function hasLegacyDocumento(doc) {
    return Boolean(doc?.documento_filename || doc?.documento_url || doc?.documento_nombre_original);
}

function buildLegacyDocumento(doc) {
    return {
        nombre_original: doc.documento_nombre_original || '',
        filename: doc.documento_filename || '',
        url: doc.documento_url || '',
        mimetype: doc.documento_mimetype || '',
        size: doc.documento_size || 0,
        drive_file_id: doc.documento_drive_file_id || '',
        drive_web_view_link: doc.documento_drive_web_view_link || '',
        drive_web_content_link: doc.documento_drive_web_content_link || '',
    };
}

function buildDocumentoFromFile(file, driveData) {
    const base = {
        nombre_original: fixFilename(file.originalname),
        filename: file.filename,
        url: buildUrl(file.filename),
        mimetype: file.mimetype,
        size: file.size || 0,
        drive_file_id: '',
        drive_web_view_link: '',
        drive_web_content_link: '',
    };
    return driveData ? applyDriveFileData(base, driveData) : base;
}

function syncLegacyDocumentoFields(doc) {
    const first = doc.documentos?.[0];
    doc.documento_filename = first?.filename || '';
    doc.documento_url = first?.url || '';
    doc.documento_nombre_original = first?.nombre_original || '';
    doc.documento_mimetype = first?.mimetype || '';
    doc.documento_size = first?.size || 0;
    doc.documento_drive_file_id = first?.drive_file_id || '';
    doc.documento_drive_web_view_link = first?.drive_web_view_link || '';
    doc.documento_drive_web_content_link = first?.drive_web_content_link || '';
}

function documentosResponse(doc) {
    const documentos = doc.documentos?.length
        ? doc.documentos.map((item) => (typeof item.toObject === 'function' ? item.toObject() : item))
        : (hasLegacyDocumento(doc) ? [{ _id: 'legacy', ...buildLegacyDocumento(doc) }] : []);
    const first = documentos[0] || {};

    return {
        documento_filename: first.filename || '',
        documento_url: first.url || '',
        documento_nombre_original: first.nombre_original || '',
        documento_mimetype: first.mimetype || '',
        documento_size: first.size || 0,
        documento_drive_file_id: first.drive_file_id || '',
        documento_drive_web_view_link: first.drive_web_view_link || '',
        documento_drive_web_content_link: first.drive_web_content_link || '',
        documentos,
    };
}

function getDocumentosTotalSize(documentos = []) {
    return documentos.reduce((total, documento) => total + (Number(documento?.size) || 0), 0);
}

async function deleteDocumentoData(documento) {
    if (documento?.filename) deleteFile(documento.filename);
    await deleteDriveFile(documento?.drive_file_id);
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

ctrl.upsertRespuesta = async (req, res) => {
    try {
        const { respondido_por, corte, respuestas, estado, indicador_id } = req.body;
        const { doc, justSent } = await svc.upsertRespuesta({
            formulario_id: req.params.id,
            indicador_id,
            respondido_por,
            corte,
            respuestas,
            estado,
        });
        
        if (justSent && doc) {
            try {
                const formulario = await svc.getById(req.params.id);
                
                // Obtener indicador completo - puede venir de indicador_id del body o del documento guardado
                let indicador = null;
                const indicadorIdToFetch = doc.indicador_id || indicador_id;
                
                if (indicadorIdToFetch) {
                    const Indicador = require('../models/pdiIndicador');
                    indicador = await Indicador.findById(indicadorIdToFetch).lean();
                    console.log('[UPSERT-RESPUESTA] Indicador obtenido:', {
                        id: indicadorIdToFetch,
                        codigo: indicador?.codigo,
                        nombre: indicador?.nombre,
                        indicadorCompleto: indicador
                    });
                } else {
                    console.warn('[UPSERT-RESPUESTA] No hay indicador_id disponible');
                }
                
                await sendIndicadorUploadNotification(doc, formulario, indicador);
            } catch (notifyErr) {
                console.error('[UPSERT-RESPUESTA] Error enviando notificación:', notifyErr.message);
            }
        }
        
        res.status(200).json(doc);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.avalRespuesta = async (req, res) => {
    try {
        const { estado_aval, aval_por, aval_comentario, aval_razones, aval_otro_cual, comentarios_campos } = req.body;
        if (!['Aprobado', 'Rechazado'].includes(estado_aval)) {
            return res.status(400).json({ error: 'estado_aval debe ser Aprobado o Rechazado' });
        }
        const doc = await svc.avalRespuesta(req.params.respuestaId, {
            estado_aval,
            aval_por,
            aval_comentario,
            aval_razones,
            aval_otro_cual,
            comentarios_campos,
        });
        res.json(doc);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.marcarComentarioCampoResuelto = async (req, res) => {
    try {
        const { resuelto } = req.body;
        const doc = await svc.marcarComentarioCampoResuelto(
            req.params.respuestaId,
            req.params.campoId,
            resuelto
        );
        res.json(doc);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.avalPlaneacion = async (req, res) => {
    try {
        const { estado, por, comentario } = req.body;
        if (!['Validado', 'Devuelto'].includes(estado)) {
            return res.status(400).json({ error: 'estado debe ser Validado o Devuelto' });
        }
        const doc = await svc.avalPlaneacion(req.params.respuestaId, { estado, por, comentario });
        res.json(doc);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

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

ctrl.getRespuestasPendientesPlaneacion = async (req, res) => {
    try {
        const docs = await svc.getRespuestasPendientesPlaneacion();
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

ctrl.uploadDocumentoFinal = async (req, res) => {
    const files = req.files?.length ? req.files : (req.file ? [req.file] : []);
    try {
        if (!files.length) return res.status(400).json({ error: 'No se recibio ningun archivo' });

        const doc = await Respuesta.findById(req.params.respuestaId);
        if (!doc) {
            files.forEach((file) => deleteFile(file.filename));
            return res.status(404).json({ error: 'Respuesta no encontrada' });
        }

        if (doc.estado_aval === 'Aprobado') {
            files.forEach((file) => deleteFile(file.filename));
            return res.status(400).json({ error: 'No se puede reemplazar una evidencia aprobada' });
        }

        const documentosConservados = doc.estado_aval === 'Rechazado'
            ? []
            : (doc.documentos?.length ? doc.documentos : (hasLegacyDocumento(doc) ? [buildLegacyDocumento(doc)] : []));
        const totalActual = getDocumentosTotalSize(documentosConservados);
        const totalNuevo = files.reduce((total, file) => total + (Number(file.size) || 0), 0);
        if (totalActual + totalNuevo > MAX_FILE_SIZE_BYTES) {
            files.forEach((file) => deleteFile(file.filename));
            return res.status(400).json({ error: 'El tamano total de las evidencias cargadas no debe superar los 10 MB.' });
        }

        if (doc.estado_aval === 'Rechazado') {
            if (doc.documentos?.length) {
                for (const documento of doc.documentos) {
                    if (documento.drive_file_id) {
                        try { await deleteDriveFile(documento.drive_file_id); } catch (_) {}
                    }
                    if (documento.filename) deleteFile(documento.filename);
                }
                doc.documentos.splice(0, doc.documentos.length);
            } else if (hasLegacyDocumento(doc)) {
                const legacy = buildLegacyDocumento(doc);
                if (legacy.drive_file_id) {
                    try { await deleteDriveFile(legacy.drive_file_id); } catch (_) {}
                }
                if (legacy.filename) deleteFile(legacy.filename);
            }
            if (doc.word_drive_file_id) {
                try { await deleteDriveFile(doc.word_drive_file_id); } catch (_) {}
            }
            if (doc.word_filename) deleteFile(doc.word_filename);
            doc.word_filename = '';
            doc.word_url = '';
            doc.word_nombre_original = '';
            doc.word_drive_file_id = '';
            doc.word_drive_web_view_link = '';
            doc.word_drive_web_content_link = '';
        } else if (!doc.documentos?.length && hasLegacyDocumento(doc)) {
            doc.documentos.push(buildLegacyDocumento(doc));
        }

        for (const file of files) {
            let driveData = null;
            try {
                driveData = await uploadFormularioFileToDrive(file, doc.indicador_id);
                if (driveData) deleteFile(file.filename);
            } catch (_) { }
            doc.documentos.push(buildDocumentoFromFile(file, driveData));
        }

        syncLegacyDocumentoFields(doc);
        await doc.save();

        res.status(201).json(documentosResponse(doc));
    } catch (e) {
        files.forEach((file) => deleteFile(file.filename));
        res.status(500).json({ error: e.message });
    }
};

ctrl.deleteDocumentoFinal = async (req, res) => {
    try {
        const doc = await Respuesta.findById(req.params.respuestaId);
        if (!doc) return res.status(404).json({ error: 'Respuesta no encontrada' });
        if (doc.estado_aval === 'Aprobado') {
            return res.status(400).json({ error: 'No se puede eliminar una evidencia aprobada' });
        }

        const { documentoId } = req.query;

        if (documentoId && documentoId !== 'legacy') {
            const documento = doc.documentos.id(documentoId);
            if (!documento) return res.status(404).json({ error: 'Documento no encontrado' });
            await deleteDocumentoData(documento);
            documento.deleteOne();
        } else if (documentoId === 'legacy' && !doc.documentos?.length) {
            await deleteDocumentoData(buildLegacyDocumento(doc));
        } else {
            if (doc.documentos?.length) {
                for (const documento of doc.documentos) {
                    await deleteDocumentoData(documento);
                }
                doc.documentos.splice(0, doc.documentos.length);
            } else if (hasLegacyDocumento(doc)) {
                await deleteDocumentoData(buildLegacyDocumento(doc));
            }
        }

        syncLegacyDocumentoFields(doc);
        await doc.save();
        res.json({ message: 'Documento eliminado', ...documentosResponse(doc) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

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
