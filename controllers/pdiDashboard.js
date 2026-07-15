const Macroproyecto   = require('../models/pdiMacroproyecto');
const Proyecto        = require('../models/pdiProyecto');
const AccionEstrategica = require('../models/pdiAccionEstrategica');
const Indicador       = require('../models/pdiIndicador');
const RespuestaFormulario = require('../models/pdiFormularioRespuesta');
const Corte           = require('../models/pdiCorte');
const { getSemaforo } = require('../helpers/pdiSemaforo');
const pdiNodeNetwork  = require('../services/pdiNodeNetwork');
const { buildAvanceWorkbook, buildIndicadoresMetasWorkbook, buildAvanceWorkbookAnio } = require('../services/pdiAvanceExcelExport');
const { weightedAverage, toNumberValue } = require('../services/pdiAvanceCalculator');
const {
    autoApproveAllPendingLeaderSubmittedResponses,
} = require('../services/pdiFormulario');

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

function ordenarPeriodos(lista = []) {
    return [...lista].sort((a, b) => String(a.periodo ?? '').localeCompare(String(b.periodo ?? '')));
}

// Un periodo recien agregado guarda avance:0 por defecto aunque nadie lo haya
// reportado (estado_reporte queda en 'Borrador'). Si solo filtraramos por
// "avance no nulo" ese 0 de relleno se confundiria con un reporte real.
function fueReportado(p) {
    return Boolean(p.estado_reporte) && p.estado_reporte !== 'Borrador';
}

// Cumplimiento del indicador EN un año puntual, frente a la meta programada
// para ese mismo año (no la Meta final 2029): es una tasa de ejecución anual,
// análoga a "ejecutado / presupuestado" del avance financiero por año.
function cumplimientoIndicadorAnio(indicador, anio) {
    const periodosAnio = ordenarPeriodos(indicador.periodos || [])
        .filter((p) => String(p.periodo ?? '').slice(0, 4) === anio);
    if (!periodosAnio.length) return 0;

    const tipo = indicador.tipo_calculo || 'promedio';

    if (tipo === 'ultimo_valor') {
        const conAvance = periodosAnio.filter((p) => fueReportado(p) && toNumberValue(p.avance) !== null);
        if (!conAvance.length) return 0;
        const ultimo = conAvance[conAvance.length - 1];
        const avance = toNumberValue(ultimo.avance);
        const meta = toNumberValue(ultimo.meta);
        if (avance === null) return 0;
        if (meta !== null && meta > 0) return Math.round(Math.min(avance / meta, 1) * 100 * 100) / 100;
        return Math.round(Math.min(avance, 100) * 100) / 100;
    }

    if (tipo === 'promedio') {
        const avances = periodosAnio.map((p) => toNumberValue(p.avance)).filter((v) => v !== null);
        const metas = periodosAnio.map((p) => toNumberValue(p.meta)).filter((v) => v !== null);
        if (!avances.length || !metas.length) return 0;
        const avanceProm = avances.reduce((a, b) => a + b, 0) / avances.length;
        const metaProm = metas.reduce((a, b) => a + b, 0) / metas.length;
        if (!(metaProm > 0)) return 0;
        return Math.round(Math.min(avanceProm / metaProm, 1) * 100 * 100) / 100;
    }

    // acumulado
    const sumaAvance = periodosAnio.reduce((s, p) => s + (toNumberValue(p.avance) ?? 0), 0);
    const sumaMeta = periodosAnio.reduce((s, p) => s + (toNumberValue(p.meta) ?? 0), 0);
    if (!(sumaMeta > 0)) return 0;
    return Math.round(Math.min(sumaAvance / sumaMeta, 1) * 100 * 100) / 100;
}

// Indicadores que tienen meta definida en un año puntual: es el universo que
// "aplica" a ese año (los que no tienen meta ese año simplemente no se evalúan).
function indicadoresConMetaEnAnio(anio, indicadores) {
    return indicadores.filter((ind) =>
        (ind.periodos || []).some((p) =>
            String(p.periodo ?? '').slice(0, 4) === anio && toNumberValue(p.meta) !== null
        )
    );
}

// Avance real del año en curso: se toman TODOS los indicadores que tienen
// meta definida en ese año (el mismo universo que "Indicadores del período"),
// se calcula el % de cumplimiento individual de cada uno frente a la meta de
// ESE año, y se promedian (suma de los % ÷ total de indicadores). No es una
// ponderación por peso ni una cadena jerárquica: es el promedio simple del
// avance real de ese año, tal como se ve en la tabla del tablero.
function calcularAvanceGlobalAnio(anio, { indicadores }) {
    const indicadoresDelAnio = indicadoresConMetaEnAnio(anio, indicadores);
    if (!indicadoresDelAnio.length) return 0;

    const suma = indicadoresDelAnio.reduce((acc, ind) => acc + cumplimientoIndicadorAnio(ind, anio), 0);
    return Math.round((suma / indicadoresDelAnio.length) * 100) / 100;
}

