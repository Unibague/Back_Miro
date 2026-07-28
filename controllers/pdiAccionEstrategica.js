const AccionEstrategica = require('../models/pdiAccionEstrategica');
const Proyecto          = require('../models/pdiProyecto');
const { withSemaforo } = require('../helpers/pdiSemaforo');
const { recalcularMacroproyecto } = require('./pdiProyecto');
const { weightedContribution } = require('../services/pdiAvanceCalculator');

const toBudgetCents = (value) => Math.round((Number(value) || 0) * 100);

const getAnnualBudgetValues = (budgetByYear) => {
    if (budgetByYear instanceof Map) return [...budgetByYear.values()];
    if (budgetByYear && typeof budgetByYear === 'object') return Object.values(budgetByYear);
    return [];
};

const validateGlobalBudgetAllocation = ({ presupuesto, presupuesto_por_anio }) => {
    const globalBudget = toBudgetCents(presupuesto);
    const annualBudget = getAnnualBudgetValues(presupuesto_por_anio)
        .reduce((total, value) => total + toBudgetCents(value), 0);
    const difference = annualBudget - globalBudget;

    if (difference === 0) return;

    const formattedDifference = (Math.abs(difference) / 100).toLocaleString('es-CO');
    const detail = difference > 0
        ? `La asignacion anual supera el presupuesto global por $ ${formattedDifference}.`
        : `Faltan asignar $ ${formattedDifference} del presupuesto global.`;
    const error = new Error(`${detail} La suma de los presupuestos por año debe ser exactamente igual al presupuesto global.`);
    error.status = 422;
    throw error;
};

// Recalcula el avance y los presupuestos del proyecto a partir de sus acciones
async function recalcularProyecto(proyecto_id) {
    const acciones = await AccionEstrategica.find({ proyecto_id });
    if (!acciones.length) return;

    const avance = weightedContribution(
        acciones,
        (accion) => accion.avance,
        (accion) => accion.peso
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
        validateGlobalBudgetAllocation(req.body);
        const doc = await AccionEstrategica.create(req.body);
        await recalcularProyecto(doc.proyecto_id);
        res.status(201).json(withSemaforo(doc));
    } catch (e) {
        res.status(e.status || 400).json({ error: e.message });
    }
};

ctrl.update = async (req, res) => {
    try {
        const { num_indicadores, ...updateData } = req.body;
        if (num_indicadores !== undefined) updateData.num_indicadores = Number(num_indicadores) || 0;

        const currentDoc = await AccionEstrategica.findById(req.params.id).lean();
        if (!currentDoc) return res.status(404).json({ error: 'No encontrado' });
        validateGlobalBudgetAllocation({
            presupuesto: updateData.presupuesto !== undefined
                ? updateData.presupuesto
                : currentDoc.presupuesto,
            presupuesto_por_anio: updateData.presupuesto_por_anio !== undefined
                ? updateData.presupuesto_por_anio
                : currentDoc.presupuesto_por_anio,
        });

        const doc = await AccionEstrategica.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });

        if (num_indicadores !== undefined && Number(num_indicadores) > 0) {
            const Indicador = require('../models/pdiIndicador');
            const peso = parseFloat((100 / Number(num_indicadores)).toFixed(6));
            await Indicador.updateMany({ accion_id: req.params.id }, { $set: { peso } });
        }

        await recalcularProyecto(doc.proyecto_id);
        res.json(withSemaforo(doc));
    } catch (e) {
        res.status(e.status || 400).json({ error: e.message });
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
