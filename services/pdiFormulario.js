const Formulario      = require('../models/pdiFormulario');
const Respuesta       = require('../models/pdiFormularioRespuesta');
const Indicador       = require('../models/pdiIndicador');
const Accion          = require('../models/pdiAccionEstrategica');
const Proyecto        = require('../models/pdiProyecto');
const Macroproyecto   = require('../models/pdiMacroproyecto');
const { deleteFile }  = require('./pdiFormularioStorage');
const { replaceWordDocument } = require('./pdiFormularioWordDocument');

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
        }
    }
    await Respuesta.deleteMany({ formulario_id: id });
    return Formulario.findByIdAndDelete(id);
};

// ── Helpers ────────────────────────────────────────────────────────────────

const getLiderEmailForIndicador = async (indicador_id) => {
    if (!indicador_id) return '';
    try {
        const ind = await Indicador.findById(indicador_id).select('accion_id');
        if (!ind?.accion_id) return '';
        const acc = await Accion.findById(ind.accion_id).select('proyecto_id');
        if (!acc?.proyecto_id) return '';
        const proy = await Proyecto.findById(acc.proyecto_id).select('macroproyecto_id');
        if (!proy?.macroproyecto_id) return '';
        const macro = await Macroproyecto.findById(proy.macroproyecto_id).select('lider_email');
        return (macro?.lider_email ?? '').toLowerCase().trim();
    } catch {
        return '';
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

const getRespuestas = async ({ formulario_id, indicador_id, respondido_por, corte } = {}) => {
    const query = {};
    if (formulario_id)  query.formulario_id  = formulario_id;
    if (indicador_id)   query.indicador_id   = indicador_id;
    if (respondido_por) query.respondido_por = respondido_por;
    if (corte)          query.corte          = corte;
    const docs = await Respuesta.find(query)
        .populate('formulario_id', 'nombre campos')
        .populate('indicador_id', 'codigo nombre')
        .sort({ createdAt: -1 });
    return hydrateWordDocuments(docs);
};

const getRespuestaById = async (id) => {
    const doc = await Respuesta.findById(id)
        .populate('formulario_id', 'nombre campos')
        .populate('indicador_id', 'codigo nombre');
    return hydrateWordDocuments(doc);
};

const normalizePeriodo = (value) => String(value ?? '').trim().toUpperCase();

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

// Crea o actualiza la respuesta de un responsable para un formulario+corte
const upsertRespuesta = async ({ formulario_id, indicador_id, respondido_por, corte, respuestas, estado }) => {
    const existing = await Respuesta.findOne({ formulario_id, indicador_id: indicador_id || null, respondido_por, corte });

    const becomingEnviado = estado === 'Enviado';
    const wasAlreadySent  = existing?.estado === 'Enviado';
    const wasRejected = existing?.estado_aval === 'Rechazado';
    let avalData = {};

    if (becomingEnviado && (!wasAlreadySent || wasRejected)) {
        const liderEmail = (
            await getLiderEmailForIndicador(indicador_id)
            || existing?.lider_email_aval
            || ''
        ).toLowerCase().trim();
        if (liderEmail) {
            const respondeElMismoLider = liderEmail === String(respondido_por ?? '').toLowerCase().trim();
            avalData = respondeElMismoLider
                ? {
                    lider_email_aval: liderEmail,
                    estado_aval: 'Aprobado',
                    aval_por: respondido_por,
                    aval_comentario: '',
                    aval_fecha: new Date(),
                }
                : {
                    lider_email_aval: liderEmail,
                    estado_aval: 'Pendiente',
                    aval_por: '',
                    aval_comentario: '',
                    aval_fecha: null,
                };
        } else {
            // No hay líder configurado → aprobación automática
            avalData = {
                lider_email_aval: '',
                estado_aval: 'Aprobado',
                aval_por: respondido_por,
                aval_comentario: '',
                aval_fecha: new Date(),
            };
        }
    }

    if (existing) {
        existing.respuestas    = respuestas ?? existing.respuestas;
        existing.indicador_id  = indicador_id || null;
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
        const hydrated = await ensureWordDocumentIfSent(existing);
        return { doc: hydrated, justSent: existing.estado === 'Enviado' && (!wasAlreadySent || wasRejected) };
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
    const hydrated = await ensureWordDocumentIfSent(created);
    return { doc: hydrated, justSent: created.estado === 'Enviado' };
};

const deleteRespuesta = async (id) => {
    const doc = await Respuesta.findById(id);
    if (!doc) return null;
    for (const r of doc.respuestas) {
        if (r.filename) deleteFile(r.filename);
    }
    if (doc.word_filename) deleteFile(doc.word_filename);
    return Respuesta.findByIdAndDelete(id);
};

// Aprueba o rechaza una respuesta (solo el lider del macroproyecto)
const avalRespuesta = async (respuestaId, { estado_aval, aval_por, aval_comentario }) => {
    const doc = await Respuesta.findById(respuestaId);
    if (!doc) throw new Error('Respuesta no encontrada');
    if (doc.estado !== 'Enviado') throw new Error('Solo se pueden avalar respuestas enviadas');
    doc.estado_aval    = estado_aval;
    doc.aval_por       = aval_por ?? '';
    doc.aval_comentario = aval_comentario ?? '';
    doc.aval_fecha     = new Date();
    await doc.save();
    await syncPeriodoReporte({
        indicador_id: doc.indicador_id,
        corte: doc.corte,
        estado_reporte: estado_aval === 'Aprobado' ? 'Aprobado' : 'Rechazado',
        reportado_por: doc.respondido_por,
        fecha_envio: doc.fecha_envio ?? new Date(),
    });
    return doc;
};

// Retorna todas las respuestas pendientes de aval para un lider
const getRespuestasPendientesAval = async (lider_email) => {
    return Respuesta.find({ lider_email_aval: lider_email.toLowerCase().trim(), estado_aval: 'Pendiente' })
        .populate('formulario_id', 'nombre campos')
        .populate('indicador_id', 'codigo nombre')
        .sort({ createdAt: -1 });
};

module.exports = {
    getAll, getById, create, update, remove,
    getRespuestas, getRespuestaById, upsertRespuesta, deleteRespuesta,
    avalRespuesta, getRespuestasPendientesAval,
};