// Estructura del año: cuántos macroproyectos/proyectos/acciones/indicadores
// tienen al menos un indicador con meta en ese año (subconjunto de la
// estructura total del PDI, contando solo lo que "aplica" a ese año puntual).
function calcularEstructuraAnio(anio, { proyectos, acciones, indicadores }) {
    const indicadoresDelAnio = indicadoresConMetaEnAnio(anio, indicadores);

    const accionIds = new Set(
        indicadoresDelAnio
            .map((ind) => String(ind.accion_id && typeof ind.accion_id === 'object' ? ind.accion_id._id : ind.accion_id))
            .filter(Boolean)
    );
    const accionesDelAnio = acciones.filter((accion) => accionIds.has(String(accion._id)));

    const proyectoIds = new Set(accionesDelAnio.map((accion) => String(accion.proyecto_id)).filter(Boolean));
    const proyectosDelAnio = proyectos.filter((proyecto) => proyectoIds.has(String(proyecto._id)));

    const macroIds = new Set(proyectosDelAnio.map((proyecto) => String(proyecto.macroproyecto_id)).filter(Boolean));

    return {
        macroproyectos: macroIds.size,
        proyectos: proyectosDelAnio.length,
        acciones: accionesDelAnio.length,
        indicadores: indicadoresDelAnio.length,
    };
}

const normalizePeriodoKey = (value) => String(value ?? '').trim().toUpperCase();

const getEstadoReporteFromRespuesta = (respuesta = {}) => {
    if (respuesta.aval_planeacion === 'Validado') return 'Validado';
    if (respuesta.estado_aval === 'Aprobado') return 'Aprobado';
    if (respuesta.estado_aval === 'Rechazado') return 'Rechazado';
    if (respuesta.estado === 'Enviado') return 'Enviado';
    return null;
};

const ESTADO_REPORTE_PRIORITY = {
    Enviado: 1,
    Rechazado: 1,
    Aprobado: 2,
    Validado: 3,
};

async function applyPlaneacionStateToIndicadores(indicadores = []) {
    if (!indicadores.length) return indicadores;

    const ids = indicadores.map((indicador) => String(indicador?._id || '')).filter(Boolean);
    if (!ids.length) return indicadores;

    const respuestas = await RespuestaFormulario.find({
        indicador_id: { $in: ids },
        estado: 'Enviado',
    }).select('indicador_id corte estado estado_aval aval_planeacion fecha_envio respondido_por').lean();

    if (!respuestas.length) return indicadores;

    const estadosPorIndicadorCorte = new Map();
    respuestas.forEach((respuesta) => {
        const indicadorId = String(respuesta.indicador_id || '');
        const corte = normalizePeriodoKey(respuesta.corte);
        const estadoReporte = getEstadoReporteFromRespuesta(respuesta);
        if (!indicadorId || !corte || !estadoReporte) return;

        const key = `${indicadorId}::${corte}`;
        const current = estadosPorIndicadorCorte.get(key);
        if (
            current &&
            (ESTADO_REPORTE_PRIORITY[current.estado_reporte] || 0) >= (ESTADO_REPORTE_PRIORITY[estadoReporte] || 0)
        ) {
            return;
        }

        estadosPorIndicadorCorte.set(key, {
            estado_reporte: estadoReporte,
            fecha_envio: respuesta.fecha_envio,
            reportado_por: respuesta.respondido_por,
        });
    });

    for (const indicador of indicadores) {
        if (!Array.isArray(indicador.periodos)) continue;

        let changed = false;
        indicador.periodos.forEach((periodo) => {
            const estado = estadosPorIndicadorCorte.get(`${String(indicador?._id || '')}::${normalizePeriodoKey(periodo.periodo)}`);
            if (!estado) return;

            if (periodo.estado_reporte !== estado.estado_reporte) {
                periodo.estado_reporte = estado.estado_reporte;
                changed = true;
            }
            if (estado.fecha_envio && !periodo.fecha_envio) {
                periodo.fecha_envio = estado.fecha_envio;
                changed = true;
            }
            if (estado.reportado_por && !periodo.reportado_por) {
                periodo.reportado_por = estado.reportado_por;
                changed = true;
            }
        });

        if (changed && typeof indicador.save === 'function') {
            indicador.markModified('periodos');
            await indicador.save();
        }
    }

    return indicadores;
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
        await autoApproveAllPendingLeaderSubmittedResponses();
        await applyPlaneacionStateToIndicadores(indicadores);

        // Avance ponderado global (promedio ponderado de macroproyectos). Es
        // el otro valor "final" que se muestra (junto con Macroproyecto), así
        // que se redondea aquí explícitamente.
        const avanceGlobal = Math.round(weightedAverage(
            macros,
            (macro) => macro.avance,
            (macro) => macro.peso
        ));

        // Avance real del año en curso: promedio simple del % de cumplimiento
        // individual de los indicadores con meta en ese año (ver calcularAvanceGlobalAnio).
        const anioActual = String(new Date().getFullYear());
        const avanceAnioActual = calcularAvanceGlobalAnio(anioActual, { macros, proyectos, acciones, indicadores });
        const estructuraAnioActual = calcularEstructuraAnio(anioActual, { proyectos, acciones, indicadores });

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
            anio_actual: anioActual,
            avance_anio_actual: avanceAnioActual,
            semaforo_anio_actual: getSemaforo(avanceAnioActual),
            estructura_anio_actual: estructuraAnioActual,
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
        await autoApproveAllPendingLeaderSubmittedResponses();
        await applyPlaneacionStateToIndicadores(indicadores);

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
        await autoApproveAllPendingLeaderSubmittedResponses();
        await applyPlaneacionStateToIndicadores(indicadores);

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
                    meta:   p.meta,
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
  GET /pdi/dashboard/exportar-avance
  Genera un Excel con la memoria de cálculo del avance de todo el PDI:
  Periodos -> Indicadores -> Acciones -> Proyectos -> Macroproyectos -> PDI general,
  con fórmulas reales de Excel (no valores fijos) para poder auditar el cálculo.
*/
ctrl.exportarAvance = async (req, res) => {
    try {
        await autoApproveAllPendingLeaderSubmittedResponses();

        const [macros, proyectos, acciones, indicadores] = await Promise.all([
            Macroproyecto.find({}).sort({ codigo: 1 }).lean(),
            Proyecto.find({}).sort({ codigo: 1 }).lean(),
            AccionEstrategica.find({}).sort({ codigo: 1 }).lean(),
            Indicador.find({}).sort({ codigo: 1 }).lean(),
        ]);
        await applyPlaneacionStateToIndicadores(indicadores);

        const workbook = await buildAvanceWorkbook({ macros, proyectos, acciones, indicadores });

        const nombreArchivo = `Memoria tecnica del calculo del avance del PDI ${new Date().toISOString().slice(0, 10)}.xlsx`;
        const nombreArchivoUtf8 = `Memoria técnica del cálculo del avance del PDI ${new Date().toISOString().slice(0, 10)}.xlsx`;
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${nombreArchivo}"; filename*=UTF-8''${encodeURIComponent(nombreArchivoUtf8)}`
        );

        await workbook.xlsx.write(res);
        res.end();
    } catch (e) {
        res.status(500).json({ error: 'No se pudo generar el Excel de avance', detalle: e.message });
    }
};

