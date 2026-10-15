const Formulario      = require('../models/pdiFormulario');
const Respuesta       = require('../models/pdiFormularioRespuesta');
const Indicador       = require('../models/pdiIndicador');
const Accion          = require('../models/pdiAccionEstrategica');
const Proyecto        = require('../models/pdiProyecto');
const Macroproyecto   = require('../models/pdiMacroproyecto');
const RazonRechazo    = require('../models/pdiRazonRechazo');
const fs              = require('fs/promises');
const path            = require('path');
const { deleteFile, UPLOAD_DIR, buildUrl, MAX_FILE_SIZE_BYTES } = require('./pdiFormularioStorage');
const { uploadFile: uploadDriveFile, deleteFile: deleteDriveFile } = require('./pdiDriveStorage');
const { getHierarchyForIndicador, withCorte } = require('./pdiDriveHierarchy');
const { replaceWordDocument } = require('./pdiFormularioWordDocument');
const { getPdiAdminUsers } = require('./pdiAdminRecipients');

// ── Formularios ────────────────────────────────────────────────────────────

const ensureUniqueIndicator = async (indicador_id, excludeId = null) => {
    if (!indicador_id) {
        return;
    }

    const query = { indicador_id };
    if (excludeId) query._id = { $ne: excludeId };

    const existing = await Formulario.findOne(query).select('_id');
    if (existing) {
        throw new Error('Ya existe un formulario para este indicador');
    }
};

const normalizeAvalRazones = async (razones = []) => {
    const values = Array.isArray(razones)
        ? razones.map((value) => String(value ?? '').trim()).filter(Boolean)
        : [];

    const ids = values.filter((value) => /^[a-f0-9]{24}$/i.test(value));
    if (ids.length === 0) return values;

    const docs = await RazonRechazo.find({ _id: { $in: ids } }).select('texto').lean();
    const labelsById = new Map(docs.map((doc) => [String(doc._id), doc.texto]));

    return values.map((value) => labelsById.get(value) ?? value);
};

const normalizeComentariosCampos = (comentarios = []) => {
    const entries = Array.isArray(comentarios)
        ? comentarios.map((item) => [item?.campo_id, item?.comentario_lider])
        : Object.entries(comentarios ?? {});

    return new Map(
        entries
            .map(([campoId, comentario]) => [
                String(campoId ?? '').trim(),
                String(comentario ?? '').trim(),
            ])
            .filter(([campoId, comentario]) => campoId && comentario)
    );
};

const mergeComentariosLider = (respuestas = [], existingRespuestas = []) => {
    const existingByCampo = new Map(
        existingRespuestas.map((respuesta) => [String(respuesta.campo_id ?? ''), respuesta])
    );

    return respuestas.map((respuesta) => {
        const campoPrevio = existingByCampo.get(String(respuesta.campo_id ?? ''));
        return {
            ...respuesta,
            comentario_lider: respuesta.comentario_lider ?? campoPrevio?.comentario_lider ?? '',
            comentario_lider_resuelto: respuesta.comentario_lider_resuelto ?? campoPrevio?.comentario_lider_resuelto ?? false,
        };
    });
};

const getAll = async ({ indicador_id, activo } = {}) => {
    const query = {};
    if (indicador_id) {
        query.$or = [
            { indicador_id },
            { alcance: 'general' },
        ];
    }
    if (activo !== undefined) query.activo = activo;
    return Formulario.find(query)
        .populate('indicador_id', 'codigo nombre')
        .sort({ createdAt: -1 });
};

const getById = async (id) => {
    return Formulario.findById(id)
        .populate('indicador_id', 'codigo nombre');
};

const create = async (data) => {
    const payload = { ...data };
    payload.activo = true;
    payload.alcance = 'general';
    payload.indicador_id = null;
    const doc = await Formulario.create(payload);
    return Formulario.findById(doc._id)
        .populate('indicador_id', 'codigo nombre');
};

const update = async (id, data) => {
    const payload = {
        ...data,
        activo: true,
        alcance: 'general',
        indicador_id: null,
    };
    return Formulario.findByIdAndUpdate(id, payload, { new: true, runValidators: true })
        .populate('indicador_id', 'codigo nombre');
};

const remove = async (id) => {
    const respuestas = await Respuesta.find({ formulario_id: id });
    for (const r of respuestas) {
        for (const resp of r.respuestas) {
            if (resp.filename) deleteFile(resp.filename);
            if (resp.drive_file_id) await deleteDriveFile(resp.drive_file_id);
        }
        if (r.word_filename) deleteFile(r.word_filename);
        if (r.word_drive_file_id) await deleteDriveFile(r.word_drive_file_id);
        if (r.documentos?.length) {
            for (const documento of r.documentos) {
                if (documento.filename) deleteFile(documento.filename);
                if (documento.drive_file_id) await deleteDriveFile(documento.drive_file_id);
            }
        } else {
            if (r.documento_filename) deleteFile(r.documento_filename);
            if (r.documento_drive_file_id) await deleteDriveFile(r.documento_drive_file_id);
        }
    }
    await Respuesta.deleteMany({ formulario_id: id });
    return Formulario.findByIdAndDelete(id);
};

// ── Helpers ────────────────────────────────────────────────────────────────

// Sube el documento de evidencia a Drive (solo al momento de enviar)
const hasLegacyDocumento = (doc) =>
    Boolean(doc?.documento_filename || doc?.documento_url || doc?.documento_nombre_original);

const buildLegacyDocumento = (doc) => ({
    nombre_original: doc.documento_nombre_original || '',
    filename: doc.documento_filename || '',
    url: doc.documento_url || '',
    mimetype: doc.documento_mimetype || '',
    size: doc.documento_size || 0,
    drive_file_id: doc.documento_drive_file_id || '',
    drive_web_view_link: doc.documento_drive_web_view_link || '',
    drive_web_content_link: doc.documento_drive_web_content_link || '',
});

const getDocumentosTotalSize = (documentos = []) =>
    documentos.reduce((total, documento) => total + (Number(documento?.size) || 0), 0);

const getRefId = (value) => {
    if (!value) return '';
    if (typeof value === 'object') {
        if (value._id) return String(value._id);
        if (typeof value.toString === 'function') return value.toString();
        return String(value.id ?? '');
    }
    return String(value);
};

const normalizeEmail = (value = '') => String(value || '').toLowerCase().trim();
const escapeRegExp = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildEvaluacionUrl = ({ indicadorId, formularioId, respuestaId, modo }) => {
    const params = new URLSearchParams();
    if (indicadorId) params.set('indicador_id', indicadorId);
    if (formularioId) params.set('formulario_id', formularioId);
    if (respuestaId) params.set('respuesta_id', respuestaId);
    if (modo) params.set('modo', modo);

    const query = params.toString();
    return `/pdi/mis-indicadores${query ? `?${query}` : ''}`;
};

const withEvaluacionNavigation = (doc, modo = 'planeacion') => {
    const base = typeof doc?.toObject === 'function' ? doc.toObject() : doc;
    const indicadorId = getRefId(base?.indicador_id);
    const formularioId = getRefId(base?.formulario_id);
    const respuestaId = getRefId(base?._id);

    return {
        ...base,
        respuesta_id: respuestaId,
        indicador_id_ref: indicadorId,
        formulario_id_ref: formularioId,
        evaluacion_url: buildEvaluacionUrl({ indicadorId, formularioId, respuestaId, modo }),
    };
};

const syncLegacyDocumentoFields = (doc) => {
    const first = doc.documentos?.[0];
    doc.documento_filename = first?.filename || '';
    doc.documento_url = first?.url || '';
    doc.documento_nombre_original = first?.nombre_original || '';
    doc.documento_mimetype = first?.mimetype || '';
    doc.documento_size = first?.size || 0;
    doc.documento_drive_file_id = first?.drive_file_id || '';
    doc.documento_drive_web_view_link = first?.drive_web_view_link || '';
    doc.documento_drive_web_content_link = first?.drive_web_content_link || '';
};

const uploadDocumentoARespuesta = async (doc) => {
    if (!doc.documentos?.length && hasLegacyDocumento(doc)) {
        doc.documentos.push(buildLegacyDocumento(doc));
    }
    if (!doc.documentos?.length) return [];

    const { jerarquia } = await getHierarchyForIndicador(doc.indicador_id);
    const uploadedFiles = [];

    for (const documento of doc.documentos) {
        if (!documento.filename || documento.drive_file_id) continue;
        const filePath = path.join(UPLOAD_DIR, documento.filename);
        let buffer;
        try { buffer = await fs.readFile(filePath); } catch { continue; }

        const uploaded = await uploadDriveFile(
            buffer,
            documento.nombre_original || documento.filename,
            documento.mimetype || 'application/pdf',
            withCorte(jerarquia, doc.corte)
        );

        documento.drive_file_id = uploaded.fileId;
        documento.url = uploaded.webViewLink || uploaded.webContentLink || '';
        documento.drive_web_view_link = uploaded.webViewLink || '';
        documento.drive_web_content_link = uploaded.webContentLink || '';
        uploadedFiles.push({ documentoId: String(documento._id), ...uploaded });
    }

    syncLegacyDocumentoFields(doc);
    await doc.save();
    return uploadedFiles;
};

