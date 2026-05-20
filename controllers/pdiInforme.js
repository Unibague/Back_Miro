const Macroproyecto   = require('../models/pdiMacroproyecto');
const Proyecto        = require('../models/pdiProyecto');
const Accion          = require('../models/pdiAccionEstrategica');
const Indicador       = require('../models/pdiIndicador');
const Respuesta       = require('../models/pdiFormularioRespuesta');
const {
    generarInformeIndicador,
    generarInformeAccion,
    generarInformeProyecto,
    generarInformeMacro,
} = require('../services/pdiInformeWord');
const { uploadFile: uploadDriveFile } = require('../services/pdiDriveStorage');
const {
    getHierarchyForIndicador,
    getHierarchyForAccion,
    getHierarchyForProyecto,
    getHierarchyForMacro,
} = require('../services/pdiDriveHierarchy');

const ctrl = {};

// Agrupa respuestas de formularios por indicador_id
async function getRespuestasPorIndicador(indicadorIds) {
    const respuestas = await Respuesta.find({
        indicador_id: { $in: indicadorIds },
        estado: 'Enviado',
    }).populate('formulario_id', 'nombre').lean();

    const mapa = {};
    for (const r of respuestas) {
        const key = String(r.indicador_id);
        if (!mapa[key]) mapa[key] = [];
        mapa[key].push(r);
    }
    return mapa;
}

async function uploadInformeToDrive(generated, jerarquia) {
    const uploaded = await uploadDriveFile(
        generated.buffer,
        generated.filename,
        generated.mimetype,
        jerarquia
    );

    return {
        filename: generated.filename,
        url: uploaded.webViewLink || uploaded.webContentLink || generated.url,
        local_url: generated.url,
        drive_file_id: uploaded.fileId,
        drive_web_view_link: uploaded.webViewLink || '',
        drive_web_content_link: uploaded.webContentLink || '',
    };
}