/*
  GET /pdi/dashboard/exportar-avance-anio
  Igual que exportar-avance, pero enfocado en un solo año (por defecto el año
  en curso, o el que llegue en ?anio=): cada nivel calcula su avance solo con
  las metas/avances de los periodos de ese año, no con la Meta final 2029.
*/
ctrl.exportarAvanceAnio = async (req, res) => {
    try {
        await autoApproveAllPendingLeaderSubmittedResponses();

        const anio = String(req.query.anio || new Date().getFullYear());

        const [macros, proyectos, acciones, indicadores] = await Promise.all([
            Macroproyecto.find({}).sort({ codigo: 1 }).lean(),
            Proyecto.find({}).sort({ codigo: 1 }).lean(),
            AccionEstrategica.find({}).sort({ codigo: 1 }).lean(),
            Indicador.find({}).sort({ codigo: 1 }).lean(),
        ]);
        await applyPlaneacionStateToIndicadores(indicadores);

        const workbook = await buildAvanceWorkbookAnio({ macros, proyectos, acciones, indicadores, anio });

        const nombreArchivo = `Memoria tecnica del calculo del avance del PDI ${anio} ${new Date().toISOString().slice(0, 10)}.xlsx`;
        const nombreArchivoUtf8 = `Memoria técnica del cálculo del avance del PDI ${anio} ${new Date().toISOString().slice(0, 10)}.xlsx`;
        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="${nombreArchivo}"; filename*=UTF-8''${encodeURIComponent(nombreArchivoUtf8)}`
        );

        await workbook.xlsx.write(res);
        res.end();
    } catch (e) {
        res.status(500).json({ error: 'No se pudo generar el Excel de avance del año', detalle: e.message });
    }
};

/*
  GET /pdi/dashboard/exportar-indicadores-metas
  Genera la tabla base de indicadores PDI con la estructura del archivo
  institucional y agrega todas las metas/avances por periodo.
*/
ctrl.exportarIndicadoresMetas = async (req, res) => {
    try {
        const [macros, proyectos, acciones, indicadores, cortes] = await Promise.all([
            Macroproyecto.find({}).lean(),
            Proyecto.find({}).lean(),
            AccionEstrategica.find({}).lean(),
            Indicador.find({}).lean(),
            Corte.find({}).lean(),
        ]);

        const workbook = await buildIndicadoresMetasWorkbook({ macros, proyectos, acciones, indicadores, cortes });

        res.setHeader(
            'Content-Type',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader(
            'Content-Disposition',
            `attachment; filename="pdi_indicadores_metas_${new Date().toISOString().slice(0, 10)}.xlsx"`
        );

        await workbook.xlsx.write(res);
        res.end();
    } catch (e) {
        res.status(500).json({ error: 'No se pudo generar el Excel de indicadores y metas', detalle: e.message });
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