const rollbackDocumentosSubidos = async (respuestaId, uploadedFiles = []) => {
    const files = Array.isArray(uploadedFiles) ? uploadedFiles : [];
    if (!files.length) return;

    const doc = await Respuesta.findById(respuestaId);
    if (doc?.documentos?.length) {
        const uploadedIds = new Set(files.map((item) => item.documentoId));
        for (const documento of doc.documentos) {
            if (!uploadedIds.has(String(documento._id))) continue;
            documento.drive_file_id = '';
            documento.url = documento.filename ? buildUrl(documento.filename) : '';
            documento.drive_web_view_link = '';
            documento.drive_web_content_link = '';
        }
        syncLegacyDocumentoFields(doc);
        await doc.save();
    }

    for (const uploaded of files) {
        if (uploaded.fileId) deleteDriveFile(uploaded.fileId).catch(() => {});
    }
};

const getLiderEmailForIndicador = async (indicador_id) => {
    const indicadorId = getRefId(indicador_id);
    if (!indicadorId) return '';
    try {
        const ind = await Indicador.findById(indicadorId).select('accion_id');
        if (!ind?.accion_id) return '';
        const acc = await Accion.findById(ind.accion_id).select('proyecto_id');
        if (!acc?.proyecto_id) return '';
        const proy = await Proyecto.findById(acc.proyecto_id).select('macroproyecto_id');
        if (!proy?.macroproyecto_id) return '';
        const macro = await Macroproyecto.findById(proy.macroproyecto_id).select('lider_email lideres');
        
        // Soporte para múltiples líderes
        if (macro?.lideres && Array.isArray(macro.lideres) && macro.lideres.length > 0) {
            return normalizeEmail(macro.lideres[0].email);
        }
        // Fallback a lider_email antiguo
        return normalizeEmail(macro?.lider_email);
    } catch {
        return '';
    }
}

// Nueva función para obtener todos los líderes de un indicador
const getLideresEmailsForIndicador = async (indicador_id) => {
    const indicadorId = getRefId(indicador_id);
    if (!indicadorId) return [];
    try {
        const ind = await Indicador.findById(indicadorId).select('accion_id');
        if (!ind?.accion_id) return [];
        const acc = await Accion.findById(ind.accion_id).select('proyecto_id');
        if (!acc?.proyecto_id) return [];
        const proy = await Proyecto.findById(acc.proyecto_id).select('macroproyecto_id');
        if (!proy?.macroproyecto_id) return [];
        const macro = await Macroproyecto.findById(proy.macroproyecto_id).select('lider_email lideres');
        
        // Soporte para múltiples líderes
        if (macro?.lideres && Array.isArray(macro.lideres) && macro.lideres.length > 0) {
            return macro.lideres
                .map(l => normalizeEmail(l.email))
                .filter(email => email.length > 0);
        }
        // Fallback a lider_email antiguo
        const singleEmail = normalizeEmail(macro?.lider_email);
        return singleEmail ? [singleEmail] : [];
    } catch {
        return [];
    }
};

// Obtiene los emails de todos los responsables asignados a un proyecto (array nuevo, con fallback legacy)
const getResponsablesEmailsForProyecto = async (proyecto_id) => {
    const proyectoId = getRefId(proyecto_id);
    if (!proyectoId) return [];
    try {
        const proy = await Proyecto.findById(proyectoId).select('responsable_email responsables');
        if (!proy) return [];
        if (Array.isArray(proy.responsables) && proy.responsables.length > 0) {
            return proy.responsables
                .map(r => normalizeEmail(r.email))
                .filter(email => email.length > 0);
        }
        const singleEmail = normalizeEmail(proy.responsable_email);
        return singleEmail ? [singleEmail] : [];
    } catch {
        return [];
    }
};

// Obtiene los emails de los responsables asignados directamente a una Acción Estratégica
// (array nuevo, con fallback legacy al campo único responsable_email)
const getResponsablesEmailsForAccion = async (accion_id) => {
    const accionId = getRefId(accion_id);
    if (!accionId) return [];
    try {
        const acc = await Accion.findById(accionId).select('responsable_email responsables');
        if (!acc) return [];
        if (Array.isArray(acc.responsables) && acc.responsables.length > 0) {
            return acc.responsables
                .map(r => normalizeEmail(r.email))
                .filter(email => email.length > 0);
        }
        const singleEmail = normalizeEmail(acc.responsable_email);
        return singleEmail ? [singleEmail] : [];
    } catch {
        return [];
    }
};

// Igual que getLiderEmailForIndicador, pero para el responsable del proyecto (nuevo primer nivel)
const getResponsableProyectoEmailForIndicador = async (indicador_id) => {
    const emails = await getResponsablesEmailsForProyectoOfIndicador(indicador_id);
    return emails[0] || '';
};

// Sube del indicador hasta su proyecto y devuelve los emails de los responsables de ese proyecto
const getResponsablesEmailsForProyectoOfIndicador = async (indicador_id) => {
    const indicadorId = getRefId(indicador_id);
    if (!indicadorId) return [];
    try {
        const ind = await Indicador.findById(indicadorId).select('accion_id');
        if (!ind?.accion_id) return [];
        const acc = await Accion.findById(ind.accion_id).select('proyecto_id');
        if (!acc?.proyecto_id) return [];
        return getResponsablesEmailsForProyecto(acc.proyecto_id);
    } catch {
        return [];
    }
};

// Emails habilitados para REPORTAR un indicador: responsables de la Acción Estratégica;
// si la acción todavía no tiene responsables asignados, se usa como respaldo el/los
// responsable(s) del proyecto (comportamiento previo, para no bloquear a nadie).
const getReportersEmailsForIndicador = async (indicador_id) => {
    const indicadorId = getRefId(indicador_id);
    if (!indicadorId) return [];
    try {
        const ind = await Indicador.findById(indicadorId).select('accion_id');
        if (!ind?.accion_id) return [];
        const accionEmails = await getResponsablesEmailsForAccion(ind.accion_id);
        if (accionEmails.length > 0) return accionEmails;
        const acc = await Accion.findById(ind.accion_id).select('proyecto_id');
        if (!acc?.proyecto_id) return [];
        return getResponsablesEmailsForProyecto(acc.proyecto_id);
    } catch {
        return [];
    }
};

// ── Notificaciones del flujo de aval ───────────────────────────────────────

const NIVEL_LABEL = {
    proyecto: 'el responsable del proyecto',
    lider: 'el líder del macroproyecto',
    planeacion: 'Planeación',
};

// Solo administradores con el perfil PDI (Planeación), no todos los administradores
const { getPdiAdminEmails: getAdminEmails } = require('./pdiAdminRecipients');

const getIndicadorConAccion = async (indicador_id) => {
    const indicadorId = getRefId(indicador_id);
    if (!indicadorId) return { indicador: null, accion: null };
    const indicador = await Indicador.findById(indicadorId).select('codigo nombre accion_id').lean();
    const accion = indicador?.accion_id
        ? await Accion.findById(indicador.accion_id).select('codigo nombre').lean()
        : null;
    return { indicador, accion };
};

const buildMotivo = (razones = [], otroCual = '') =>
    (razones || []).map((r) => (r === 'Otro' && otroCual ? `Otro: ${otroCual}` : r)).filter(Boolean);

// Avisa a todos los involucrados que un reporte fue devuelto para correcciones:
// quien reportó, responsables de la acción, responsables del proyecto, líderes del
// macroproyecto (siempre) y, si el reporte ya había llegado a Planeación, también
// a los administradores.
const notificarDevolucion = async (doc, { nivel, por, comentario, razones = [], incluirAdmins = false, titulo, intro }) => {
    try {
        const { indicador, accion } = await getIndicadorConAccion(doc.indicador_id);
        const [lideres, proyecto, accionEmails, admins] = await Promise.all([
            getLideresEmailsForIndicador(doc.indicador_id),
            getResponsablesEmailsForProyectoOfIndicador(doc.indicador_id),
            accion?._id ? getResponsablesEmailsForAccion(accion._id) : [],
            incluirAdmins ? getAdminEmails() : [],
        ]);
        const { sendRespuestaEstadoNotification } = require('./pdiRespuestaNotification');
        await sendRespuestaEstadoNotification({
            recipients: [doc.respondido_por, ...accionEmails, ...proyecto, ...lideres, ...admins],
            subject: `${titulo || 'Reporte devuelto'}: ${accion?.codigo || indicador?.codigo || 'PDI'} - ${doc.corte}`,
            headerTitle: titulo || 'Reporte devuelto para correcciones',
            introText: intro || `${NIVEL_LABEL[nivel] ? NIVEL_LABEL[nivel].charAt(0).toUpperCase() + NIVEL_LABEL[nivel].slice(1) : 'El evaluador'} devolvió el reporte de avance. El responsable de la acción debe realizar las correcciones y reenviarlo.`,
            statusLabel: 'DEVUELTO',
            statusColor: '#dc2626',
            indicador,
            accion,
            corte: doc.corte,
            respondidoPor: doc.respondido_por,
            evaluadoPor: por,
            razones,
            comentario: comentario || '',
            comentarioLabel: 'Observaciones',
        });
    } catch (e) {
        console.error('[notificarDevolucion] Error:', e.message);
    }
};

