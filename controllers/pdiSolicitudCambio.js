const SolicitudCambio = require('../models/pdiSolicitudCambio');

const ctrl = {};

// GET /pdi/cambios  — Lista solicitudes con filtros opcionales
// Query params: entidad_id, entidad_tipo, estado, solicitado_por
ctrl.getAll = async (req, res) => {
    try {
        const query = {};
        if (req.query.entidad_id)   query.entidad_id   = req.query.entidad_id;
        if (req.query.entidad_tipo) query.entidad_tipo = req.query.entidad_tipo;
        if (req.query.estado)       query.estado       = req.query.estado;

        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(100, parseInt(req.query.limit) || 30);
        const skip  = (page - 1) * limit;

        const [docs, total] = await Promise.all([
            SolicitudCambio.find(query).sort({ fecha_solicitud: -1 }).skip(skip).limit(limit),
            SolicitudCambio.countDocuments(query),
        ]);

        res.json({ data: docs, total, page, limit });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

// GET /pdi/cambios/:id
ctrl.getById = async (req, res) => {
    try {
        const doc = await SolicitudCambio.findById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'Solicitud no encontrada' });
        res.json(doc);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

// POST /pdi/cambios — Crear solicitud de cambio
ctrl.create = async (req, res) => {
    try {
        const doc = await SolicitudCambio.create(req.body);
        res.status(201).json(doc);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

// PATCH /pdi/cambios/:id/revision — Aprobar o rechazar una solicitud
// Body: { estado, revisado_por, revisado_email, comentario_revision }
ctrl.revisar = async (req, res) => {
    try {
        const { estado, revisado_por, revisado_email, comentario_revision } = req.body;

        const estadosPermitidos = ['En Revisión', 'Aprobado', 'Rechazado'];
        if (!estadosPermitidos.includes(estado)) {
            return res.status(400).json({ error: `Estado inválido. Use: ${estadosPermitidos.join(', ')}` });
        }

        const doc = await SolicitudCambio.findById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'Solicitud no encontrada' });
        if (doc.estado === 'Aprobado' || doc.estado === 'Rechazado') {
            return res.status(409).json({ error: 'La solicitud ya fue procesada y no puede modificarse' });
        }

        doc.estado               = estado;
        doc.revisado_por         = revisado_por         ?? doc.revisado_por;
        doc.revisado_email       = revisado_email       ?? doc.revisado_email;
        doc.comentario_revision  = comentario_revision  ?? '';
        doc.fecha_revision       = new Date();
        await doc.save();

        res.json(doc);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

// DELETE /pdi/cambios/:id — Solo eliminar solicitudes Pendientes
ctrl.remove = async (req, res) => {
    try {
        const doc = await SolicitudCambio.findById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'Solicitud no encontrada' });
        if (doc.estado !== 'Pendiente') {
            return res.status(409).json({ error: 'Solo se pueden eliminar solicitudes en estado Pendiente' });
        }
        await doc.deleteOne();
        res.json({ message: 'Solicitud eliminada' });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

module.exports = ctrl;
