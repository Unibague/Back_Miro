const Historial = require('../models/pdiIndicadorHistorial');

const ctrl = {};

// GET /pdi/historial?indicador_id=xxx&page=1&limit=20
ctrl.getHistorial = async (req, res) => {
    try {
        const { indicador_id, page = 1, limit = 30 } = req.query;
        const query = indicador_id ? { indicador_id } : {};
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
