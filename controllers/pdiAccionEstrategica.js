const AccionEstrategica = require('../models/pdiAccionEstrategica');
const Proyecto          = require('../models/pdiProyecto');
const { withSemaforo } = require('../helpers/pdiSemaforo');
const { recalcularMacroproyecto } = require('./pdiProyecto');

function normalizePeso(peso) {
    const value = Number(peso) || 0;
    return value <= 1 ? value * 100 : value;
}

// Recalcula el avance y los presupuestos del proyecto a partir de sus acciones
async function recalcularProyecto(proyecto_id) {
    const acciones = await AccionEstrategica.find({ proyecto_id });
    if (!acciones.length) return;

    const avance = Math.round(
        acciones.reduce((acc, a) => acc + ((Number(a.avance) || 0) * normalizePeso(a.peso)), 0) / 100
    );

    const presupuesto = acciones.reduce((acc, a) => acc + (a.presupuesto || 0), 0);
    const presupuesto_ejecutado = acciones.reduce((acc, a) => acc + (a.presupuesto_ejecutado || 0), 0);
    const gasto = acciones.reduce((acc, a) => acc + (a.gasto || 0), 0);
    const inversion = acciones.reduce((acc, a) => acc + (a.inversion || 0), 0);

    const proyecto = await Proyecto.findByIdAndUpdate(
        proyecto_id,
        { avance, presupuesto, presupuesto_ejecutado, gasto, inversion },
        { new: true }
    );
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
        const { num_indicadores, ...updateData } = req.body;
        if (num_indicadores !== undefined) updateData.num_indicadores = Number(num_indicadores) || 0;

        const doc = await AccionEstrategica.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
        if (!doc) return res.status(404).json({ error: 'No encontrado' });

        if (num_indicadores !== undefined && Number(num_indicadores) > 0) {
            const Indicador = require('../models/pdiIndicador');
            const peso = parseFloat((100 / Number(num_indicadores)).toFixed(6));
            await Indicador.updateMany({ accion_id: req.params.id }, { $set: { peso } });
        }

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