// Avisa a los evaluadores del nivel indicado que tienen un reporte pendiente.
const notificarPendienteEvaluacion = async (doc, nivel, { titulo, intro } = {}) => {
    try {
        const recipients = nivel === 'proyecto'
            ? await getResponsablesEmailsForProyectoOfIndicador(doc.indicador_id)
            : nivel === 'lider'
                ? await getLideresEmailsForIndicador(doc.indicador_id)
                : await getAdminEmails();
        const filtrados = recipients.filter((email) => email !== normalizeEmail(doc.respondido_por));
        if (!filtrados.length) return;

        const { indicador, accion } = await getIndicadorConAccion(doc.indicador_id);
        const { sendRespuestaEstadoNotification } = require('./pdiRespuestaNotification');
        await sendRespuestaEstadoNotification({
            recipients: filtrados,
            subject: `[REVISIÓN] ${titulo || 'Reporte pendiente de evaluación'}: ${indicador?.codigo || 'PDI'} - ${doc.corte}`,
            headerTitle: titulo || 'Reporte pendiente de su evaluación',
            introText: intro || 'Se registró información de avance que requiere su revisión. Ingrese a la plataforma para aprobarla o devolverla con observaciones.',
            statusLabel: 'PENDIENTE',
            statusColor: '#f59e0b',
            indicador,
            accion,
            corte: doc.corte,
            respondidoPor: doc.respondido_por,
        });
    } catch (e) {
        console.error('[notificarPendienteEvaluacion] Error:', e.message);
    }
};

// ── Respuestas ─────────────────────────────────────────────────────────────

const ensureWordDocumentIfSent = async (respuestaDoc) => {
    if (!respuestaDoc || respuestaDoc.estado !== 'Enviado') return respuestaDoc;

    const populated = await Respuesta.findById(respuestaDoc._id)
        .populate('formulario_id', 'nombre')
        .populate('indicador_id', 'codigo nombre');

    if (!populated) return respuestaDoc;

    const formularioNombre = typeof populated.formulario_id === 'object'
        ? populated.formulario_id?.nombre
        : 'Formulario de evidencias';
    const indicadorNombre = typeof populated.indicador_id === 'object'
        ? populated.indicador_id?.nombre
        : '';
    const indicadorCodigo = typeof populated.indicador_id === 'object'
        ? populated.indicador_id?.codigo
        : '';

    await replaceWordDocument({
        respuesta: populated,
        formularioNombre,
        indicadorNombre,
        indicadorCodigo,
    });

    return Respuesta.findById(respuestaDoc._id)
        .populate('formulario_id', 'nombre campos')
        .populate('indicador_id', 'codigo nombre');
};

const hydrateWordDocuments = async (docs) => {
    const list = Array.isArray(docs) ? docs : [docs].filter(Boolean);
    const hydrated = [];

    for (const doc of list) {
        if (doc?.estado === 'Enviado' && !doc.word_url) {
            const refreshed = await ensureWordDocumentIfSent(doc);
            hydrated.push(refreshed ?? doc);
        } else {
            hydrated.push(doc);
        }
    }

    return Array.isArray(docs) ? hydrated : (hydrated[0] ?? null);
};

// El borrador/reporte es compartido por (formulario_id, indicador_id, corte); respondido_por
// ya no filtra la busqueda (queda ignorado a proposito para no depender de que el cliente no lo mande).
const getRespuestas = async ({ formulario_id, indicador_id, corte } = {}) => {
    const query = {};
    if (formulario_id)  query.formulario_id  = formulario_id;
    if (indicador_id)   query.indicador_id   = indicador_id;
    if (corte)          query.corte          = corte;
    const docs = await Respuesta.find(query)
        .populate('formulario_id', 'nombre campos')
        .populate('indicador_id', 'codigo nombre')
        .sort({ createdAt: -1 });
    await autoApproveLeaderSubmittedResponses(docs);
    return hydrateWordDocuments(docs);
};

const getRespuestaById = async (id) => {
    const doc = await Respuesta.findById(id)
        .populate('formulario_id', 'nombre campos')
        .populate('indicador_id', 'codigo nombre');
    await autoApproveLeaderSubmittedResponses(doc);
    return hydrateWordDocuments(doc);
};

const normalizePeriodo = (value) => String(value ?? '').trim().toUpperCase();

const PLANEACION_EVALUATED_STATES = ['Validado', 'Devuelto'];

const buildIndicadorCorteKey = (indicadorId, corte) =>
    `${String(indicadorId || '')}::${normalizePeriodo(corte)}`;

const getRespuestaIndicadorId = (doc) => getRefId(doc?.indicador_id);

const filterOutPlaneacionEvaluatedReports = async (docs = []) => {
    if (!docs.length) return docs;

    const indicadorIds = [...new Set(docs.map(getRespuestaIndicadorId).filter(Boolean))];
    if (!indicadorIds.length) return docs;

    const evaluatedDocs = await Respuesta.find({
        indicador_id: { $in: indicadorIds },
        aval_planeacion: { $in: PLANEACION_EVALUATED_STATES },
    }).select('indicador_id corte aval_planeacion').lean();

    const evaluatedKeys = new Set(
        evaluatedDocs.map((doc) => buildIndicadorCorteKey(doc.indicador_id, doc.corte))
    );

    return docs.filter((doc) => (
        !evaluatedKeys.has(buildIndicadorCorteKey(getRespuestaIndicadorId(doc), doc.corte))
    ));
};

const syncPeriodoReporte = async ({
    indicador_id,
    corte,
    estado_reporte,
    reportado_por,
    fecha_envio,
}) => {
    if (!indicador_id || !corte) return;

    const indicador = await Indicador.findById(indicador_id);
    if (!indicador) return;

    let idx = (indicador.periodos ?? []).findIndex(
        (p) => normalizePeriodo(p.periodo) === normalizePeriodo(corte)
    );

    if (idx < 0) {
        indicador.periodos = indicador.periodos ?? [];
        indicador.periodos.push({ periodo: normalizePeriodo(corte) });
        idx = indicador.periodos.length - 1;
    }

    if (estado_reporte) indicador.periodos[idx].estado_reporte = estado_reporte;
    if (reportado_por !== undefined) indicador.periodos[idx].reportado_por = reportado_por;
    if (fecha_envio !== undefined) indicador.periodos[idx].fecha_envio = fecha_envio;

    await indicador.save();
};

const isResponderLeaderForIndicador = async (indicadorId, email) => {
    const responderEmail = normalizeEmail(email);
    if (!indicadorId || !responderEmail) return false;

    const lideresEmails = await getLideresEmailsForIndicador(indicadorId);
    return lideresEmails.includes(responderEmail);
};

const isResponderProyectoResponsableForIndicador = async (indicadorId, email) => {
    const responderEmail = normalizeEmail(email);
    if (!indicadorId || !responderEmail) return false;

    const proyectoEmails = await getResponsablesEmailsForProyectoOfIndicador(indicadorId);
    return proyectoEmails.includes(responderEmail);
};

// Calcula el estado del aval del líder de macroproyecto una vez el nivel de
// proyecto ya quedó Aprobado. No guarda el documento, solo lo deja listo.
const applyMacroAvalAfterProyectoApproval = async (doc) => {
    const indicadorId = getRefId(doc.indicador_id);
    // Importante: solo se usan los líderes REALES configurados actualmente en el
    // macroproyecto. No se debe mezclar aquí el `doc.lider_email_aval` guardado
    // previamente, porque ese valor puede haber quedado con el email de quien
    // reportó (aprobación automática de un envío anterior, cuando aún no había
    // líder configurado) y "contaminaría" esta comprobación en los siguientes
    // recálculos, saltándose al líder real aunque ya esté asignado.
    const lideresEmails = await getLideresEmailsForIndicador(indicadorId);
    const responderEmail = normalizeEmail(doc.respondido_por);
    const liderEmail = lideresEmails[0] || '';

    if (!liderEmail || lideresEmails.includes(responderEmail)) {
        // Sin líder configurado, o el mismo responsable de proyecto es el líder → aprobación automática
        doc.lider_email_aval = responderEmail || liderEmail || '';
        doc.estado_aval = 'Aprobado';
        doc.aval_por = doc.aval_por || doc.respondido_por;
        doc.aval_comentario = '';
        doc.aval_fecha = doc.aval_fecha || new Date();
        doc.aval_planeacion = doc.aval_planeacion || 'Pendiente';
        doc.aval_planeacion_por = '';
        doc.aval_planeacion_comentario = '';
        doc.aval_planeacion_fecha = null;
    } else {
        doc.lider_email_aval = liderEmail;
        doc.estado_aval = 'Pendiente';
        doc.aval_por = '';
        doc.aval_comentario = '';
        doc.aval_fecha = null;
        doc.aval_planeacion = null;
        doc.aval_planeacion_por = '';
        doc.aval_planeacion_comentario = '';
        doc.aval_planeacion_fecha = null;
    }
};

