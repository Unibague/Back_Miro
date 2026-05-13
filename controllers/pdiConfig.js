const PdiConfig = require('../models/pdiConfig');
const { SINGLETON_ID } = require('../models/pdiConfig');
const Macro     = require('../models/pdiMacroproyecto');
const Proyecto  = require('../models/pdiProyecto');
const Accion    = require('../models/pdiAccionEstrategica');
const Indicador = require('../models/pdiIndicador');

// Garantiza que exista el documento singleton y lo devuelve
async function getOrCreate() {
    let doc = await PdiConfig.findById(SINGLETON_ID);
    if (!doc) {
        doc = await PdiConfig.create({ _id: SINGLETON_ID });
    }
    return doc;
}

const ctrl = {};

// GET /pdi/config
ctrl.get = async (req, res) => {
    try {
        const doc = await getOrCreate();
        // Incluir la lista de años derivada del rango para que el front la use directamente
        const anios = [];
        for (let a = doc.anio_inicio; a <= doc.anio_fin; a++) anios.push(a);
        res.json({ ...doc.toObject(), anios });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

// PUT /pdi/config
ctrl.update = async (req, res) => {
    try {
        const {
            nombre, descripcion, anio_inicio, anio_fin, lema,
            num_macroproyectos, proyectos_por_macro,
            acciones_por_proyecto, indicadores_por_accion,
        } = req.body;

        if (anio_inicio && anio_fin && Number(anio_inicio) > Number(anio_fin)) {
            return res.status(400).json({ error: 'El año de inicio no puede ser mayor al año de fin' });
        }

        const update = { nombre, descripcion, anio_inicio, anio_fin, lema };
        if (num_macroproyectos     !== undefined) update.num_macroproyectos     = Number(num_macroproyectos)     || 0;
        if (proyectos_por_macro    !== undefined) update.proyectos_por_macro    = Number(proyectos_por_macro)    || 0;
        if (acciones_por_proyecto  !== undefined) update.acciones_por_proyecto  = Number(acciones_por_proyecto)  || 0;
        if (indicadores_por_accion !== undefined) update.indicadores_por_accion = Number(indicadores_por_accion) || 0;

        const doc = await PdiConfig.findByIdAndUpdate(
            SINGLETON_ID,
            update,
            { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
        );

        const anios = [];
        for (let a = doc.anio_inicio; a <= doc.anio_fin; a++) anios.push(a);
        res.json({ ...doc.toObject(), anios });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

// POST /pdi/config/redistribuir-pesos
// Asigna peso = 100/n de forma equitativa en cada nivel de la jerarquía
// y recalcula avances en cascada.
ctrl.redistribuirPesos = async (req, res) => {
    try {
        // Importar funciones de recálculo en cascada
        const { recalcularMacroproyecto } = require('./pdiProyecto');
        const { recalcularProyecto }       = require('./pdiAccionEstrategica');
        const { recalcularAccion }          = require('./pdiIndicador');

        const peso = (n) => n > 0 ? parseFloat((100 / n).toFixed(6)) : 0;

        const config = await PdiConfig.findById(SINGLETON_ID);

        // 1. Macroproyectos → usar num_macroproyectos del config si está definido, si no la cantidad real
        const macros = await Macro.find();
        if (macros.length) {
            const nMacros = (config?.num_macroproyectos > 0) ? config.num_macroproyectos : macros.length;
            await Macro.updateMany({}, { $set: { peso: peso(nMacros) } });
        }

        // 2. Proyectos → peso igual dentro de su macro
        for (const macro of macros) {
            const proyectos = await Proyecto.find({ macroproyecto_id: macro._id });
            if (proyectos.length) {
                await Proyecto.updateMany(
                    { macroproyecto_id: macro._id },
                    { $set: { peso: peso(proyectos.length) } }
                );
            }
        }

        // 3. Acciones → peso igual dentro de su proyecto
        const todosProyectos = await Proyecto.find();
        for (const proy of todosProyectos) {
            const acciones = await Accion.find({ proyecto_id: proy._id });
            if (acciones.length) {
                await Accion.updateMany(
                    { proyecto_id: proy._id },
                    { $set: { peso: peso(acciones.length) } }
                );
            }
        }

        // 4. Indicadores → peso igual dentro de su acción
        const todasAcciones = await Accion.find();
        for (const acc of todasAcciones) {
            const indicadores = await Indicador.find({ accion_id: acc._id });
            if (indicadores.length) {
                await Indicador.updateMany(
                    { accion_id: acc._id },
                    { $set: { peso: peso(indicadores.length) } }
                );
            }
        }

        // 5. Recalcular avances en cascada de abajo hacia arriba
        // recalcularAccion → recalcularProyecto → recalcularMacroproyecto
        for (const acc of todasAcciones) {
            await recalcularAccion(acc._id);
        }

        res.json({ message: 'Pesos redistribuidos y avances recalculados correctamente.' });
    } catch (e) {
        console.error('Error redistribuirPesos:', e);
        res.status(500).json({ error: e.message });
    }
};

module.exports = ctrl;
