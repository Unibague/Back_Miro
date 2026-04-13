const Proyecto       = require('../models/pdiProyecto');
const Macroproyecto  = require('../models/pdiMacroproyecto');
const { withSemaforo } = require('../helpers/pdiSemaforo');

// Recalcula el avance del macroproyecto como promedio ponderado de sus proyectos
async function recalcularMacroproyecto(macroproyecto_id) {
    const proyectos = await Proyecto.find({ macroproyecto_id });
    if (!proyectos.length) return;

    const totalPeso = proyectos.reduce((acc, p) => acc + p.peso, 0);
    const avance = totalPeso > 0
        ? Math.round(proyectos.reduce((acc, p) => acc + (p.avance * p.peso), 0) / totalPeso)
        : 0;

    await Macroproyecto.findByIdAndUpdate(macroproyecto_id, { avance });
}

const ctrl = {};

ctrl.getAll = async (req, res) => {
    try {
        const query = {};
        if (req.query.macroproyecto_id) query.macroproyecto_id = req.query.macroproyecto_id;
        const docs = await Proyecto.find(query).populate('macroproyecto_id', 'codigo nombre').sort({ codigo: 1 });
        res.json(docs.map(withSemaforo));
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.getById = async (req, res) => {
    try {
        const doc = await Proyecto.findById(req.params.id).populate('macroproyecto_id', 'codigo nombre');
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        res.json(withSemaforo(doc));
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.create = async (req, res) => {
    try {
        const doc = await Proyecto.create(req.body);
        await recalcularMacroproyecto(doc.macroproyecto_id);
        res.status(201).json(withSemaforo(doc));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.update = async (req, res) => {
    try {
        const doc = await Proyecto.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        await recalcularMacroproyecto(doc.macroproyecto_id);
        res.json(withSemaforo(doc));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.remove = async (req, res) => {
    try {
        const doc = await Proyecto.findByIdAndDelete(req.params.id);
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        await recalcularMacroproyecto(doc.macroproyecto_id);
        res.json({ message: 'Proyecto eliminado' });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

module.exports = ctrl;
module.exports.recalcularMacroproyecto = recalcularMacroproyecto;