const autoApproveProyectoIfResponderIsResponsable = async (doc) => {
    if (!doc || doc.estado !== 'Enviado') return false;
    if (doc.estado_aval_proyecto !== 'Pendiente' && doc.estado_aval_proyecto != null) return false;
    if (PLANEACION_EVALUATED_STATES.includes(doc.aval_planeacion)) return false;

    const responderEmail = normalizeEmail(doc.respondido_por);
    const indicadorId = getRefId(doc.indicador_id);
    const isResponsable = await isResponderProyectoResponsableForIndicador(indicadorId, responderEmail);
    if (!isResponsable) return false;

    doc.proyecto_email_aval = responderEmail;
    doc.estado_aval_proyecto = 'Aprobado';
    doc.aval_proyecto_por = doc.aval_proyecto_por || doc.respondido_por || responderEmail;
    doc.aval_proyecto_comentario = '';
    doc.aval_proyecto_fecha = doc.aval_proyecto_fecha || new Date();

    await applyMacroAvalAfterProyectoApproval(doc);
    await doc.save();

    await syncPeriodoReporte({
        indicador_id: indicadorId,
        corte: doc.corte,
        estado_reporte: doc.estado_aval === 'Aprobado' ? 'Aprobado' : 'Enviado',
        reportado_por: doc.respondido_por,
        fecha_envio: doc.fecha_envio ?? new Date(),
    });

    return true;
};

const autoApproveIfResponderIsLeader = async (doc) => {
    if (!doc || doc.estado !== 'Enviado') return false;
    // El nivel de proyecto debe estar aprobado antes de que aplique el nivel de macro
    // (los documentos legacy, sin este campo, pasan de largo por compatibilidad).
    if (doc.estado_aval_proyecto && doc.estado_aval_proyecto !== 'Aprobado') return false;
    if (doc.estado_aval !== 'Pendiente' && doc.estado_aval != null) return false;
    if (PLANEACION_EVALUATED_STATES.includes(doc.aval_planeacion)) return false;

    const responderEmail = normalizeEmail(doc.respondido_por);
    const indicadorId = getRefId(doc.indicador_id);
    const isLeader = await isResponderLeaderForIndicador(indicadorId, responderEmail);
    if (!isLeader) return false;

    doc.lider_email_aval = responderEmail;
    doc.estado_aval = 'Aprobado';
    doc.aval_por = doc.aval_por || doc.respondido_por || responderEmail;
    doc.aval_comentario = '';
    doc.aval_fecha = doc.aval_fecha || new Date();
    doc.aval_planeacion = doc.aval_planeacion || 'Pendiente';
    doc.aval_planeacion_por = '';
    doc.aval_planeacion_comentario = '';
    doc.aval_planeacion_fecha = null;
    await doc.save();

    await syncPeriodoReporte({
        indicador_id: indicadorId,
        corte: doc.corte,
        estado_reporte: 'Aprobado',
        reportado_por: doc.respondido_por,
        fecha_envio: doc.fecha_envio ?? new Date(),
    });

    return true;
};

const autoApproveLeaderSubmittedResponses = async (docs = []) => {
    const list = Array.isArray(docs) ? docs : [docs].filter(Boolean);
    for (const doc of list) {
        await autoApproveProyectoIfResponderIsResponsable(doc);
        await autoApproveIfResponderIsLeader(doc);
    }
    return docs;
};

const autoApproveAllPendingLeaderSubmittedResponses = async () => {
    const docs = await Respuesta.find({
        estado: 'Enviado',
        $or: [
            { estado_aval: 'Pendiente' }, { estado_aval: null },
            { estado_aval_proyecto: 'Pendiente' }, { estado_aval_proyecto: null },
        ],
        aval_planeacion: { $nin: PLANEACION_EVALUATED_STATES },
    });
    return autoApproveLeaderSubmittedResponses(docs);
};

const ESTADO_FLUJO_FIELDS = [
    'estado', 'fecha_envio',
    'estado_aval_proyecto', 'proyecto_email_aval', 'aval_proyecto_por', 'aval_proyecto_comentario',
    'aval_proyecto_razones', 'aval_proyecto_otro_cual', 'aval_proyecto_fecha',
    'estado_aval', 'lider_email_aval', 'aval_por', 'aval_comentario', 'aval_razones', 'aval_otro_cual', 'aval_fecha',
    'aval_planeacion', 'aval_planeacion_por', 'aval_planeacion_comentario', 'aval_planeacion_fecha',
];

const getPeriodoSnapshot = async (indicador_id, corte) => {
    const indicador = indicador_id ? await Indicador.findById(indicador_id).select('periodos').lean() : null;
    const periodo = (indicador?.periodos ?? []).find(
        (p) => normalizePeriodo(p.periodo) === normalizePeriodo(corte)
    );
    return {
        estado_reporte: periodo?.estado_reporte || 'Borrador',
        reportado_por: periodo?.reportado_por ?? '',
        fecha_envio: periodo?.fecha_envio ?? null,
    };
};