// GET /pdi/informes/indicador/:id?corte=2026A
ctrl.informeIndicador = async (req, res) => {
    try {
        const corte = req.query.corte || null;
        const indicador = await Indicador.findById(req.params.id).lean();
        if (!indicador) return res.status(404).json({ error: 'Indicador no encontrado' });

        const respuestasPorIndicador = await getRespuestasPorIndicador([indicador._id]);
        const generated = await generarInformeIndicador({
            indicador,
            respuestasInd: respuestasPorIndicador[String(indicador._id)] ?? [],
            corte,
        });
        const { jerarquia } = await getHierarchyForIndicador(indicador);
        const payload = await uploadInformeToDrive(generated, jerarquia);
        res.json(payload);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// GET /pdi/informes/accion/:id?corte=2026A
ctrl.informeAccion = async (req, res) => {
    try {
        const corte = req.query.corte || null;
        const accion = await Accion.findById(req.params.id).lean();
        if (!accion) return res.status(404).json({ error: 'Accion no encontrada' });

        const indicadores = await Indicador.find({ accion_id: accion._id }).lean();
        const indicadorIds = indicadores.map((i) => i._id);
        const respuestasPorIndicador = await getRespuestasPorIndicador(indicadorIds);

        const generated = await generarInformeAccion({ accion, indicadores, respuestasPorIndicador, corte });
        const { jerarquia } = await getHierarchyForAccion(accion);
        const payload = await uploadInformeToDrive(generated, jerarquia);
        res.json(payload);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// GET /pdi/informes/proyecto/:id?corte=2026A
ctrl.informeProyecto = async (req, res) => {
    try {
        const corte = req.query.corte || null;
        const proyecto = await Proyecto.findById(req.params.id).lean();
        if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado' });

        const acciones = await Accion.find({ proyecto_id: proyecto._id }).lean();
        const accionIds = acciones.map((a) => a._id);
        const indicadores = await Indicador.find({ accion_id: { $in: accionIds } }).lean();
        const indicadorIds = indicadores.map((i) => i._id);

        const indicadoresPorAccion = {};
        for (const ind of indicadores) {
            const key = String(ind.accion_id);
            if (!indicadoresPorAccion[key]) indicadoresPorAccion[key] = [];
            indicadoresPorAccion[key].push(ind);
        }

        const respuestasPorIndicador = await getRespuestasPorIndicador(indicadorIds);

        const generated = await generarInformeProyecto({ proyecto, acciones, indicadoresPorAccion, respuestasPorIndicador, corte });
        const { jerarquia } = await getHierarchyForProyecto(proyecto);
        const payload = await uploadInformeToDrive(generated, jerarquia);
        res.json(payload);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// GET /pdi/informes/macro/:id?corte=2026A
ctrl.informeMacro = async (req, res) => {
    try {
        const corte = req.query.corte || null;
        const macro = await Macroproyecto.findById(req.params.id).lean();
        if (!macro) return res.status(404).json({ error: 'Macroproyecto no encontrado' });

        const proyectos = await Proyecto.find({ macroproyecto_id: macro._id }).lean();
        const proyectoIds = proyectos.map((p) => p._id);
        const acciones = await Accion.find({ proyecto_id: { $in: proyectoIds } }).lean();
        const accionIds = acciones.map((a) => a._id);
        const indicadores = await Indicador.find({ accion_id: { $in: accionIds } }).lean();
        const indicadorIds = indicadores.map((i) => i._id);

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

        const respuestasPorIndicador = await getRespuestasPorIndicador(indicadorIds);

        const generated = await generarInformeMacro({ macro, proyectos, accionesPorProyecto, indicadoresPorAccion, respuestasPorIndicador, corte });
        const { jerarquia } = await getHierarchyForMacro(macro);
        const payload = await uploadInformeToDrive(generated, jerarquia);
        res.json(payload);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

// GET /pdi/informes/lista
ctrl.lista = async (req, res) => {
    try {
        const macros    = await Macroproyecto.find({}).lean();
        const proyectos = await Proyecto.find({}).lean();
        const acciones  = await Accion.find({}).lean();
        const indicadores = await Indicador.find({}).lean();

        const indicadoresPorAccion = {};
        for (const i of indicadores) {
            const key = String(i.accion_id);
            if (!indicadoresPorAccion[key]) indicadoresPorAccion[key] = [];
            indicadoresPorAccion[key].push({
                _id: i._id,
                codigo: i.codigo,
                nombre: i.nombre,
                avance: i.avance,
                responsable: i.responsable,
            });
        }

        const accionesPorProyecto = {};
        for (const a of acciones) {
            const key = String(a.proyecto_id);
            if (!accionesPorProyecto[key]) accionesPorProyecto[key] = [];
            accionesPorProyecto[key].push({
                _id: a._id,
                codigo: a.codigo,
                nombre: a.nombre,
                avance: a.avance,
                responsable: a.responsable,
                indicadores: indicadoresPorAccion[String(a._id)] ?? [],
            });
        }

        const proyectosPorMacro = {};
        for (const p of proyectos) {
            const key = String(p.macroproyecto_id);
            if (!proyectosPorMacro[key]) proyectosPorMacro[key] = [];
            proyectosPorMacro[key].push({
                _id: p._id,
                codigo: p.codigo,
                nombre: p.nombre,
                avance: p.avance,
                responsable: p.responsable,
                acciones: accionesPorProyecto[String(p._id)] ?? [],
            });
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

// GET /pdi/informes/cortes — lista todos los cortes disponibles en el sistema
ctrl.cortes = async (req, res) => {
    try {
        const indicadores = await Indicador.find({}).select('periodos').lean();
        const set = new Set();
        for (const ind of indicadores) {
            for (const p of ind.periodos ?? []) {
                if (p.periodo) set.add(p.periodo);
            }
        }
        const cortes = [...set].sort((a, b) => a.localeCompare(b));
        res.json(cortes);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

module.exports = ctrl;
