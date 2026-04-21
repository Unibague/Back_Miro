const Formulario  = require('../models/pdiFormulario');
const Respuesta   = require('../models/pdiFormularioRespuesta');
const { deleteFile } = require('./pdiFormularioStorage');

// ── Formularios ────────────────────────────────────────────────────────────

const ensureUniqueIndicator = async (indicador_id, excludeId = null) => {
    if (!indicador_id) {
        throw new Error('El formulario debe estar asociado a un indicador');
    }

    const query = { indicador_id };
    if (excludeId) query._id = { $ne: excludeId };

    const existing = await Formulario.findOne(query).select('_id');
    if (existing) {
        throw new Error('Ya existe un formulario para este indicador');
    }
};

const getAll = async ({ indicador_id, activo } = {}) => {
    const query = { indicador_id: { $exists: true, $ne: null } };
    if (indicador_id) query.indicador_id = indicador_id;
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
    await ensureUniqueIndicator(data.indicador_id);
    const payload = { ...data };
    delete payload.accion_id;
    const doc = await Formulario.create(payload);
    return Formulario.findById(doc._id)
        .populate('indicador_id', 'codigo nombre');
};

const update = async (id, data) => {
    await ensureUniqueIndicator(data.indicador_id, id);
    const payload = {
        ...data,
        $unset: { accion_id: 1 },
    };
    return Formulario.findByIdAndUpdate(id, payload, { new: true, runValidators: true })
        .populate('indicador_id', 'codigo nombre');
};

const remove = async (id) => {
    // Eliminar todas las respuestas y sus archivos antes de borrar el formulario
    const respuestas = await Respuesta.find({ formulario_id: id });
    for (const r of respuestas) {
        for (const resp of r.respuestas) {
            if (resp.filename) deleteFile(resp.filename);
        }
    }
    await Respuesta.deleteMany({ formulario_id: id });
    return Formulario.findByIdAndDelete(id);
};

// ── Respuestas ─────────────────────────────────────────────────────────────

const getRespuestas = async ({ formulario_id, respondido_por, corte } = {}) => {
    const query = {};
    if (formulario_id)  query.formulario_id  = formulario_id;
    if (respondido_por) query.respondido_por = respondido_por;
    if (corte)          query.corte          = corte;
    return Respuesta.find(query)
        .populate('formulario_id', 'nombre campos')
        .sort({ createdAt: -1 });
};

const getRespuestaById = async (id) => {
    return Respuesta.findById(id).populate('formulario_id', 'nombre campos');
};

// Crea o actualiza la respuesta de un responsable para un formulario+corte
const upsertRespuesta = async ({ formulario_id, respondido_por, corte, respuestas, estado }) => {
    const existing = await Respuesta.findOne({ formulario_id, respondido_por, corte });

    if (existing) {
        existing.respuestas = respuestas ?? existing.respuestas;
        if (estado) {
            existing.estado = estado;
            if (estado === 'Enviado' && !existing.fecha_envio) {
                existing.fecha_envio = new Date();
            }
        }
        await existing.save();
        return existing;
    }

    return Respuesta.create({
        formulario_id,
        respondido_por,
        corte: corte ?? '',
        respuestas: respuestas ?? [],
        estado: estado ?? 'Borrador',
        fecha_envio: estado === 'Enviado' ? new Date() : null,
    });
};

const deleteRespuesta = async (id) => {
    const doc = await Respuesta.findById(id);
    if (!doc) return null;
    for (const r of doc.respuestas) {
        if (r.filename) deleteFile(r.filename);
    }
    return Respuesta.findByIdAndDelete(id);
};

module.exports = {
    getAll, getById, create, update, remove,
    getRespuestas, getRespuestaById, upsertRespuesta, deleteRespuesta,
};