// Crea o actualiza la respuesta de un responsable para un formulario+corte
const upsertRespuesta = async ({ formulario_id, indicador_id, respondido_por, corte, respuestas, estado }) => {
    // Borrador/reporte compartido: no se filtra por respondido_por, asi cualquier responsable
    // asignado al mismo proyecto encuentra y continua el mismo documento.
    const existing = await Respuesta.findOne({ formulario_id, indicador_id: indicador_id || null, corte });

    const becomingEnviado = estado === 'Enviado';
    const wasAlreadySent  = existing?.estado === 'Enviado';
    const wasRejected = existing?.estado_aval === 'Rechazado' || existing?.estado_aval_proyecto === 'Rechazado';
    let avalData = {};

    if (becomingEnviado && existing) {
        const documentos = existing.documentos?.length
            ? existing.documentos
            : (hasLegacyDocumento(existing) ? [buildLegacyDocumento(existing)] : []);
        if (getDocumentosTotalSize(documentos) > MAX_FILE_SIZE_BYTES) {
            throw new Error('El tamano total de las evidencias cargadas no debe superar los 50 MB.');
        }
    }

    if (becomingEnviado && (!wasAlreadySent || wasRejected)) {
        // Nivel 1: aval del responsable del proyecto (nuevo — antes del líder de macroproyecto)
        const proyectoEmails = [
            ...new Set([
                ...(await getResponsablesEmailsForProyectoOfIndicador(indicador_id)),
                normalizeEmail(existing?.proyecto_email_aval),
            ].filter(Boolean)),
        ];
        const responderEmail = normalizeEmail(respondido_por);
        const proyectoEmail = proyectoEmails[0] || normalizeEmail(existing?.proyecto_email_aval);
        const respondeElMismoResponsableProyecto = proyectoEmail && proyectoEmails.includes(responderEmail);

        if (!proyectoEmail || respondeElMismoResponsableProyecto) {
            // Sin responsable de proyecto configurado, o el mismo responsable de proyecto
            // es quien reporta la acción → aprobación automática de este nivel.
            avalData.proyecto_email_aval = responderEmail || proyectoEmail || '';
            avalData.estado_aval_proyecto = 'Aprobado';
            avalData.aval_proyecto_por = respondido_por;
            avalData.aval_proyecto_comentario = '';
            avalData.aval_proyecto_fecha = new Date();
        } else {
            avalData.proyecto_email_aval = proyectoEmail;
            avalData.estado_aval_proyecto = 'Pendiente';
            avalData.aval_proyecto_por = '';
            avalData.aval_proyecto_comentario = '';
            avalData.aval_proyecto_fecha = null;
        }

        // Nivel 2: aval del líder de macroproyecto — solo se calcula si el nivel 1 ya quedó aprobado
        if (avalData.estado_aval_proyecto === 'Aprobado') {
            const synthetic = {
                indicador_id,
                corte,
                respondido_por,
                lider_email_aval: existing?.lider_email_aval || '',
                aval_por: '',
                aval_fecha: null,
                aval_planeacion: null,
            };
            await applyMacroAvalAfterProyectoApproval(synthetic);
            Object.assign(avalData, {
                lider_email_aval: synthetic.lider_email_aval,
                estado_aval: synthetic.estado_aval,
                aval_por: synthetic.aval_por,
                aval_comentario: synthetic.aval_comentario ?? '',
                aval_fecha: synthetic.aval_fecha,
                aval_planeacion: synthetic.aval_planeacion,
                aval_planeacion_por: synthetic.aval_planeacion_por ?? '',
                aval_planeacion_comentario: synthetic.aval_planeacion_comentario ?? '',
                aval_planeacion_fecha: synthetic.aval_planeacion_fecha ?? null,
            });
        } else {
            avalData.lider_email_aval = existing?.lider_email_aval || '';
            avalData.estado_aval = null;
            avalData.aval_por = '';
            avalData.aval_comentario = '';
            avalData.aval_fecha = null;
            avalData.aval_planeacion = null;
            avalData.aval_planeacion_por = '';
            avalData.aval_planeacion_comentario = '';
            avalData.aval_planeacion_fecha = null;
        }
    }

    if (existing) {
        // Foto completa del estado previo (envío + los tres niveles de aval) para
        // poder restaurarlo tal cual si el envío falla a mitad de camino.
        const prevState = Object.fromEntries(
            ESTADO_FLUJO_FIELDS.map((field) => [field, existing.get(field)])
        );
        const prevPeriodo = await getPeriodoSnapshot(indicador_id, corte);

        existing.respuestas    = respuestas ? mergeComentariosLider(respuestas, existing.respuestas) : existing.respuestas;
        existing.indicador_id  = indicador_id || null;
        existing.respondido_por = respondido_por;
        if (estado) {
            existing.estado = estado;
            if (estado === 'Enviado' && (!existing.fecha_envio || wasRejected)) {
                existing.fecha_envio = new Date();
            }
        }
        Object.assign(existing, avalData);
        await existing.save();
        if (estado === 'Enviado') {
            await syncPeriodoReporte({
                indicador_id,
                corte,
                estado_reporte: avalData.estado_aval === 'Aprobado' ? 'Aprobado' : 'Enviado',
                reportado_por: respondido_por,
                fecha_envio: existing.fecha_envio ?? new Date(),
            });
        }

        let docSubido = null;
        try {
            if (becomingEnviado && (!wasAlreadySent || wasRejected)) {
                docSubido = await uploadDocumentoARespuesta(existing);
            }
            const hydrated = await ensureWordDocumentIfSent(existing);
            return { doc: hydrated, justSent: existing.estado === 'Enviado' && (!wasAlreadySent || wasRejected) };
        } catch (driveErr) {
            // Revertir: el envío falló, dejar todo como estaba
            await rollbackDocumentosSubidos(existing._id, docSubido);
            await Respuesta.findByIdAndUpdate(existing._id, prevState);
            if (estado === 'Enviado') {
                await syncPeriodoReporte({ indicador_id, corte, ...prevPeriodo });
            }
            throw new Error(`No se pudo subir el documento a Google Drive. Verifica la configuración de la carpeta. Detalle: ${driveErr.message}`);
        }
    }

    const created = await Respuesta.create({
        formulario_id,
        indicador_id:  indicador_id || null,
        respondido_por,
        corte:         corte ?? '',
        respuestas:    respuestas ?? [],
        estado:        estado ?? 'Borrador',
        fecha_envio:   estado === 'Enviado' ? new Date() : null,
        ...avalData,
    });
    if (estado === 'Enviado') {
        await syncPeriodoReporte({
            indicador_id,
            corte,
            estado_reporte: avalData.estado_aval === 'Aprobado' ? 'Aprobado' : 'Enviado',
            reportado_por: respondido_por,
            fecha_envio: created.fecha_envio ?? new Date(),
        });
    }

    let docSubidoCreado = null;
    try {
        if (becomingEnviado) {
            docSubidoCreado = await uploadDocumentoARespuesta(created);
        }
        const hydrated = await ensureWordDocumentIfSent(created);
        return { doc: hydrated, justSent: created.estado === 'Enviado' };
    } catch (driveErr) {
        // Revertir: eliminar el documento recién creado y limpiar el periodo
        await Respuesta.findByIdAndDelete(created._id);
        for (const uploaded of (Array.isArray(docSubidoCreado) ? docSubidoCreado : [])) {
            if (uploaded.fileId) deleteDriveFile(uploaded.fileId).catch(() => {});
        }
        if (becomingEnviado) {
            await syncPeriodoReporte({
                indicador_id, corte,
                estado_reporte: 'Borrador',
                reportado_por:  '',
                fecha_envio:    null,
            });
        }
        throw new Error(`No se pudo subir el documento a Google Drive. Verifica la configuración de la carpeta. Detalle: ${driveErr.message}`);
    }
};

const deleteRespuesta = async (id) => {
    const doc = await Respuesta.findById(id);
    if (!doc) return null;
    for (const r of doc.respuestas) {
        if (r.filename) deleteFile(r.filename);
        if (r.drive_file_id) await deleteDriveFile(r.drive_file_id);
    }
    if (doc.word_filename) deleteFile(doc.word_filename);
    if (doc.word_drive_file_id) await deleteDriveFile(doc.word_drive_file_id);
    if (doc.documentos?.length) {
        for (const documento of doc.documentos) {
            if (documento.filename) deleteFile(documento.filename);
            if (documento.drive_file_id) await deleteDriveFile(documento.drive_file_id);
        }
    } else {
        if (doc.documento_filename) deleteFile(doc.documento_filename);
        if (doc.documento_drive_file_id) await deleteDriveFile(doc.documento_drive_file_id);
    }
    return Respuesta.findByIdAndDelete(id);
};

// Aprueba o rechaza una respuesta a nivel de proyecto (nuevo, primer nivel — antes del lider de macroproyecto)
const avalProyecto = async (respuestaId, { estado_aval_proyecto, aval_por, aval_comentario, aval_razones, aval_otro_cual, comentarios_campos }) => {
    const doc = await Respuesta.findById(respuestaId);
    if (!doc) throw new Error('Respuesta no encontrada');
    if (doc.estado !== 'Enviado') throw new Error('Solo se pueden evaluar respuestas enviadas');
    if (doc.estado_aval_proyecto !== 'Pendiente') {
        throw new Error('Esta respuesta no está pendiente de evaluación del responsable del proyecto. Si la aprobaste por error, usa "Deshacer aprobación".');
    }
    const razonesNormalizadas = estado_aval_proyecto === 'Rechazado'
        ? await normalizeAvalRazones(aval_razones)
        : [];
    const comentariosPorCampo = estado_aval_proyecto === 'Rechazado'
        ? normalizeComentariosCampos(comentarios_campos)
        : new Map();
    doc.estado_aval_proyecto     = estado_aval_proyecto;
    doc.aval_proyecto_por        = aval_por ?? '';
    doc.aval_proyecto_comentario = estado_aval_proyecto === 'Rechazado' ? (aval_comentario ?? '') : '';
    doc.aval_proyecto_razones    = razonesNormalizadas;
    doc.aval_proyecto_otro_cual  = estado_aval_proyecto === 'Rechazado' ? (aval_otro_cual ?? '') : '';
    doc.aval_proyecto_fecha      = new Date();
    for (const respuesta of doc.respuestas) {
        const campoId = String(respuesta.campo_id ?? '');
        respuesta.comentario_lider = comentariosPorCampo.get(campoId) ?? '';
        respuesta.comentario_lider_resuelto = false;
    }
    doc.markModified('respuestas');

    if (estado_aval_proyecto === 'Rechazado') {
        // Al rechazar, el responsable de la acción debe corregir y re-enviar
        doc.estado      = 'Borrador';
        doc.fecha_envio = null;
    } else {
        // Aprobado → calcular el siguiente nivel (líder de macroproyecto)
        await applyMacroAvalAfterProyectoApproval(doc);
    }
    await doc.save();

    await syncPeriodoReporte({
        indicador_id: doc.indicador_id,
        corte: doc.corte,
        estado_reporte: estado_aval_proyecto === 'Aprobado'
            ? (doc.estado_aval === 'Aprobado' ? 'Aprobado' : 'Enviado')
            : 'Rechazado',
        reportado_por: doc.respondido_por,
        fecha_envio: doc.fecha_envio ?? new Date(),
    });

    if (estado_aval_proyecto === 'Rechazado') {
        await notificarDevolucion(doc, {
            nivel: 'proyecto',
            por: aval_por,
            comentario: doc.aval_proyecto_comentario,
            razones: buildMotivo(razonesNormalizadas, doc.aval_proyecto_otro_cual),
            titulo: 'Devuelto por el responsable del proyecto',
        });
    } else if (doc.estado_aval === 'Pendiente') {
        await notificarPendienteEvaluacion(doc, 'lider', {
            intro: 'El responsable del proyecto aprobó el avance reportado. Ahora requiere su evaluación como líder del macroproyecto.',
        });
    } else if (doc.estado_aval === 'Aprobado') {
        await notificarPendienteEvaluacion(doc, 'planeacion', {
            titulo: 'Reporte pendiente de validación',
            intro: 'Un reporte de avance fue aprobado y está pendiente de la validación de Planeación.',
        });
    }

    return doc;
};

