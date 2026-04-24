const Proyecto       = require('../models/pdiProyecto');
const Macroproyecto  = require('../models/pdiMacroproyecto');
const AccionEstrategica = require('../models/pdiAccionEstrategica');
const fs = require('fs/promises');
const { withSemaforo } = require('../helpers/pdiSemaforo');
const { parseExecutedWorkbook, normalizeCode, DEFAULT_SHEET_NAME } = require('../services/pdiBudgetImport');

function normalizePeso(peso) {
    const value = Number(peso) || 0;
    return value <= 1 ? value * 100 : value;
}

// Recalcula el avance del macroproyecto como suma de contribucion ponderada de sus proyectos
async function recalcularMacroproyecto(macroproyecto_id) {
    const proyectos = await Proyecto.find({ macroproyecto_id });
    if (!proyectos.length) return;

    const avance = Math.round(
        proyectos.reduce((acc, p) => acc + ((Number(p.avance) || 0) * normalizePeso(p.peso)), 0) / 100
    );

    await Macroproyecto.findByIdAndUpdate(macroproyecto_id, { avance });
}

const ctrl = {};

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

async function recalcularPresupuestoEjecutadoProyecto(proyectoId) {
    const acciones = await AccionEstrategica.find({ proyecto_id: proyectoId }, { presupuesto_ejecutado: 1 }).lean();
    const presupuesto_ejecutado = acciones.reduce(
        (acc, accion) => acc + (accion.presupuesto_ejecutado || 0),
        0
    );

    await Proyecto.findByIdAndUpdate(proyectoId, { presupuesto_ejecutado });
    return presupuesto_ejecutado;
}

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

