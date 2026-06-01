const Corte      = require('../models/pdiCorte');
const Indicador  = require('../models/pdiIndicador');
const Accion     = require('../models/pdiAccionEstrategica');
const Proyecto   = require('../models/pdiProyecto');
const Macro      = require('../models/pdiMacroproyecto');
const { notifyPdiPeriodUsers } = require('../services/pdiCorteNotifications');

const ctrl = {};

const bogotaDateKey = (value = new Date()) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;

    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);

    const year = parts.find((p) => p.type === 'year')?.value;
    const month = parts.find((p) => p.type === 'month')?.value;
    const day = parts.find((p) => p.type === 'day')?.value;
    return Number(`${year}${month}${day}`);
};

const isCorteVigente = (corte, todayKey = bogotaDateKey()) => {
    if (!corte.activo) return false;
    if (!corte.fecha_inicio && !corte.fecha_fin) return true;

    const desde = corte.fecha_inicio ? bogotaDateKey(corte.fecha_inicio) : null;
    const hasta = corte.fecha_fin ? bogotaDateKey(corte.fecha_fin) : null;

    if (desde && todayKey < desde) return false;
    if (hasta && todayKey > hasta) return false;
    return true;
};

ctrl.getAll = async (req, res) => {
    try {
        const docs = await Corte.find().sort({ orden: 1, nombre: 1 });
        res.json(docs);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.getActivos = async (req, res) => {
    try {
        const docs = await Corte.find({ activo: true }).sort({ orden: 1, nombre: 1 });
        res.json(docs);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

// Retorna los cortes activos cuya ventana de calificación está vigente hoy
ctrl.getVigentes = async (req, res) => {
    try {
        const todayKey = bogotaDateKey();
        const docs = await Corte.find({ activo: true }).sort({ orden: 1, nombre: 1 });
        const vigentes = docs.filter(c => isCorteVigente(c, todayKey));
        res.json(vigentes);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.create = async (req, res) => {
    try {
        const doc = await Corte.create(req.body);
        res.status(201).json(doc);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.update = async (req, res) => {
    try {
        const doc = await Corte.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        res.json(doc);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.remove = async (req, res) => {
    try {
        const doc = await Corte.findByIdAndDelete(req.params.id);
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        res.json({ message: 'Corte eliminado' });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

// Resumen completo del PDI para un corte específico
// Devuelve jerarquía: macroproyectos → proyectos → acciones → indicadores
// con el avance y meta del periodo de ese corte
ctrl.notificarUsuarios = async (req, res) => {
    try {
        const corte = await Corte.findById(req.params.id);
        if (!corte) return res.status(404).json({ error: 'Corte no encontrado' });

        if (!isCorteVigente(corte)) {
            return res.status(400).json({
                error: 'El corte no se encuentra abierto. Activa el corte o ajusta sus fechas antes de notificar.',
            });
        }

        const result = await notifyPdiPeriodUsers(corte);
        if (result.total > 0 && result.enviados === 0 && result.fallidos > 0) {
            const firstError = result.errores?.[0]?.error;
            return res.status(502).json({
                error: `No se envio ningun correo.${firstError ? ` ${firstError}` : ''}`,
                message: `No se pudo notificar el corte ${corte.nombre}.`,
                ...result,
            });
        }

        res.json({
            message: `Notificacion enviada para el corte ${corte.nombre}.`,
            ...result,
        });
    } catch (e) {
        console.error('Error notificando usuarios PDI:', e);
        res.status(500).json({ error: e.message || 'Error interno' });
    }
};

ctrl.getResumenCorte = async (req, res) => {
    try {
        const corte = await Corte.findById(req.params.id);
        if (!corte) return res.status(404).json({ error: 'Corte no encontrado' });

        const nombreCorte = corte.nombre;

        // Todos los indicadores que tienen ese periodo registrado
        const indicadores = await Indicador.find({ 'periodos.periodo': nombreCorte })
            .populate({ path: 'accion_id', populate: { path: 'proyecto_id', populate: { path: 'macroproyecto_id' } } });

        // Construir jerarquía agrupada
        const macroMap = {};

        for (const ind of indicadores) {
            const accion   = ind.accion_id;
            if (!accion) continue;
            const proyecto = accion.proyecto_id;
            if (!proyecto) continue;
            const macro    = proyecto.macroproyecto_id;
            if (!macro) continue;

            const periodoData = ind.periodos.find(p => p.periodo === nombreCorte);

            const macroId   = macro._id.toString();
            const proyId    = proyecto._id.toString();
            const accionId  = accion._id.toString();

            if (!macroMap[macroId]) {
                macroMap[macroId] = {
                    _id: macroId, codigo: macro.codigo, nombre: macro.nombre,
                    peso: macro.peso, avance: macro.avance, semaforo: macro.semaforo,
                    proyectos: {},
                };
            }
            if (!macroMap[macroId].proyectos[proyId]) {
                macroMap[macroId].proyectos[proyId] = {
                    _id: proyId, codigo: proyecto.codigo, nombre: proyecto.nombre,
                    peso: proyecto.peso, avance: proyecto.avance, semaforo: proyecto.semaforo,
                    formulador: proyecto.formulador, responsable: proyecto.responsable,
                    acciones: {},
                };
            }
            if (!macroMap[macroId].proyectos[proyId].acciones[accionId]) {
                macroMap[macroId].proyectos[proyId].acciones[accionId] = {
                    _id: accionId, codigo: accion.codigo, nombre: accion.nombre,
                    peso: accion.peso, avance: accion.avance, semaforo: accion.semaforo,
                    indicadores: [],
                };
            }

            macroMap[macroId].proyectos[proyId].acciones[accionId].indicadores.push({
                _id: ind._id, codigo: ind.codigo, nombre: ind.nombre,
                peso: ind.peso, avance: ind.avance, semaforo: ind.semaforo,
                responsable: ind.responsable, meta_final_2029: ind.meta_final_2029,
                tipo_calculo: ind.tipo_calculo, observaciones: ind.observaciones,
                meta_corte:   periodoData?.meta   ?? null,
                avance_corte: periodoData?.avance ?? null,
            });
        }

        // Convertir maps a arrays
        const resultado = Object.values(macroMap).map(m => ({
            ...m,
            proyectos: Object.values(m.proyectos).map(p => ({
                ...p,
                acciones: Object.values(p.acciones),
            })),
        }));

        res.json({ corte, jerarquia: resultado });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error interno' });
    }
};

module.exports = ctrl;