// Aprueba o rechaza una respuesta (solo el lider del macroproyecto)
const avalRespuesta = async (respuestaId, { estado_aval, aval_por, aval_comentario, aval_razones, aval_otro_cual, comentarios_campos }) => {
    const doc = await Respuesta.findById(respuestaId);
    if (!doc) throw new Error('Respuesta no encontrada');
    if (doc.estado !== 'Enviado') throw new Error('Solo se pueden avalar respuestas enviadas');
    if (doc.estado_aval_proyecto && doc.estado_aval_proyecto !== 'Aprobado') {
        throw new Error('Esta respuesta aún no ha sido aprobada por el responsable del proyecto');
    }
    if (doc.estado_aval && doc.estado_aval !== 'Pendiente') {
        throw new Error('Esta respuesta ya fue evaluada por el líder. Si fue un error, usa "Deshacer aprobación".');
    }
    const razonesNormalizadas = estado_aval === 'Rechazado'
        ? await normalizeAvalRazones(aval_razones)
        : [];
    const comentariosPorCampo = estado_aval === 'Rechazado'
        ? normalizeComentariosCampos(comentarios_campos)
        : new Map();
    doc.estado_aval     = estado_aval;
    doc.aval_por        = aval_por ?? '';
    doc.aval_comentario = estado_aval === 'Rechazado' ? (aval_comentario ?? '') : '';
    doc.aval_razones    = razonesNormalizadas;
    doc.aval_otro_cual  = estado_aval === 'Rechazado' ? (aval_otro_cual ?? '') : '';
    doc.aval_fecha      = new Date();
    doc.aval_planeacion = estado_aval === 'Aprobado' ? 'Pendiente' : null;
    doc.aval_planeacion_por = '';
    doc.aval_planeacion_comentario = '';
    doc.aval_planeacion_fecha = null;
    for (const respuesta of doc.respuestas) {
        const campoId = String(respuesta.campo_id ?? '');
        respuesta.comentario_lider = comentariosPorCampo.get(campoId) ?? '';
        respuesta.comentario_lider_resuelto = false;
    }
    doc.markModified('respuestas');
    // Al rechazar, el responsable debe corregir y re-enviar
    if (estado_aval === 'Rechazado') {
        doc.estado      = 'Borrador';
        doc.fecha_envio = null;
    }
    await doc.save();
    await syncPeriodoReporte({
        indicador_id: doc.indicador_id,
        corte: doc.corte,
        estado_reporte: estado_aval === 'Aprobado' ? 'Aprobado' : 'Rechazado',
        reportado_por: doc.respondido_por,
        fecha_envio: doc.fecha_envio ?? new Date(),
    });

    // Enviar notificaciones según el resultado de la evaluación
    try {
        if (estado_aval === 'Rechazado') {
            await notificarDevolucion(doc, {
                nivel: 'lider',
                por: aval_por,
                comentario: doc.aval_comentario,
                razones: buildMotivo(razonesNormalizadas, doc.aval_otro_cual),
                titulo: 'Devuelto por el líder del macroproyecto',
            });
        } else if (estado_aval === 'Aprobado' && doc.respondido_por) {
            // Enviar notificación de aprobación al responsable + a administradores
            const { sendRespuestaEvaluationNotification, sendRespuestaApprovedToAdmins } = require('./pdiRespuestaNotification');
            
            const PdiIndicador = require('../models/pdiIndicador');
            const Template = require('../models/templates');
            const User = require('../models/users');
            
            const indicador = await PdiIndicador.findById(doc.indicador_id).lean();
            const template = doc.formulario_id ? await Template.findById(doc.formulario_id).lean() : null;
            
            // Notificación al responsable (quien subió la respuesta)
            console.log(`[avalRespuesta] Enviando notificación de aprobación a: ${doc.respondido_por}`);
            await sendRespuestaEvaluationNotification(
              {
                respondido_por: doc.respondido_por,
                corte: doc.corte,
              },
              {
                nombre: template?.nombre || 'Formulario',
              },
              {
                codigo: indicador?.codigo || 'Sin código',
                nombre: indicador?.nombre || 'Sin nombre',
              },
              'Aprobado',
              ''
            );
            console.log(`[avalRespuesta] ✓ Notificación de aprobación enviada al responsable`);
            
            // Notificación a administradores para que evalúen
            try {
              console.log(`[avalRespuesta] Buscando administradores...`);
              
              // Solo administradores con el perfil PDI (Planeación)
              const admins = await getPdiAdminUsers();
              console.log(`[avalRespuesta] Administradores encontrados: ${admins ? admins.length : 0}`);
              
              if (admins && admins.length > 0) {
                const adminEmails = admins.map(admin => admin.email).filter(Boolean);
                console.log(`[avalRespuesta] Emails de administradores: ${adminEmails.join(', ')}`);
                
                if (adminEmails.length > 0) {
                  const liderNombre = aval_por || 'Líder del Macroproyecto';
                  console.log(`[avalRespuesta] Enviando notificación a administradores...`);
                  
                  await sendRespuestaApprovedToAdmins(
                    {
                      corte: doc.corte,
                      respondido_por: doc.respondido_por,
                    },
                    {
                      nombre: template?.nombre || 'Formulario',
                    },
                    {
                      codigo: indicador?.codigo || 'Sin código',
                      nombre: indicador?.nombre || 'Sin nombre',
                    },
                    liderNombre,
                    adminEmails
                  );
                  console.log(`[avalRespuesta] ✓ Notificación de aprobación enviada a administradores: ${adminEmails.join(', ')}`);
                } else {
                  console.warn(`[avalRespuesta] No se encontraron emails válidos de administradores`);
                }
              } else {
                console.warn(`[avalRespuesta] No se encontraron administradores en la base de datos`);
              }
            } catch (adminError) {
              console.error(`[avalRespuesta] Error enviando a administradores:`, adminError.message);
              console.error(`[avalRespuesta] Stack trace:`, adminError.stack);
            }
        }
    } catch (notifyError) {
        console.error('[avalRespuesta] Error al enviar notificación:', notifyError.message);
        // No fallar la operación principal por error en notificación
    }

    return doc;
};

// Evalúa una respuesta como Planeación (segundo nivel, después de aprobación del líder)
const marcarComentarioCampoResuelto = async (respuestaId, campoId, resuelto = false) => {
    const doc = await Respuesta.findById(respuestaId);
    if (!doc) throw new Error('Respuesta no encontrada');

    const idx = doc.respuestas.findIndex((respuesta) => String(respuesta.campo_id) === String(campoId));
    if (idx < 0) throw new Error('Campo no encontrado');
    if (!String(doc.respuestas[idx].comentario_lider ?? '').trim()) {
        throw new Error('El campo no tiene comentario del lider');
    }

    doc.respuestas[idx].comentario_lider_resuelto = Boolean(resuelto);
    doc.markModified('respuestas');
    await doc.save();
    return getRespuestaById(respuestaId);
};

const avalPlaneacion = async (respuestaId, { estado, por, comentario }) => {
    const doc = await Respuesta.findById(respuestaId);
    if (!doc) throw new Error('Respuesta no encontrada');
    // Auto-aprobación si el responsable es el líder y aún no fue aprobado
    if (doc.estado_aval !== 'Aprobado') {
        const autoApproved = await autoApproveIfResponderIsLeader(doc);
        if (!autoApproved) throw new Error('Solo se pueden evaluar respuestas aprobadas por el líder');
    }
    if (!['Validado', 'Devuelto'].includes(estado)) throw new Error('estado debe ser Validado o Devuelto');
    if (PLANEACION_EVALUATED_STATES.includes(doc.aval_planeacion)) {
        throw new Error('Este reporte ya fue evaluado por Planeación. Si fue un error, usa "Deshacer aprobación".');
    }
    doc.aval_planeacion            = estado;
    doc.aval_planeacion_por        = por ?? '';
    doc.aval_planeacion_comentario = comentario ?? '';
    doc.aval_planeacion_fecha      = new Date();
    if (estado === 'Devuelto') {
        doc.estado         = 'Borrador';
        doc.fecha_envio    = null;
        doc.estado_aval    = null;
        doc.aval_razones   = [];
        doc.aval_otro_cual = '';
        await doc.save();
        await syncPeriodoReporte({
            indicador_id:   doc.indicador_id,
            corte:          doc.corte,
            estado_reporte: 'Borrador',
            reportado_por:  '',
            fecha_envio:    null,
        });

        // Cuando Planeación devuelve, deben enterarse: el líder del macroproyecto, el
        // responsable del proyecto y el responsable/líder de la acción (quien reportó).
        await notificarDevolucion(doc, {
            nivel: 'planeacion',
            por,
            comentario,
            titulo: 'Devuelto por Planeación',
            intro: 'Planeación revisó el avance ya aprobado por el líder del macroproyecto y lo devolvió con observaciones. Debe corregirse y reenviarse.',
        });
    } else {
        await doc.save();
        await syncPeriodoReporte({
            indicador_id:   doc.indicador_id,
            corte:          doc.corte,
            estado_reporte: 'Validado',
        });
    }
    return doc;
};

