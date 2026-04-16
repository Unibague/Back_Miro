const Macroproyecto   = require('../models/pdiMacroproyecto');
const Proyecto        = require('../models/pdiProyecto');
const AccionEstrategica = require('../models/pdiAccionEstrategica');
const Indicador       = require('../models/pdiIndicador');
const { getSemaforo } = require('../helpers/pdiSemaforo');

// Calcula el semáforo a partir del avance efectivo de un documento
function semaforoDoc(doc) {
    const avance = doc.avance_total_real != null ? doc.avance_total_real : doc.avance;
    return getSemaforo(avance);
}

// Agrupa una lista de documentos por semáforo y devuelve conteos
function contarSemaforos(docs) {
    return docs.reduce((acc, d) => {
        const s = semaforoDoc(d);
        acc[s] = (acc[s] || 0) + 1;
        return acc;
    }, { verde: 0, amarillo: 0, rojo: 0 });
}

const ctrl = {};

/*
  GET /pdi/dashboard/resumen
  Resumen institucional del PDI:
  - Avance ponderado global
  - Conteo y semáforo de cada nivel
  - Presupuesto total asignado vs ejecutado (proyectos + acciones)
  - Indicadores con alertas en el último periodo reportado
*/
ctrl.resumen = async (req, res) => {
    try {
        const [macros, proyectos, acciones, indicadores] = await Promise.all([
            Macroproyecto.find({}),
            Proyecto.find({}),
            AccionEstrategica.find({}),
            Indicador.find({}).populate('accion_id', 'proyecto_id'),
        ]);

        // Avance ponderado global (promedio ponderado de macroproyectos)
        const totalPesoMacro = macros.reduce((a, m) => a + m.peso, 0);
        const avanceGlobal = totalPesoMacro > 0
            ? Math.round(macros.reduce((a, m) => a + (m.avance * m.peso), 0) / totalPesoMacro)
            : 0;

        // Presupuesto
        const presupuestoTotal    = proyectos.reduce((a, p) => a + (p.presupuesto || 0), 0)
                                  + acciones.reduce((a, p) => a + (p.presupuesto || 0), 0);
        const presupuestoEjecutado = proyectos.reduce((a, p) => a + (p.presupuesto_ejecutado || 0), 0)
                                   + acciones.reduce((a, p) => a + (p.presupuesto_ejecutado || 0), 0);

        // Indicadores con alertas activas en cualquier periodo
        const conAlertas = indicadores.filter(ind =>
            ind.periodos.some(p => p.alertas && p.alertas.trim() !== '')
        ).map(ind => ({
            _id:    ind._id,
            codigo: ind.codigo,
            nombre: ind.nombre,
            avance: ind.avance_total_real ?? ind.avance,
            semaforo: semaforoDoc(ind),
            alertas: ind.periodos.filter(p => p.alertas).map(p => ({ periodo: p.periodo, alertas: p.alertas })),
        }));

        // Indicadores con retrasos justificados
        const conRetrasos = indicadores.filter(ind =>
            ind.periodos.some(p => p.justificacion_retrasos && p.justificacion_retrasos.trim() !== '')
        ).length;

        res.json({
            avance_global: avanceGlobal,
            semaforo_global: getSemaforo(avanceGlobal),
            estructura: {
                macroproyectos: macros.length,
                proyectos:      proyectos.length,
                acciones:       acciones.length,
                indicadores:    indicadores.length,
            },
            semaforos: {
                macroproyectos: contarSemaforos(macros),
                proyectos:      contarSemaforos(proyectos),
                acciones:       contarSemaforos(acciones),
                indicadores:    contarSemaforos(indicadores),
            },
            presupuesto: {
                total:     presupuestoTotal,
                ejecutado: presupuestoEjecutado,
                porcentaje_ejecucion: presupuestoTotal > 0
                    ? Math.round((presupuestoEjecutado / presupuestoTotal) * 100)
                    : 0,
            },
            alertas: {
                indicadores_con_alertas: conAlertas.length,
                detalle: conAlertas,
            },
            retrasos: {
                indicadores_con_retrasos: conRetrasos,
            },
        });
    } catch (e) {
        res.status(500).json({ error: 'Error interno', detalle: e.message });
    }
};

