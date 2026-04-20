const Proyecto       = require('../models/pdiProyecto');
const Macroproyecto  = require('../models/pdiMacroproyecto');
const AccionEstrategica = require('../models/pdiAccionEstrategica');
const fs = require('fs/promises');
const { withSemaforo } = require('../helpers/pdiSemaforo');
const { parseBudgetWorkbook, parseExecutedWorkbook, normalizeCode, DEFAULT_SHEET_NAME } = require('../services/pdiBudgetImport');

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

ctrl.importBudget = async (req, res) => {
    let parsed;

    try {
        if (!req.file?.path) {
            return res.status(400).json({ error: 'Debes adjuntar un archivo Excel en el campo "file".' });
        }

        parsed = parseBudgetWorkbook(req.file.path, {
            sheetName: req.body?.sheetName || DEFAULT_SHEET_NAME,
        });

        if (!parsed.projects.length) {
            return res.status(400).json({
                error: 'El archivo no contiene filas de presupuesto reconocibles para importar.',
                detalle: 'Se esperaban codigos de accion con formato Mx-Px-AEx en la hoja de presupuesto.',
            });
        }

        const [proyectos, acciones] = await Promise.all([
            Proyecto.find({}),
            AccionEstrategica.find({}),
        ]);
        const projectMap = new Map(
            proyectos.map((proyecto) => [normalizeCode(proyecto.codigo), proyecto])
        );
        const actionMap = new Map(
            acciones.map((accion) => [normalizeCode(accion.codigo), accion])
        );

        const actualizados = [];
        const noEncontrados = [];
        const accionesActualizadas = [];

        for (const importedProject of parsed.projects) {
            const proyecto = projectMap.get(importedProject.codigo);

            if (!proyecto) {
                noEncontrados.push(importedProject);
                continue;
            }

            proyecto.presupuesto = importedProject.presupuesto;
            proyecto.presupuesto_ejecutado = 0;
            await proyecto.save();

            for (const actionCode of importedProject.codigos_accion) {
                const importedAction = parsed.actions.find((item) => item.codigo_accion === actionCode);
                const accion = actionMap.get(actionCode);
                if (!importedAction || !accion) continue;

                accion.presupuesto = importedAction.presupuesto;
                accion.presupuesto_ejecutado = 0;
                await accion.save();

                accionesActualizadas.push({
                    _id: accion._id,
                    codigo: accion.codigo,
                    nombre: accion.nombre,
                    proyecto_codigo: importedProject.codigo,
                    presupuesto: accion.presupuesto,
                    presupuesto_ejecutado: accion.presupuesto_ejecutado,
                });
            }

            actualizados.push({
                _id: proyecto._id,
                codigo: proyecto.codigo,
                nombre: proyecto.nombre,
                presupuesto: proyecto.presupuesto,
                presupuesto_ejecutado: proyecto.presupuesto_ejecutado,
                acciones_importadas: importedProject.acciones,
                acciones_actualizadas: importedProject.codigos_accion.filter((codigo) => actionMap.has(codigo)).length,
            });
        }

        return res.json({
            archivo: req.file.originalname,
            hoja: parsed.sheetName,
            proyecto_excel: parsed.projectTitle,
            filas_leidas: parsed.rowsRead,
            acciones_detectadas: parsed.actionsDetected,
            acciones_actualizadas: accionesActualizadas.length,
            proyectos_detectados: parsed.projects.length,
            proyectos_actualizados: actualizados.length,
            proyectos_no_encontrados: noEncontrados.length,
            totales_importados: {
                presupuesto: parsed.projects.reduce((acc, item) => acc + item.presupuesto, 0),
            },
            actualizados,
            acciones: parsed.actions,
            acciones_actualizadas_detalle: accionesActualizadas,
            no_encontrados: noEncontrados,
            criterio: {
                presupuesto: 'Suma de la columna "Presupuesto Total de la Accion Estrategica".',
            },
            observacion: 'Este archivo solo actualiza presupuesto asignado. La ejecucion presupuestal se importara por separado.',
        });
    } catch (e) {
        return res.status(400).json({ error: e.message || 'No fue posible importar el presupuesto.' });
    } finally {
        if (req.file?.path) {
            await fs.unlink(req.file.path).catch(() => {});
        }
    }
};

