const AccionEstrategica = require('../models/pdiAccionEstrategica');
const Proyecto          = require('../models/pdiProyecto');
const { withSemaforo } = require('../helpers/pdiSemaforo');
const { recalcularMacroproyecto } = require('./pdiProyecto');

// Recalcula el avance del proyecto como promedio ponderado de sus acciones
async function recalcularProyecto(proyecto_id) {
    const acciones = await AccionEstrategica.find({ proyecto_id });
    if (!acciones.length) return;

    const totalPeso = acciones.reduce((acc, a) => acc + a.peso, 0);
    const avance = totalPeso > 0
        ? Math.round(acciones.reduce((acc, a) => acc + (a.avance * a.peso), 0) / totalPeso)
        : 0;

    const proyecto = await Proyecto.findByIdAndUpdate(proyecto_id, { avance }, { new: true });
    if (proyecto) await recalcularMacroproyecto(proyecto.macroproyecto_id);
}

const ctrl = {};

ctrl.getAll = async (req, res) => {
    try {
        const query = {};
        if (req.query.proyecto_id) query.proyecto_id = req.query.proyecto_id;
        const docs = await AccionEstrategica.find(query).populate('proyecto_id', 'codigo nombre').sort({ codigo: 1 });
        res.json(docs.map(withSemaforo));
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.getById = async (req, res) => {
    try {
        const doc = await AccionEstrategica.findById(req.params.id).populate('proyecto_id', 'codigo nombre');
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        res.json(withSemaforo(doc));
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.create = async (req, res) => {
    try {
        const doc = await AccionEstrategica.create(req.body);
        await recalcularProyecto(doc.proyecto_id);
        res.status(201).json(withSemaforo(doc));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.update = async (req, res) => {
    try {
        const doc = await AccionEstrategica.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        await recalcularProyecto(doc.proyecto_id);
        res.json(withSemaforo(doc));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.remove = async (req, res) => {
    try {
        const doc = await AccionEstrategica.findByIdAndDelete(req.params.id);
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        await recalcularProyecto(doc.proyecto_id);
        res.json({ message: 'Acción estratégica eliminada' });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

module.exports = ctrl;
module.exports.recalcularProyecto = recalcularProyecto;
