const Macroproyecto = require('../models/pdiMacroproyecto');
const { getSemaforo, withSemaforo } = require('../helpers/pdiSemaforo');
const { recalcularMacroproyecto } = require('./pdiProyecto');

const ctrl = {};

ctrl.getAll = async (req, res) => {
    try {
        const Proyecto = require('../models/pdiProyecto');
        const macroIds = await Proyecto.distinct('macroproyecto_id');
        await Promise.all(macroIds.map((id) => recalcularMacroproyecto(id)));
        const docs = await Macroproyecto.find().sort({ codigo: 1 });
        res.json(docs.map(withSemaforo));
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.getById = async (req, res) => {
    try {
        await recalcularMacroproyecto(req.params.id);
        const doc = await Macroproyecto.findById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        res.json(withSemaforo(doc));
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.create = async (req, res) => {
    try {
        const doc = await Macroproyecto.create(req.body);
        res.status(201).json(withSemaforo(doc));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.update = async (req, res) => {
    try {
        const { num_proyectos, ...rest } = req.body;
        const update = { ...rest };
        if (num_proyectos !== undefined) update.num_proyectos = Number(num_proyectos) || 0;

        const doc = await Macroproyecto.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
        if (!doc) return res.status(404).json({ error: 'No encontrado' });

        if (num_proyectos !== undefined && Number(num_proyectos) > 0) {
            const Proyecto = require('../models/pdiProyecto');
            const peso = parseFloat((100 / Number(num_proyectos)).toFixed(6));
            await Proyecto.updateMany({ macroproyecto_id: req.params.id }, { $set: { peso } });
        }

        res.json(withSemaforo(doc));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.remove = async (req, res) => {
    try {
        const doc = await Macroproyecto.findByIdAndDelete(req.params.id);
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        res.json({ message: 'Macroproyecto eliminado' });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

module.exports = ctrl;
