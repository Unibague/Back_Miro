const Proyecto       = require('../models/pdiProyecto');
const Macroproyecto  = require('../models/pdiMacroproyecto');
const AccionEstrategica = require('../models/pdiAccionEstrategica');
const fs = require('fs/promises');
const { withSemaforo } = require('../helpers/pdiSemaforo');
const { parseExecutedWorkbook, getSheetNames, normalizeCode, DEFAULT_SHEET_NAME } = require('../services/pdiBudgetImport');
const { weightedContribution } = require('../services/pdiAvanceCalculator');

function invalidatePresupuestoCache() {
    try {
        require('./pdiPresupuesto').invalidateCache?.();
    } catch (_) { /* cache invalidation is best-effort */ }
}

function mergeDateList(...values) {
    return [...new Set(
        values
            .flatMap((value) => String(value || '').split(/[;,]/))
            .map((value) => value.trim())
            .filter(Boolean)
    )].join(', ');
}

// Mantiene sincronizados los campos legacy responsable/responsable_email (primer
// responsable del array) para que los lectores que aun no soportan el array sigan funcionando.
function syncResponsablesLegacy(payload) {
    if (Array.isArray(payload.responsables) && payload.responsables.length > 0) {
        payload.responsable = payload.responsables[0].nombre || '';
        payload.responsable_email = payload.responsables[0].email || '';
    }
    return payload;
}