ctrl.importExecuted = async (req, res) => {
    let parsed;

    try {
        if (!req.file?.path) {
            return res.status(400).json({ error: 'Debes adjuntar un archivo Excel en el campo "file".' });
        }

        if (!req.body?.macroproyecto_id) {
            return res.status(400).json({ error: 'Debes indicar el macroproyecto a actualizar.' });
        }

        const macroproyecto = await Macroproyecto.findById(req.body.macroproyecto_id);
        if (!macroproyecto) {
            return res.status(404).json({ error: 'El macroproyecto indicado no existe.' });
        }

        parsed = parseExecutedWorkbook(req.file.path, {
            sheetName: req.body?.sheetName || DEFAULT_SHEET_NAME,
            sheetMatchText: macroproyecto.nombre,
        });

        if (!parsed.projects.length) {
            return res.status(400).json({
                error: 'El archivo no contiene filas de ejecucion reconocibles para importar.',
                detalle: 'Se esperaban proyectos y acciones con ejecutado en la hoja de presupuesto.',
            });
        }

        const proyectos = await Proyecto.find({ macroproyecto_id: req.body.macroproyecto_id });
        const projectMap = new Map(
            proyectos.map((proyecto) => [normalizeCode(proyecto.codigo), proyecto])
        );
        const projectNameMap = new Map(
            proyectos.map((proyecto) => [normalizeText(proyecto.nombre), proyecto])
        );
        const acciones = await AccionEstrategica.find({ proyecto_id: { $in: proyectos.map((proyecto) => proyecto._id) } });
        const actionsByProjectId = new Map();

        for (const accion of acciones) {
            const projectId = String(accion.proyecto_id);
            if (!actionsByProjectId.has(projectId)) {
                actionsByProjectId.set(projectId, new Map());
            }
            actionsByProjectId.get(projectId).set(normalizeText(accion.nombre), accion);
        }

        const actualizados = new Map();
        const proyectosNoEncontrados = [];
        const accionesActualizadasDetalle = [];
        const accionesNoEncontradas = [];
        const proyectosTocados = new Set();

        for (const importedAction of parsed.actions) {
            const proyecto = projectMap.get(normalizeCode(importedAction.codigo_proyecto))
                || projectNameMap.get(normalizeText(importedAction.nombre_proyecto));

            if (!proyecto) {
                proyectosNoEncontrados.push({
                    codigo: importedAction.codigo_proyecto || null,
                    nombre_proyecto: importedAction.nombre_proyecto || null,
                    accion: importedAction.nombre_accion,
                    presupuesto_ejecutado: importedAction.presupuesto_ejecutado,
                    fila: importedAction.fila,
                });
                continue;
            }

            const actionMap = actionsByProjectId.get(String(proyecto._id)) || new Map();
            const accion = actionMap.get(normalizeText(importedAction.nombre_accion));

            if (!accion) {
                accionesNoEncontradas.push({
                    proyecto_id: proyecto._id,
                    codigo_proyecto: proyecto.codigo,
                    nombre_proyecto: proyecto.nombre,
                    accion_excel: importedAction.nombre_accion,
                    presupuesto_ejecutado: importedAction.presupuesto_ejecutado,
                    fila: importedAction.fila,
                });
                continue;
            }

            accion.presupuesto_ejecutado = importedAction.presupuesto_ejecutado;
            await accion.save();
            proyectosTocados.add(String(proyecto._id));

            const currentProjectSummary = actualizados.get(String(proyecto._id)) || {
                _id: proyecto._id,
                codigo: proyecto.codigo,
                nombre: proyecto.nombre,
                presupuesto_ejecutado: 0,
                acciones_importadas: 0,
                acciones_actualizadas: 0,
            };
            currentProjectSummary.acciones_importadas += 1;
            currentProjectSummary.acciones_actualizadas += 1;
            actualizados.set(String(proyecto._id), currentProjectSummary);

            accionesActualizadasDetalle.push({
                _id: accion._id,
                codigo: accion.codigo,
                nombre: accion.nombre,
                proyecto_id: proyecto._id,
                codigo_proyecto: proyecto.codigo,
                nombre_proyecto: proyecto.nombre,
                presupuesto_ejecutado: accion.presupuesto_ejecutado,
                fila_excel: importedAction.fila,
                observacion: importedAction.observacion || '',
            });
        }

        if (accionesActualizadasDetalle.length === 0) {
            return res.status(400).json({
                error: `El archivo no contiene proyectos del macroproyecto ${macroproyecto.codigo}.`,
                detalle: `Se detectaron filas para ${parsed.projects.map((item) => item.codigo || item.nombre_proyecto).join(', ')}, pero no hubo acciones que coincidieran con ${macroproyecto.codigo}.`,
            });
        }

        for (const proyectoId of proyectosTocados) {
            const summary = actualizados.get(proyectoId);
            if (summary) {
                summary.presupuesto_ejecutado = await recalcularPresupuestoEjecutadoProyecto(proyectoId);
            }
        }

        const actualizadosList = Array.from(actualizados.values()).sort((a, b) => a.codigo.localeCompare(b.codigo));

        return res.json({
            archivo: req.file.originalname,
            hoja: parsed.sheetName,
            proyecto_excel: parsed.projectTitle,
            filas_leidas: parsed.rowsRead,
            acciones_detectadas: parsed.actionsDetected,
            acciones_actualizadas: accionesActualizadasDetalle.length,
            proyectos_detectados: parsed.projects.length,
            proyectos_actualizados: actualizadosList.length,
            proyectos_no_encontrados: proyectosNoEncontrados.length,
            totales_importados: {
                presupuesto_ejecutado: accionesActualizadasDetalle.reduce((acc, item) => acc + item.presupuesto_ejecutado, 0),
            },
            actualizados: actualizadosList,
            acciones: parsed.actions,
            acciones_actualizadas_detalle: accionesActualizadasDetalle,
            no_encontrados: {
                proyectos: proyectosNoEncontrados,
                acciones: accionesNoEncontradas,
            },
            criterio: {
                presupuesto_ejecutado: 'Se toma la columna "Ejecucion ano 2026" por accion y el proyecto queda con la suma de sus acciones actualizadas.',
            },
            observacion: 'La importacion actualiza primero cada accion encontrada y luego recalcula el presupuesto ejecutado del proyecto como suma de esas acciones.',
        });
    } catch (e) {
        return res.status(400).json({ error: e.message || 'No fue posible importar la ejecucion presupuestal.' });
    } finally {
        if (req.file?.path) {
            await fs.unlink(req.file.path).catch(() => {});
        }
    }
};

module.exports = ctrl;
module.exports.recalcularMacroproyecto = recalcularMacroproyecto;