// ── Deshacer aprobación ────────────────────────────────────────────────────

const clearPlaneacion = (doc) => {
    doc.aval_planeacion = null;
    doc.aval_planeacion_por = '';
    doc.aval_planeacion_comentario = '';
    doc.aval_planeacion_fecha = null;
};

const clearAvalLider = (doc) => {
    doc.estado_aval = null;
    doc.aval_por = '';
    doc.aval_comentario = '';
    doc.aval_razones = [];
    doc.aval_otro_cual = '';
    doc.aval_fecha = null;
};

const isAdminEmail = async (email) => {
    const admins = await getAdminEmails();
    return admins.includes(normalizeEmail(email));
};

// Permite a un evaluador deshacer su aprobación aunque el reporte ya haya avanzado
// a los siguientes niveles (por si se equivocó). Las evaluaciones posteriores quedan
// sin efecto. Modos:
//  - 'reabrir':  el reporte vuelve a quedar pendiente de la evaluación de ese nivel.
//  - 'devolver': el reporte regresa al responsable de la acción para correcciones.
const revertirAprobacion = async (respuestaId, { nivel, modo, por, motivo }) => {
    if (!['proyecto', 'lider', 'planeacion'].includes(nivel)) {
        throw new Error('nivel debe ser proyecto, lider o planeacion');
    }
    if (!['reabrir', 'devolver'].includes(modo)) throw new Error('modo debe ser reabrir o devolver');
    const motivoTexto = String(motivo ?? '').trim();
    if (!motivoTexto) throw new Error('Debes indicar el motivo por el que deshaces la aprobación');

    const doc = await Respuesta.findById(respuestaId);
    if (!doc) throw new Error('Respuesta no encontrada');
    if (doc.estado !== 'Enviado') {
        throw new Error('El reporte ya no está enviado (fue devuelto o está en borrador); no hay aprobación que deshacer.');
    }

    const indicadorId = getRefId(doc.indicador_id);
    const porEmail = normalizeEmail(por);
    const responderEmail = normalizeEmail(doc.respondido_por);

    if (nivel === 'proyecto') {
        if (doc.estado_aval_proyecto !== 'Aprobado') {
            throw new Error('Este reporte no tiene una aprobación del responsable del proyecto para deshacer.');
        }
        const emails = await getResponsablesEmailsForProyectoOfIndicador(indicadorId);
        if (porEmail && !emails.includes(porEmail) && !(await isAdminEmail(porEmail))) {
            throw new Error('Solo el responsable del proyecto puede deshacer esta aprobación.');
        }
        if (modo === 'reabrir' && (!emails.length || emails.includes(responderEmail))) {
            throw new Error('Esta aprobación fue automática (quien reportó es el responsable del proyecto). Usa "Devolver para correcciones".');
        }
    } else if (nivel === 'lider') {
        if (doc.estado_aval !== 'Aprobado') {
            throw new Error('Este reporte no tiene una aprobación del líder para deshacer.');
        }
        const emails = await getLideresEmailsForIndicador(indicadorId);
        if (porEmail && !emails.includes(porEmail) && !(await isAdminEmail(porEmail))) {
            throw new Error('Solo el líder del macroproyecto puede deshacer esta aprobación.');
        }
        if (modo === 'reabrir' && (!emails.length || emails.includes(responderEmail))) {
            throw new Error('Esta aprobación fue automática (quien reportó es el líder del macroproyecto). Usa "Devolver para correcciones".');
        }
    } else if (doc.aval_planeacion !== 'Validado') {
        throw new Error('Este reporte no ha sido validado por Planeación; no hay validación que deshacer.');
    }

    const llegoAPlaneacion = doc.estado_aval === 'Aprobado';
    const ahora = new Date();
    let estadoPeriodo;

    if (modo === 'reabrir') {
        if (nivel === 'planeacion') {
            clearPlaneacion(doc);
            doc.aval_planeacion = 'Pendiente';
            estadoPeriodo = 'Aprobado';
        } else if (nivel === 'lider') {
            clearPlaneacion(doc);
            clearAvalLider(doc);
            doc.estado_aval = 'Pendiente';
            doc.lider_email_aval = (await getLideresEmailsForIndicador(indicadorId))[0] || doc.lider_email_aval;
            estadoPeriodo = 'Enviado';
        } else {
            clearPlaneacion(doc);
            clearAvalLider(doc);
            doc.estado_aval_proyecto = 'Pendiente';
            doc.aval_proyecto_por = '';
            doc.aval_proyecto_comentario = '';
            doc.aval_proyecto_razones = [];
            doc.aval_proyecto_otro_cual = '';
            doc.aval_proyecto_fecha = null;
            doc.proyecto_email_aval = (await getResponsablesEmailsForProyectoOfIndicador(indicadorId))[0] || doc.proyecto_email_aval;
            estadoPeriodo = 'Enviado';
        }
    } else {
        if (nivel === 'planeacion') {
            doc.aval_planeacion = 'Devuelto';
            doc.aval_planeacion_por = por ?? '';
            doc.aval_planeacion_comentario = motivoTexto;
            doc.aval_planeacion_fecha = ahora;
            clearAvalLider(doc);
            estadoPeriodo = 'Borrador';
        } else if (nivel === 'lider') {
            clearPlaneacion(doc);
            doc.estado_aval = 'Rechazado';
            doc.aval_por = por ?? '';
            doc.aval_comentario = motivoTexto;
            doc.aval_razones = [];
            doc.aval_otro_cual = '';
            doc.aval_fecha = ahora;
            estadoPeriodo = 'Rechazado';
        } else {
            clearPlaneacion(doc);
            clearAvalLider(doc);
            doc.estado_aval_proyecto = 'Rechazado';
            doc.aval_proyecto_por = por ?? '';
            doc.aval_proyecto_comentario = motivoTexto;
            doc.aval_proyecto_razones = [];
            doc.aval_proyecto_otro_cual = '';
            doc.aval_proyecto_fecha = ahora;
            estadoPeriodo = 'Rechazado';
        }
        doc.estado = 'Borrador';
        doc.fecha_envio = null;
    }

    doc.reversiones.push({ nivel, modo, por: por ?? '', motivo: motivoTexto, fecha: ahora });
    await doc.save();

    await syncPeriodoReporte({
        indicador_id: indicadorId,
        corte: doc.corte,
        estado_reporte: estadoPeriodo,
        ...(estadoPeriodo === 'Borrador' ? { reportado_por: '', fecha_envio: null } : {}),
    });

    const quien = NIVEL_LABEL[nivel];
    if (modo === 'devolver') {
        await notificarDevolucion(doc, {
            nivel,
            por,
            comentario: motivoTexto,
            incluirAdmins: llegoAPlaneacion && nivel !== 'planeacion',
            titulo: 'Aprobación deshecha - reporte devuelto',
            intro: `${quien.charAt(0).toUpperCase() + quien.slice(1)} deshizo la aprobación que había dado y devolvió el reporte para correcciones. El responsable de la acción debe ajustarlo y reenviarlo.`,
        });
    } else {
        const { indicador, accion } = await getIndicadorConAccion(indicadorId);
        const [lideres, proyecto, admins] = await Promise.all([
            getLideresEmailsForIndicador(indicadorId),
            getResponsablesEmailsForProyectoOfIndicador(indicadorId),
            llegoAPlaneacion || nivel === 'planeacion' ? getAdminEmails() : [],
        ]);
        const { sendRespuestaEstadoNotification } = require('./pdiRespuestaNotification');
        await sendRespuestaEstadoNotification({
            recipients: [doc.respondido_por, ...proyecto, ...lideres, ...admins],
            subject: `Aprobación deshecha: ${accion?.codigo || indicador?.codigo || 'PDI'} - ${doc.corte}`,
            headerTitle: 'Aprobación deshecha - reporte en nueva revisión',
            introText: `${quien.charAt(0).toUpperCase() + quien.slice(1)} deshizo la aprobación del reporte y lo volverá a evaluar. Por ahora el reporte queda nuevamente en revisión.`,
            statusLabel: 'EN REVISIÓN',
            statusColor: '#f59e0b',
            indicador,
            accion,
            corte: doc.corte,
            respondidoPor: doc.respondido_por,
            evaluadoPor: por,
            comentario: motivoTexto,
            comentarioLabel: 'Motivo',
        });
    }

    return doc;
};

