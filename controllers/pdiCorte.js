const Corte = require('../models/pdiCorte');

const ctrl = {};

ctrl.getAll = async (req, res) => {
    try {
        const docs = await Corte.find().sort({ orden: 1, nombre: 1 });
        res.json(docs);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.getActivos = async (req, res) => {
    try {
        const docs = await Corte.find({ activo: true }).sort({ orden: 1, nombre: 1 });
        res.json(docs);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

// Retorna los cortes activos cuya ventana de calificación está vigente hoy
ctrl.getVigentes = async (req, res) => {
    try {
        const hoy = new Date();
        const docs = await Corte.find({ activo: true }).sort({ orden: 1, nombre: 1 });
        const vigentes = docs.filter(c => {
            if (!c.fecha_inicio && !c.fecha_fin) return true; // sin fechas = siempre abierto
            const desde = c.fecha_inicio ? new Date(c.fecha_inicio) : null;
            const hasta = c.fecha_fin    ? new Date(c.fecha_fin)    : null;
            if (desde && hoy < desde) return false;
            if (hasta && hoy > hasta) return false;
            return true;
        });
        res.json(vigentes);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.create = async (req, res) => {
    try {
        const doc = await Corte.create(req.body);
        res.status(201).json(doc);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.update = async (req, res) => {
    try {
        const doc = await Corte.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        res.json(doc);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.remove = async (req, res) => {
    try {
        const doc = await Corte.findByIdAndDelete(req.params.id);
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        res.json({ message: 'Corte eliminado' });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

module.exports = ctrl;
