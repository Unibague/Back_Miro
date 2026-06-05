const Macroproyecto   = require('../models/pdiMacroproyecto');
const Proyecto        = require('../models/pdiProyecto');
const AccionEstrategica = require('../models/pdiAccionEstrategica');
const Indicador       = require('../models/pdiIndicador');
const Corte           = require('../models/pdiCorte');
const { getSemaforo } = require('../helpers/pdiSemaforo');
const pdiNodeNetwork  = require('../services/pdiNodeNetwork');

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

function clampAvance(value) {
    return Math.min(Math.max(Number(value) || 0, 0), 100);
}

function promedioAvance(docs) {
    if (!docs.length) return 0;
    return Math.round(
        docs.reduce((acc, doc) => acc + clampAvance(doc.avance_total_real != null ? doc.avance_total_real : doc.avance), 0) / docs.length
    );
}

const ctrl = {};

/*
  GET /pdi/dashboard/resumen
  Resumen institucional del PDI:
  - Avance ponderado global
  - Conteo y semáforo de cada nivel
  - Presupuesto total asignado vs ejecutado (proyectos)
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

        // Presupuesto — suma desde macroproyectos (cada uno agrega sus proyectos)
        const presupuestoTotal = macros.reduce((a, m) => a + (m.presupuesto || 0), 0);
        const presupuestoEjecutado = macros.reduce((a, m) => a + (m.presupuesto_ejecutado || 0), 0);

        // Reportes pendientes: indicadores sin avance registrado
        const conAlertas = indicadores.filter(ind => {
            const avance = ind.avance_total_real ?? ind.avance ?? 0;
            return Number(avance) === 0;
        }).map(ind => ({
            _id:     ind._id,
            codigo:  ind.codigo,
            nombre:  ind.nombre,
            avance:  0,
            semaforo: semaforoDoc(ind),
            alertas: [],
        }));

        // Indicadores con retrasos justificados
        const conRetrasos = indicadores.filter(ind =>
            ind.periodos.some(p => p.justificacion_retrasos && p.justificacion_retrasos.trim() !== '')
        ).length;

        res.json({
            avance_global: avanceGlobal,
            semaforo_global: getSemaforo(avanceGlobal),
            avances_por_nivel: {
                macroproyectos: promedioAvance(macros),
                proyectos: promedioAvance(proyectos),
                acciones: promedioAvance(acciones),
                indicadores: promedioAvance(indicadores),
            },
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
            avances_por_nivel: {
                macroproyecto: clampAvance(macro.avance),
                proyectos: promedioAvance(proyectos),
                acciones: promedioAvance(acciones),
                indicadores: promedioAvance(indicadores),
            },
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
            // Solo considerar indicadores que tienen meta definida para este periodo
            if (!p || p.meta == null || p.meta === '') continue;
            const estadoReporte = p.estado_reporte || 'Borrador';
            const tieneReporteEnviado = p.fecha_envio != null || estadoReporte !== 'Borrador';

            if (tieneReporteEnviado) {
                conPeriodo.push({
                    _id:     ind._id,
                    codigo:  ind.codigo,
                    nombre:  ind.nombre,
                    responsable:        ind.responsable,
                    responsable_email:  ind.responsable_email,
                    avance:             p.avance,
                    meta:               p.meta,
                    semaforo:           getSemaforo(p.avance ?? 0),
                    estado_reporte:     estadoReporte,
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

        const totalConMeta = conPeriodo.length + sinPeriodo.length;

        // Conteo por estado de reporte
        const estadosReporte = conPeriodo.reduce((acc, i) => {
            acc[i.estado_reporte] = (acc[i.estado_reporte] || 0) + 1;
            return acc;
        }, {});

        res.json({
            periodo,
            total_indicadores:     totalConMeta,
            con_reporte:           conPeriodo.length,
            sin_reporte:           sinPeriodo.length,
            porcentaje_cobertura:  totalConMeta > 0
                ? Math.round((conPeriodo.length / totalConMeta) * 100)
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

/*
  GET /pdi/dashboard/red-nodos
  Red de interdependencias entre proyectos PDI, construida desde la matriz Excel
  y con override editable guardado como JSON.
*/
ctrl.redNodos = async (req, res) => {
    try {
        const network = await pdiNodeNetwork.getNetwork();
        res.json(network);
    } catch (e) {
        res.status(500).json({ error: 'Error interno', detalle: e.message });
    }
};

/*
  PUT /pdi/dashboard/red-nodos
  Guarda una version editable de la red sin modificar la matriz Excel original.
*/
ctrl.guardarRedNodos = async (req, res) => {
    try {
        const network = await pdiNodeNetwork.saveNetwork(req.body);
        res.json(network);
    } catch (e) {
        res.status(400).json({ error: 'No se pudo guardar la red de nodos', detalle: e.message });
    }
};

/*
  POST /pdi/dashboard/red-nodos/reiniciar
  Descarta los cambios locales y vuelve a leer la matriz Excel base.
*/
ctrl.reiniciarRedNodos = async (req, res) => {
    try {
        const network = await pdiNodeNetwork.resetNetwork();
        res.json(network);
    } catch (e) {
        res.status(500).json({ error: 'No se pudo reiniciar la red de nodos', detalle: e.message });
    }
};

module.exports = ctrl;