ctrl.importExecuted = async (req, res) => {
    let parsed;

    try {
        if (!req.file?.path) {
            return res.status(400).json({ error: 'Debes adjuntar un archivo Excel en el campo "file".' });
        }

        parsed = parseExecutedWorkbook(req.file.path, {
            sheetName: req.body?.sheetName || DEFAULT_SHEET_NAME,
        });

        if (!parsed.projects.length) {
            return res.status(400).json({
                error: 'El archivo no contiene filas de ejecucion reconocibles para importar.',
                detalle: 'Se esperaban codigos de accion con formato Mx-Px-AEx en la hoja de presupuesto.',
            });
        }

        const [proyectos, acciones] = await Promise.all([
            Proyecto.find({}),
            AccionEstrategica.find({}),
        ]);
        const projectMap = new Map(
            proyectos.map((proyecto) => [normalizeCode(proyecto.codigo), proyecto])
        );
        const actionMap = new Map(
            acciones.map((accion) => [normalizeCode(accion.codigo), accion])
        );

        const actualizados = [];
        const noEncontrados = [];
        const accionesActualizadas = [];

        for (const importedProject of parsed.projects) {
            const proyecto = projectMap.get(importedProject.codigo);

            if (!proyecto) {
                noEncontrados.push(importedProject);
                continue;
            }

            proyecto.presupuesto_ejecutado = importedProject.presupuesto_ejecutado;
            await proyecto.save();

            for (const actionCode of importedProject.codigos_accion) {
                const importedAction = parsed.actions.find((item) => item.codigo_accion === actionCode);
                const accion = actionMap.get(actionCode);
                if (!importedAction || !accion) continue;

                accion.presupuesto_ejecutado = importedAction.presupuesto_ejecutado;
                await accion.save();

                accionesActualizadas.push({
                    _id: accion._id,
                    codigo: accion.codigo,
                    nombre: accion.nombre,
                    proyecto_codigo: importedProject.codigo,
                    presupuesto_ejecutado: accion.presupuesto_ejecutado,
                });
            }

            actualizados.push({
                _id: proyecto._id,
                codigo: proyecto.codigo,
                nombre: proyecto.nombre,
                presupuesto_ejecutado: proyecto.presupuesto_ejecutado,
                acciones_importadas: importedProject.acciones,
                acciones_actualizadas: importedProject.codigos_accion.filter((codigo) => actionMap.has(codigo)).length,
            });
        }

        return res.json({
            archivo: req.file.originalname,
            hoja: parsed.sheetName,
            proyecto_excel: parsed.projectTitle,
            filas_leidas: parsed.rowsRead,
            acciones_detectadas: parsed.actionsDetected,
            acciones_actualizadas: accionesActualizadas.length,
            proyectos_detectados: parsed.projects.length,
            proyectos_actualizados: actualizados.length,
            proyectos_no_encontrados: noEncontrados.length,
            totales_importados: {
                presupuesto_ejecutado: parsed.projects.reduce((acc, item) => acc + item.presupuesto_ejecutado, 0),
            },
            actualizados,
            acciones: parsed.actions,
            acciones_actualizadas_detalle: accionesActualizadas,
            no_encontrados: noEncontrados,
            criterio: {
                presupuesto_ejecutado: 'Suma de las columnas de Gastos e Inversion por anio presentes en la hoja.',
            },
            observacion: 'Este archivo solo actualiza la ejecucion presupuestal. El presupuesto asignado no se modifica.',
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