// Recalcula el avance del macroproyecto como suma de contribucion ponderada de sus proyectos.
// Macroproyecto es un valor final que se muestra en el tablero, así que aquí
// SÍ se redondea (a diferencia de Acción/Proyecto, que se guardan sin
// redondear para no acumular error a lo largo de la cadena de cálculo).
async function recalcularMacroproyecto(macroproyecto_id) {
    const proyectos = await Proyecto.find({ macroproyecto_id });
    if (!proyectos.length) return;

    const avance = Math.round(weightedContribution(
        proyectos,
        (proyecto) => proyecto.avance,
        (proyecto) => proyecto.peso
    ));
    const presupuesto = proyectos.reduce((acc, p) => acc + (p.presupuesto || 0), 0);
    const presupuesto_ejecutado = proyectos.reduce((acc, p) => acc + (p.presupuesto_ejecutado || 0), 0);

    await Macroproyecto.findByIdAndUpdate(macroproyecto_id, { avance, presupuesto, presupuesto_ejecutado });
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

    const proyecto = await Proyecto.findByIdAndUpdate(proyectoId, { presupuesto_ejecutado }, { new: true });
    if (proyecto) await recalcularMacroproyecto(proyecto.macroproyecto_id);
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
        const doc = await Proyecto.create(syncResponsablesLegacy(req.body));
        await recalcularMacroproyecto(doc.macroproyecto_id);
        res.status(201).json(withSemaforo(doc));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.update = async (req, res) => {
    try {
        const { presupuesto, presupuesto_ejecutado, num_acciones, ...updateData } = req.body;
        if (num_acciones !== undefined) updateData.num_acciones = Number(num_acciones) || 0;
        syncResponsablesLegacy(updateData);

        const doc = await Proyecto.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
        if (!doc) return res.status(404).json({ error: 'No encontrado' });

        if (num_acciones !== undefined && Number(num_acciones) > 0) {
            const Accion = require('../models/pdiAccionEstrategica');
            const peso = parseFloat((100 / Number(num_acciones)).toFixed(6));
            await Accion.updateMany({ proyecto_id: req.params.id }, { $set: { peso } });
        }

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

        const anioImport = String(req.body?.anio || new Date().getFullYear());

        let macroproyecto;

        if (req.body?.macroproyecto_id) {
            macroproyecto = await Macroproyecto.findById(req.body.macroproyecto_id);
            if (!macroproyecto) {
                return res.status(404).json({ error: 'El macroproyecto indicado no existe.' });
            }
            parsed = parseExecutedWorkbook(req.file.path, {
                sheetName: req.body?.sheetName || DEFAULT_SHEET_NAME,
                sheetMatchText: macroproyecto.nombre,
            });
        } else {
            // Modo global: leer TODAS las hojas del Excel y agregar acciones de todas
            const sheetNames = getSheetNames(req.file.path);
            const allActions = [];
            const allProjects = [];
            let firstSheet = null;
            let firstTitle = null;

            for (const sheetName of sheetNames) {
                try {
                    const sheetResult = parseExecutedWorkbook(req.file.path, { sheetName });
                    if (sheetResult.actionsDetected > 0 || sheetResult.projects.length > 0) {
                        allActions.push(...sheetResult.actions);
                        allProjects.push(...sheetResult.projects);
                        if (!firstSheet) { firstSheet = sheetName; firstTitle = sheetResult.projectTitle; }
                    }
                } catch (_) { /* hoja sin estructura reconocible, se omite */ }
            }

            parsed = {
                sheetName: firstSheet || sheetNames[0] || DEFAULT_SHEET_NAME,
                projectTitle: firstTitle,
                rowsRead: allActions.length,
                actionsDetected: allActions.length,
                projects: allProjects,
                actions: allActions,
            };
            macroproyecto = null; // búsqueda global por nombre de acción
        }

        if (!parsed.projects.length) {
            return res.status(400).json({
                error: 'El archivo no contiene filas de ejecución reconocibles para importar.',
                detalle: 'Se esperaban proyectos y acciones con ejecutado en la hoja de presupuesto.',
            });
        }

        // Cargar proyectos: del macro si fue identificado, o todos si no
        const proyectos = macroproyecto
            ? await Proyecto.find({ macroproyecto_id: macroproyecto._id })
            : await Proyecto.find({});
        const projectMap = new Map(
            proyectos.map((proyecto) => [normalizeCode(proyecto.codigo), proyecto])
        );
        const projectNameMap = new Map(
            proyectos.map((proyecto) => [normalizeText(proyecto.nombre), proyecto])
        );
        // Cargar acciones: del macro si fue identificado, o TODAS si no
        const accionesQuery = macroproyecto
            ? { proyecto_id: { $in: proyectos.map((p) => p._id) } }
            : {};
        const accionesDB = await AccionEstrategica.find(accionesQuery)
            .populate('proyecto_id', '_id codigo nombre macroproyecto_id');

        // Mapa global: nombre normalizado → acción (para búsqueda directa sin pasar por proyecto)
        const globalActionByName = new Map();
        const actionsByProjectId = new Map();

        for (const accion of accionesDB) {
            const nn = normalizeText(accion.nombre);
            if (!globalActionByName.has(nn)) globalActionByName.set(nn, accion);
            const projectId = String(accion.proyecto_id?._id ?? accion.proyecto_id);
            if (!actionsByProjectId.has(projectId)) actionsByProjectId.set(projectId, new Map());
            actionsByProjectId.get(projectId).set(nn, accion);
        }

        function findAction(importedActionName, proyectoId) {
            const map = proyectoId ? (actionsByProjectId.get(String(proyectoId)) || new Map()) : globalActionByName;
            const nn = normalizeText(importedActionName);
            let found = map.get(nn);
            if (!found) {
                for (const [key, val] of map) {
                    if (nn.length > 10 && key.includes(nn.slice(0, Math.floor(nn.length * 0.7)))) { found = val; break; }
                    if (nn.length > 10 && nn.includes(key.slice(0, Math.floor(key.length * 0.7)))) { found = val; break; }
                }
            }
            return found || null;
        }

        const proyectosNoEncontrados = [];
        const accionesNoEncontradas = [];

        // Acumular sub-filas (Gasto/Inversión) de la misma acción antes de guardar
        const pendingAcciones = new Map();

        for (const importedAction of parsed.actions) {
            let proyecto = null;
            let accion = null;

            if (macroproyecto) {
                // Modo por macro: buscar proyecto primero, luego acción dentro de él
                proyecto = projectMap.get(normalizeCode(importedAction.codigo_proyecto))
                    || projectNameMap.get(normalizeText(importedAction.nombre_proyecto))
                    || (() => {
                        const cleanName = normalizeText(importedAction.nombre_proyecto || '').replace(/^\d[\d\s.]+/, '').trim();
                        for (const [key, val] of projectNameMap) {
                            if (cleanName && (key.includes(cleanName) || cleanName.includes(key))) return val;
                        }
                        return null;
                    })();

                if (!proyecto) {
                    proyectosNoEncontrados.push({
                        codigo: importedAction.codigo_proyecto || null,
                        nombre_proyecto: importedAction.nombre_proyecto || null,
                        accion: importedAction.nombre_accion,
                        presupuesto_ejecutado: importedAction.presupuesto_ejecutado,
                        fecha_pago: importedAction.fecha_pago || '',
                        fila: importedAction.fila,
                    });
                    continue;
                }
                accion = findAction(importedAction.nombre_accion, proyecto._id);
            } else {
                // Modo global: buscar acción directamente en toda la BD
                proyecto = projectMap.get(normalizeCode(importedAction.codigo_proyecto))
                    || projectNameMap.get(normalizeText(importedAction.nombre_proyecto));
                accion = proyecto
                    ? findAction(importedAction.nombre_accion, proyecto._id)
                    : findAction(importedAction.nombre_accion, null);
                if (accion && !proyecto) proyecto = accion.proyecto_id;
            }

            if (!accion) {
                accionesNoEncontradas.push({
                    proyecto_id: proyecto?._id,
                    codigo_proyecto: proyecto?.codigo,
                    nombre_proyecto: proyecto?.nombre || importedAction.nombre_proyecto,
                    accion_excel: importedAction.nombre_accion,
                    presupuesto_ejecutado: importedAction.presupuesto_ejecutado,
                    fecha_pago: importedAction.fecha_pago || '',
                    fila: importedAction.fila,
                });
                continue;
            }

            // Acumular (evitar que sub-filas Gasto/Inversión de la misma acción se sobreescriban)
            const accionKey = String(accion._id);
            if (!pendingAcciones.has(accionKey)) {
                pendingAcciones.set(accionKey, {
                    accion, proyecto,
                    presupuesto_ejecutado: 0,
                    gasto: 0, inversion: 0,
                    fecha_pago: '',
                    observacion: '', filas: [],
                });
            }
            const pending = pendingAcciones.get(accionKey);
            pending.presupuesto_ejecutado += importedAction.presupuesto_ejecutado;
            pending.gasto += importedAction.gasto || 0;
            pending.inversion += importedAction.inversion || 0;
            pending.fecha_pago = mergeDateList(pending.fecha_pago, importedAction.fecha_pago);
            if (importedAction.observacion) pending.observacion = importedAction.observacion;
            pending.filas.push(importedAction.fila);
        }

        // Guardar acciones acumuladas
        const actualizados = new Map();
        const accionesActualizadasDetalle = [];
        const proyectosTocados = new Set();

        for (const { accion, proyecto, presupuesto_ejecutado, gasto, inversion, fecha_pago, observacion, filas } of pendingAcciones.values()) {
            accion.presupuesto_ejecutado = presupuesto_ejecutado;
            accion.gasto = gasto;
            accion.inversion = inversion;
            accion.fecha_pago = fecha_pago;
            if (!accion.presupuesto_ejecutado_por_anio) accion.presupuesto_ejecutado_por_anio = new Map();
            accion.presupuesto_ejecutado_por_anio.set(anioImport, presupuesto_ejecutado);
            accion.markModified('presupuesto_ejecutado_por_anio');
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
                tipo: gasto > 0 && inversion > 0 ? 'mixto' : gasto > 0 ? 'gasto' : inversion > 0 ? 'inversion' : 'general',
                gasto,
                inversion,
                presupuesto_ejecutado,
                fecha_pago,
                fila_excel: filas[0],
                observacion,
            });
        }

        if (accionesActualizadasDetalle.length === 0) {
            return res.json({
                archivo: req.file.originalname,
                hoja: parsed.sheetName,
                proyecto_excel: parsed.projectTitle,
                macro_detectado: macroproyecto ? { _id: macroproyecto._id, codigo: macroproyecto.codigo, nombre: macroproyecto.nombre } : null,
                filas_leidas: parsed.rowsRead,
                acciones_detectadas: parsed.actionsDetected,
                acciones_actualizadas: 0,
                proyectos_detectados: parsed.projects.length,
                proyectos_actualizados: 0,
                proyectos_no_encontrados: proyectosNoEncontrados.length + accionesNoEncontradas.length,
                totales_importados: { presupuesto_ejecutado: 0, gasto: 0, inversion: 0 },
                actualizados: [],
                acciones: parsed.actions,
                acciones_actualizadas_detalle: [],
                no_encontrados: { proyectos: proyectosNoEncontrados, acciones: accionesNoEncontradas },
                criterio: { presupuesto_ejecutado: '' },
                observacion: 'Ninguna acción del archivo coincidió con las acciones registradas en el sistema.',
            });
        }

        for (const proyectoId of proyectosTocados) {
            const summary = actualizados.get(proyectoId);
            if (summary) {
                summary.presupuesto_ejecutado = await recalcularPresupuestoEjecutadoProyecto(proyectoId);
            }
        }

        invalidatePresupuestoCache();

        const actualizadosList = Array.from(actualizados.values()).sort((a, b) => a.codigo.localeCompare(b.codigo));

        const totalGasto = accionesActualizadasDetalle.reduce((acc, item) => acc + (item.gasto || 0), 0);
        const totalInversion = accionesActualizadasDetalle.reduce((acc, item) => acc + (item.inversion || 0), 0);

        return res.json({
            archivo: req.file.originalname,
            hoja: parsed.sheetName,
            proyecto_excel: parsed.projectTitle,
            macro_detectado: macroproyecto ? { _id: macroproyecto._id, codigo: macroproyecto.codigo, nombre: macroproyecto.nombre } : null,
            filas_leidas: parsed.rowsRead,
            acciones_detectadas: parsed.actionsDetected,
            acciones_actualizadas: accionesActualizadasDetalle.length,
            proyectos_detectados: parsed.projects.length,
            proyectos_actualizados: actualizadosList.length,
            proyectos_no_encontrados: proyectosNoEncontrados.length,
            totales_importados: {
                presupuesto_ejecutado: accionesActualizadasDetalle.reduce((acc, item) => acc + item.presupuesto_ejecutado, 0),
                gasto: totalGasto,
                inversion: totalInversion,
            },
            actualizados: actualizadosList,
            acciones: parsed.actions,
            acciones_actualizadas_detalle: accionesActualizadasDetalle,
            no_encontrados: {
                proyectos: proyectosNoEncontrados,
                acciones: accionesNoEncontradas,
            },
            criterio: {
                presupuesto_ejecutado: 'Se toma el "Total Actividad" de los bloques inferiores. La tabla superior se usa solo para identificar si corresponde a Gasto o Inversion.',
            },
        });
    } catch (e) {
        return res.status(400).json({ error: e.message || 'No fue posible importar la ejecución presupuestal.' });
    } finally {
        if (req.file?.path) {
            await fs.unlink(req.file.path).catch(() => {});
        }
    }
};

module.exports = ctrl;
module.exports.recalcularMacroproyecto = recalcularMacroproyecto;
