const Razon = require('../models/pdiRazonRechazo');

const ctrl = {};

// GET /pdi/razones-rechazo
ctrl.getAll = async (req, res) => {
    try {
        const razones = await Razon.find({ activo: true }).sort({ orden: 1, createdAt: 1 });
        res.json(razones);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// POST /pdi/razones-rechazo
ctrl.create = async (req, res) => {
    try {
        const { texto, orden } = req.body;
        if (!texto?.trim()) return res.status(400).json({ error: 'El texto es requerido' });
        const razon = await Razon.create({ texto: texto.trim(), orden: orden ?? 0 });
        res.status(201).json(razon);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

// PUT /pdi/razones-rechazo/:id
ctrl.update = async (req, res) => {
    try {
        const { texto, activo, orden } = req.body;
        const razon = await Razon.findByIdAndUpdate(
            req.params.id,
            { ...(texto !== undefined && { texto: texto.trim() }), ...(activo !== undefined && { activo }), ...(orden !== undefined && { orden }) },
            { new: true }
        );
        if (!razon) return res.status(404).json({ error: 'Razón no encontrada' });
        res.json(razon);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

// DELETE /pdi/razones-rechazo/:id
ctrl.remove = async (req, res) => {
    try {
        await Razon.findByIdAndDelete(req.params.id);
        res.json({ ok: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

module.exports = ctrl;
