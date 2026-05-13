const Macroproyecto   = require('../models/pdiMacroproyecto');
const Proyecto        = require('../models/pdiProyecto');
const Accion          = require('../models/pdiAccionEstrategica');
const Indicador       = require('../models/pdiIndicador');
const { generarInformeProyecto, generarInformeMacro } = require('../services/pdiInformeWord');

const ctrl = {};

// GET /pdi/informes/proyecto/:id
ctrl.informeProyecto = async (req, res) => {
    try {
        const proyecto = await Proyecto.findById(req.params.id).lean();
        if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado' });

        const acciones = await Accion.find({ proyecto_id: proyecto._id }).lean();
        const accionIds = acciones.map((a) => a._id);

        const indicadores = await Indicador.find({ accion_id: { $in: accionIds } }).lean();

        const indicadoresPorAccion = {};
        for (const ind of indicadores) {
            const key = String(ind.accion_id);
            if (!indicadoresPorAccion[key]) indicadoresPorAccion[key] = [];
            indicadoresPorAccion[key].push(ind);
        }

        const { filename, url } = await generarInformeProyecto({ proyecto, acciones, indicadoresPorAccion });
        res.json({ filename, url });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// GET /pdi/informes/macro/:id
ctrl.informeMacro = async (req, res) => {
    try {
        const macro = await Macroproyecto.findById(req.params.id).lean();
        if (!macro) return res.status(404).json({ error: 'Macroproyecto no encontrado' });

        const proyectos = await Proyecto.find({ macroproyecto_id: macro._id }).lean();
        const proyectoIds = proyectos.map((p) => p._id);

        const acciones = await Accion.find({ proyecto_id: { $in: proyectoIds } }).lean();
        const accionIds = acciones.map((a) => a._id);

        const indicadores = await Indicador.find({ accion_id: { $in: accionIds } }).lean();

        const accionesPorProyecto = {};
        for (const acc of acciones) {
            const key = String(acc.proyecto_id);
            if (!accionesPorProyecto[key]) accionesPorProyecto[key] = [];
            accionesPorProyecto[key].push(acc);
        }

        const indicadoresPorAccion = {};
        for (const ind of indicadores) {
            const key = String(ind.accion_id);
            if (!indicadoresPorAccion[key]) indicadoresPorAccion[key] = [];
            indicadoresPorAccion[key].push(ind);
        }

        const { filename, url } = await generarInformeMacro({ macro, proyectos, accionesPorProyecto, indicadoresPorAccion });
        res.json({ filename, url });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// GET /pdi/informes/lista — lista macros con sus proyectos para la vista admin
ctrl.lista = async (req, res) => {
    try {
        const macros    = await Macroproyecto.find({}).lean();
        const proyectos = await Proyecto.find({}).lean();

        const proyectosPorMacro = {};
        for (const p of proyectos) {
            const key = String(p.macroproyecto_id);
            if (!proyectosPorMacro[key]) proyectosPorMacro[key] = [];
            proyectosPorMacro[key].push({ _id: p._id, codigo: p.codigo, nombre: p.nombre, avance: p.avance, responsable: p.responsable });
        }

        res.json(macros.map((m) => ({
            _id:       m._id,
            codigo:    m.codigo,
            nombre:    m.nombre,
            avance:    m.avance,
            lider:     m.lider,
            proyectos: proyectosPorMacro[String(m._id)] ?? [],
        })));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

module.exports = ctrl;