/*
  GET /pdi/dashboard/macroproyecto/:id
  Detalle del tablero de un macroproyecto: proyectos hijos, semáforos, avances por año
*/
ctrl.macroproyecto = async (req, res) => {
    try {
        const macro = await Macroproyecto.findById(req.params.id);
        if (!macro) return res.status(404).json({ error: 'Macroproyecto no encontrado' });

        const proyectos = await Proyecto.find({ macroproyecto_id: macro._id });
        const proyectoIds = proyectos.map(p => p._id);

        const acciones = await AccionEstrategica.find({ proyecto_id: { $in: proyectoIds } });
        const accionIds = acciones.map(a => a._id);

        const indicadores = await Indicador.find({ accion_id: { $in: accionIds } });

        // Avances por año agregados (union de todos los años presentes en los indicadores)
        const avancesPorAnio = {};
        for (const ind of indicadores) {
            if (ind.avances_por_anio) {
                for (const [anio, val] of Object.entries(ind.avances_por_anio)) {
                    if (!avancesPorAnio[anio]) avancesPorAnio[anio] = { suma: 0, count: 0 };
                    avancesPorAnio[anio].suma  += val;
                    avancesPorAnio[anio].count += 1;
                }
            }
        }
        const avancesPorAnioPromedio = {};
        for (const [anio, { suma, count }] of Object.entries(avancesPorAnio)) {
            avancesPorAnioPromedio[anio] = count > 0 ? Math.round(suma / count) : 0;
        }

        // Presupuesto del macroproyecto (suma de proyectos)
        const presupuestoTotal    = proyectos.reduce((a, p) => a + (p.presupuesto || 0), 0);
        const presupuestoEjecutado = proyectos.reduce((a, p) => a + (p.presupuesto_ejecutado || 0), 0);

        res.json({
            macroproyecto: { ...macro.toObject(), semaforo: semaforoDoc(macro) },
            estructura: {
                proyectos:   proyectos.length,
                acciones:    acciones.length,
                indicadores: indicadores.length,
            },
            semaforos: {
                proyectos:   contarSemaforos(proyectos),
                acciones:    contarSemaforos(acciones),
                indicadores: contarSemaforos(indicadores),
            },
            avances_por_anio: avancesPorAnioPromedio,
            presupuesto: {
                total:     presupuestoTotal,
                ejecutado: presupuestoEjecutado,
                porcentaje_ejecucion: presupuestoTotal > 0
                    ? Math.round((presupuestoEjecutado / presupuestoTotal) * 100)
                    : 0,
            },
            proyectos: proyectos.map(p => ({
                _id:     p._id,
                codigo:  p.codigo,
                nombre:  p.nombre,
                avance:  p.avance,
                semaforo: getSemaforo(p.avance),
                presupuesto:          p.presupuesto,
                presupuesto_ejecutado: p.presupuesto_ejecutado,
            })),
        });
    } catch (e) {
        res.status(500).json({ error: 'Error interno', detalle: e.message });
    }
};

/*
  GET /pdi/dashboard/corte/:periodo
  Resumen del avance para un corte/periodo específico (ej: "2026A")
  Devuelve indicadores con y sin reporte en ese periodo, estado de envío y alertas
*/
ctrl.corte = async (req, res) => {
    try {
        const { periodo } = req.params;
        if (!periodo) return res.status(400).json({ error: 'Parámetro periodo requerido' });

        const indicadores = await Indicador.find({})
            .populate('accion_id', 'codigo nombre proyecto_id');

        const conPeriodo = [];
        const sinPeriodo = [];

        for (const ind of indicadores) {
            const p = ind.periodos.find(x => x.periodo === periodo);
            if (p) {
                conPeriodo.push({
                    _id:     ind._id,
                    codigo:  ind.codigo,
                    nombre:  ind.nombre,
                    responsable:        ind.responsable,
                    responsable_email:  ind.responsable_email,
                    avance:             p.avance,
                    meta:               p.meta,
                    semaforo:           getSemaforo(p.avance ?? 0),
                    estado_reporte:     p.estado_reporte,
                    fecha_envio:        p.fecha_envio,
                    tiene_alertas:      !!(p.alertas && p.alertas.trim()),
                    tiene_retrasos:     !!(p.justificacion_retrasos && p.justificacion_retrasos.trim()),
                    resultados_alcanzados: p.resultados_alcanzados,
                    logros:             p.logros,
                    alertas:            p.alertas,
                    justificacion_retrasos: p.justificacion_retrasos,
                });
            } else {
                sinPeriodo.push({
                    _id:    ind._id,
                    codigo: ind.codigo,
                    nombre: ind.nombre,
                    responsable:       ind.responsable,
                    responsable_email: ind.responsable_email,
                });
            }
        }

        // Conteo por estado de reporte
        const estadosReporte = conPeriodo.reduce((acc, i) => {
            acc[i.estado_reporte] = (acc[i.estado_reporte] || 0) + 1;
            return acc;
        }, {});

        res.json({
            periodo,
            total_indicadores:     indicadores.length,
            con_reporte:           conPeriodo.length,
            sin_reporte:           sinPeriodo.length,
            porcentaje_cobertura:  indicadores.length > 0
                ? Math.round((conPeriodo.length / indicadores.length) * 100)
                : 0,
            estados_reporte: estadosReporte,
            semaforos:       contarSemaforos(conPeriodo.map(i => ({ avance: i.avance ?? 0 }))),
            con_alertas:     conPeriodo.filter(i => i.tiene_alertas).length,
            con_retrasos:    conPeriodo.filter(i => i.tiene_retrasos).length,
            indicadores_reportados: conPeriodo,
            indicadores_pendientes: sinPeriodo,
        });
    } catch (e) {
        res.status(500).json({ error: 'Error interno', detalle: e.message });
    }
};

module.exports = ctrl;