// Describe quién devolvió el reporte y por qué (para las alertas del administrador)
const describirDevolucion = (doc) => {
    if (doc.aval_planeacion === 'Devuelto') {
        return {
            nivel: 'planeacion', nivel_label: 'Planeación',
            por: doc.aval_planeacion_por, comentario: doc.aval_planeacion_comentario,
            razones: [], fecha: doc.aval_planeacion_fecha,
        };
    }
    if (doc.estado_aval === 'Rechazado') {
        return {
            nivel: 'lider', nivel_label: 'Líder del macroproyecto',
            por: doc.aval_por, comentario: doc.aval_comentario,
            razones: buildMotivo(doc.aval_razones, doc.aval_otro_cual), fecha: doc.aval_fecha,
        };
    }
    return {
        nivel: 'proyecto', nivel_label: 'Responsable del proyecto',
        por: doc.aval_proyecto_por, comentario: doc.aval_proyecto_comentario,
        razones: buildMotivo(doc.aval_proyecto_razones, doc.aval_proyecto_otro_cual), fecha: doc.aval_proyecto_fecha,
    };
};

// Reportes devueltos que aún no han sido corregidos y reenviados
const getRespuestasDevueltas = async () => {
    const docs = await Respuesta.find({
        estado: 'Borrador',
        $or: [
            { estado_aval_proyecto: 'Rechazado' },
            { estado_aval: 'Rechazado' },
            { aval_planeacion: 'Devuelto' },
        ],
    })
        .select('-respuestas')
        .populate('formulario_id', 'nombre')
        .populate({
            path: 'indicador_id',
            select: 'codigo nombre accion_id',
            populate: { path: 'accion_id', select: 'codigo nombre' },
        })
        .sort({ updatedAt: -1 })
        .lean();

    return docs.map((doc) => {
        const accion = doc.indicador_id?.accion_id;
        return {
            ...withEvaluacionNavigation(doc, 'planeacion'),
            accion: accion ? { _id: accion._id, codigo: accion.codigo, nombre: accion.nombre } : null,
            devolucion: describirDevolucion(doc),
        };
    });
};

// Retorna todas las respuestas pendientes de evaluación para un responsable de proyecto
// (en CUALQUIER posición del array de responsables del proyecto)
const getRespuestasPendientesAvalProyecto = async (responsable_email) => {
    const email = normalizeEmail(responsable_email);
    const emailRegex = new RegExp(`^${escapeRegExp(email)}$`, 'i');

    const proyectosDelResponsable = await Proyecto.find({
        $or: [
            { responsable_email: emailRegex },
            { 'responsables.email': emailRegex },
        ],
    }).select('_id');

    const proyectoIds = proyectosDelResponsable.map(p => p._id);
    const acciones = await Accion.find({ proyecto_id: { $in: proyectoIds } }).select('_id');
    const accionIds = acciones.map(a => a._id);
    const indicadores = await Indicador.find({ accion_id: { $in: accionIds } }).select('_id');
    const indicadorIds = indicadores.map(i => i._id);

    const docs = await Respuesta.find({
        indicador_id: { $in: indicadorIds },
        estado_aval_proyecto: 'Pendiente',
        aval_planeacion: { $nin: PLANEACION_EVALUATED_STATES },
    })
        .populate('formulario_id', 'nombre campos')
        .populate('indicador_id', 'codigo nombre')
        .sort({ createdAt: -1 });
    await autoApproveLeaderSubmittedResponses(docs);
    const pendingDocs = docs.filter((doc) => doc.estado_aval_proyecto === 'Pendiente');
    return pendingDocs.map((doc) => withEvaluacionNavigation(doc, 'proyecto'));
};

// Retorna respuestas enviadas que aun esperan evaluacion del responsable de proyecto
const getRespuestasPendientesResponsableProyecto = async () => {
    const docs = await Respuesta.find({
        estado: 'Enviado',
        estado_aval_proyecto: 'Pendiente',
        aval_planeacion: { $nin: PLANEACION_EVALUATED_STATES },
    })
        .populate('formulario_id', 'nombre campos')
        .populate('indicador_id', 'codigo nombre responsable responsable_email')
        .sort({ fecha_envio: -1, createdAt: -1 });

    await autoApproveLeaderSubmittedResponses(docs);
    const pendingDocs = docs.filter((doc) => doc.estado_aval_proyecto === 'Pendiente');
    return pendingDocs.map((doc) => withEvaluacionNavigation(doc, 'proyecto'));
};

// Retorna todas las respuestas pendientes de aval para un lider (en CUALQUIER posición del array)
const getRespuestasPendientesAval = async (lider_email) => {
    const email = normalizeEmail(lider_email);
    const emailRegex = new RegExp(`^${escapeRegExp(email)}$`, 'i');
    
    // CORRECCIÓN: Buscar respuestas donde el usuario es líder del macroproyecto
    // Ya sea en lider_email_aval (legacy) o si está en el array lideres del macro
    const macrosDelLider = await Macroproyecto.find({
        $or: [
            { lider_email: emailRegex },
            { 'lideres.email': emailRegex }
        ]
    }).select('_id');
    
    const macroIds = macrosDelLider.map(m => m._id);
    
    // Obtener indicadores de esos macroproyectos
    const proyectos = await Proyecto.find({ macroproyecto_id: { $in: macroIds } }).select('_id');
    const proyectoIds = proyectos.map(p => p._id);
    
    const acciones = await Accion.find({ proyecto_id: { $in: proyectoIds } }).select('_id');
    const accionIds = acciones.map(a => a._id);
    
    const indicadores = await Indicador.find({ accion_id: { $in: accionIds } }).select('_id');
    const indicadorIds = indicadores.map(i => i._id);
    
    // Buscar respuestas de esos indicadores que estén pendientes y asignadas a este usuario
    const docs = await Respuesta.find({ 
        indicador_id: { $in: indicadorIds },
        estado_aval: 'Pendiente',
        aval_planeacion: { $nin: PLANEACION_EVALUATED_STATES },
    })
        .populate('formulario_id', 'nombre campos')
        .populate('indicador_id', 'codigo nombre')
        .sort({ createdAt: -1 });
    await autoApproveLeaderSubmittedResponses(docs);
    const pendingDocs = (await filterOutPlaneacionEvaluatedReports(docs))
        .filter((doc) => doc.estado_aval === 'Pendiente');
    return pendingDocs.map((doc) => withEvaluacionNavigation(doc, 'lider'));
};

// Retorna respuestas enviadas que aun esperan evaluacion del lider de macroproyecto
const getRespuestasPendientesLider = async () => {
    const docs = await Respuesta.find({
        estado: 'Enviado',
        estado_aval: 'Pendiente',
        aval_planeacion: { $nin: PLANEACION_EVALUATED_STATES },
    })
        .populate('formulario_id', 'nombre campos')
        .populate('indicador_id', 'codigo nombre responsable responsable_email')
        .sort({ fecha_envio: -1, createdAt: -1 });

    await autoApproveLeaderSubmittedResponses(docs);
    const pendingDocs = (await filterOutPlaneacionEvaluatedReports(docs))
        .filter((doc) => doc.estado_aval === 'Pendiente');
    return pendingDocs.map((doc) => withEvaluacionNavigation(doc, 'lider'));
};

// Retorna respuestas aprobadas por lider que aun debe evaluar Planeacion
const getRespuestasPendientesPlaneacion = async () => {
    await autoApproveAllPendingLeaderSubmittedResponses();

    const docs = await Respuesta.find({
        estado: 'Enviado',
        estado_aval: 'Aprobado',
        $or: [
            { aval_planeacion: null },
            { aval_planeacion: 'Pendiente' },
            { aval_planeacion: { $exists: false } },
        ],
    })
        .populate('formulario_id', 'nombre campos')
        .populate('indicador_id', 'codigo nombre responsable responsable_email')
        .sort({ aval_fecha: -1, fecha_envio: -1, createdAt: -1 });

    const pendingDocs = await filterOutPlaneacionEvaluatedReports(docs);
    return pendingDocs.map((doc) => withEvaluacionNavigation(doc, 'planeacion'));
};

module.exports = {
    getAll, getById, create, update, remove,
    getRespuestas, getRespuestaById, upsertRespuesta, deleteRespuesta,
    avalProyecto, avalRespuesta, marcarComentarioCampoResuelto, avalPlaneacion,
    revertirAprobacion, getRespuestasDevueltas, notificarPendienteEvaluacion,
    getRespuestasPendientesAvalProyecto, getRespuestasPendientesResponsableProyecto,
    getRespuestasPendientesAval, getRespuestasPendientesLider, getRespuestasPendientesPlaneacion, getLiderEmailForIndicador,
    getResponsableProyectoEmailForIndicador,
    getLideresEmailsForIndicador,
    getResponsablesEmailsForProyecto,
    getResponsablesEmailsForAccion,
    getReportersEmailsForIndicador,
    autoApproveAllPendingLeaderSubmittedResponses,
};
