const Historial = require('../models/pdiIndicadorHistorial');

const ctrl = {};

// GET /pdi/historial?indicador_id=xxx&page=1&limit=20
ctrl.getHistorial = async (req, res) => {
    try {
        const { indicador_id, corte, fechaInicio, fechaFin, page = 1, limit = 30 } = req.query;
        const query = {};
        if (indicador_id) query.indicador_id = indicador_id;
        if (corte || (fechaInicio && fechaFin)) {
            const conditions = [];
            if (corte)                   conditions.push({ corte });
            if (fechaInicio && fechaFin) conditions.push({ createdAt: { $gte: new Date(fechaInicio), $lte: new Date(fechaFin) } });
            Object.assign(query, conditions.length === 1 ? conditions[0] : { $or: conditions });
        }
        const skip  = (Number(page) - 1) * Number(limit);

        const [docs, total] = await Promise.all([
            Historial.find(query)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(Number(limit)),
            Historial.countDocuments(query),
        ]);

        res.json({ historial: docs, total, pages: Math.ceil(total / Number(limit)) });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

module.exports = ctrl;
