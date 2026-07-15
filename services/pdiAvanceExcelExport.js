const ExcelJS = require('exceljs');
const {
    toNumberValue,
    normalizePeso,
    clampPercentage,
    weightedContribution,
    weightedAverage,
} = require('./pdiAvanceCalculator');
const { getSemaforo } = require('../helpers/pdiSemaforo');

// ── Helpers numéricos (replican exactamente la lógica de controllers/pdiIndicador.js) ──

function ordenarPeriodos(lista = []) {
    return [...lista].sort((a, b) => String(a.periodo ?? '').localeCompare(String(b.periodo ?? '')));
}

function round2(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function valoresNumericos(lista = [], campo) {
    return lista
        .map((item) => toNumberValue(item[campo]))
        .filter((value) => value !== null);
}

function sumarCampo(lista = [], campo) {
    return valoresNumericos(lista, campo).reduce((acc, value) => acc + value, 0);
}

function promedioCampo(lista = [], campo) {
    const valores = valoresNumericos(lista, campo);
    if (!valores.length) return null;
    return round2(valores.reduce((acc, value) => acc + value, 0) / valores.length);
}

// Un periodo recien agregado guarda avance:0 por defecto aunque nadie lo haya
// reportado (estado_reporte queda en 'Borrador'). Si solo filtraramos por
// "avance no nulo" ese 0 de relleno se confundiria con un reporte real.
function fueReportado(p) {
    return Boolean(p.estado_reporte) && p.estado_reporte !== 'Borrador';
}

// Valor crudo del ultimo periodo con avance REPORTADO (sin dividir contra
// ninguna meta). Es el numerador que se compara contra la Meta final 2029.
function ultimoValorReportado(lista = []) {
    const conAvance = ordenarPeriodos(lista).filter((p) => fueReportado(p) && toNumberValue(p.avance) !== null);
    if (!conAvance.length) return 0;
    return toNumberValue(conAvance[conAvance.length - 1].avance) ?? 0;
}

// Igual que calcularIndicadorExport, pero con "Meta {año}" en vez de "Meta
// final 2029": la meta y el avance operativo del indicador se calculan SOLO
// con los periodos de ESE año (según su tipo de cálculo), y el % de avance
// se compara contra esa meta anual. Replica exactamente la metodología de
// controllers/pdiDashboard.js (cumplimientoIndicadorAnio) pero exponiendo
// también la meta usada, para poder mostrarla como columna/fórmula en el
// libro de memoria de cálculo enfocado en un año.
function calcularIndicadorExportAnio(indicador, anio) {
    const periodosAnio = ordenarPeriodos(indicador.periodos || [])
        .filter((p) => String(p.periodo ?? '').slice(0, 4) === anio);
    const tipo = indicador.tipo_calculo || 'promedio';

    let metaAnio = 0;
    let avanceOperacion = 0;

    if (periodosAnio.length) {
        if (tipo === 'ultimo_valor') {
            const conAvance = periodosAnio.filter((p) => fueReportado(p) && toNumberValue(p.avance) !== null);
            if (conAvance.length) {
                const ultimo = conAvance[conAvance.length - 1];
                avanceOperacion = round2(toNumberValue(ultimo.avance) ?? 0);
                metaAnio = round2(toNumberValue(ultimo.meta) ?? 0);
            }
        } else if (tipo === 'promedio') {
            avanceOperacion = round2(promedioCampo(periodosAnio, 'avance') ?? 0);
            metaAnio = round2(promedioCampo(periodosAnio, 'meta') ?? 0);
        } else {
            avanceOperacion = round2(sumarCampo(periodosAnio, 'avance'));
            metaAnio = round2(sumarCampo(periodosAnio, 'meta'));
        }
    }

    // Sin redondear: alimenta la Acción del archivo de año (weightedContribution).
    const porcentajeAvance = metaAnio > 0 ? Math.min(avanceOperacion / metaAnio, 1) * 100 : 0;

    // "Tiene meta en el año" = al menos un periodo de ESE año con meta no
    // nula (igual definición que indicadoresConMetaEnAnio en
    // controllers/pdiDashboard.js): una meta en 0 SÍ cuenta como definida,
    // solo se excluyen los indicadores sin ningún dato de meta ese año.
    const tieneMetaAnio = periodosAnio.some((p) => toNumberValue(p.meta) !== null);

    return {
        tiene_meta_anio: tieneMetaAnio,
        meta_anio: metaAnio,
        avance_operacion_anio: avanceOperacion,
        porcentaje_avance_anio: porcentajeAvance,
        semaforo_anio: getSemaforo(porcentajeAvance),
    };
}

function calcularIndicadorExport(ind = {}) {
    const tipo = ind.tipo_calculo || 'promedio';
    const periodos = ordenarPeriodos(ind.periodos || []);
    const metaFinal = toNumberValue(ind.meta_final_2029);

    let avanceOperacion = 0;
    if (tipo === 'acumulado') {
        avanceOperacion = round2(sumarCampo(periodos, 'avance'));
    } else if (tipo === 'ultimo_valor') {
        avanceOperacion = ultimoValorReportado(periodos);
    } else {
        avanceOperacion = promedioCampo(periodos, 'avance') ?? 0;
    }

    // Sin redondear: igual que en controllers/pdiIndicador.js, este porcentaje
    // alimenta la Acción (weightedContribution) y no debe llevar redondeo
    // propio, para que no se acumule error subiendo por la cadena.
    const porcentajeAvance = metaFinal > 0 ? Math.min(avanceOperacion / metaFinal, 1) * 100 : 0;
    const avanceTotalReal = metaFinal > 0 ? clampPercentage((avanceOperacion / metaFinal) * 100) : null;

    return {
        avance_operacion: avanceOperacion,
        porcentaje_avance: porcentajeAvance,
        avance_total_real: avanceTotalReal,
        semaforo: getSemaforo(avanceTotalReal ?? porcentajeAvance),
    };
}

function groupBy(items = [], keyGetter) {
    const grouped = new Map();
    items.forEach((item) => {
        const key = String(keyGetter(item) || '');
        if (!key) return;
        grouped.set(key, [...(grouped.get(key) || []), item]);
    });
    return grouped;
}

function duplicateCodes(items = [], level) {
    const counts = new Map();
    items.forEach((item) => {
        const code = String(item.codigo || '').trim();
        if (!code) return;
        counts.set(code, (counts.get(code) || 0) + 1);
    });
    return [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([code, count]) => ({
            categoria: 'Códigos duplicados',
            nivel: level,
            codigo: code,
            estado: 'Error',
            detalle: `El código aparece ${count} veces.`,
            accion: 'Unificar o corregir códigos para que cada elemento tenga un identificador único.',
        }));
}

function validarPesos({ macros, proyectos, acciones, indicadores }) {
    const rows = [];
    const tolerancia = 0.01;

    const addWeightCheck = (nivel, parentCode, children, label) => {
        if (!children.length) {
            rows.push({
                categoria: 'Relaciones jerárquicas',
                nivel,
                codigo: parentCode,
                estado: 'Advertencia',
                detalle: `${label} no tiene elementos hijos asociados.`,
                accion: 'Verificar si la estructura está incompleta o si el elemento quedó sin uso.',
            });
            return;
        }
        const total = round2(children.reduce((acc, item) => acc + normalizePeso(item.peso), 0));
        const diff = round2(total - 100);
        rows.push({
            categoria: 'Pesos al 100%',
            nivel,
            codigo: parentCode,
            estado: Math.abs(diff) <= tolerancia ? 'OK' : 'Error',
            detalle: `${label}: pesos hijos suman ${total}%.`,
            accion: Math.abs(diff) <= tolerancia
                ? 'Sin acción requerida.'
                : 'Ajustar los pesos hijos para que sumen exactamente 100%.',
        });
    };

    const proyectosPorMacro = groupBy(proyectos, (p) => p.macroproyecto_id?._id ?? p.macroproyecto_id);
    const accionesPorProyecto = groupBy(acciones, (a) => a.proyecto_id?._id ?? a.proyecto_id);
    const indicadoresPorAccion = groupBy(indicadores, (i) => i.accion_id?._id ?? i.accion_id);

    const totalMacro = round2(macros.reduce((acc, macro) => acc + normalizePeso(macro.peso), 0));
    rows.push({
        categoria: 'Pesos al 100%',
        nivel: 'PDI',
        codigo: 'PDI',
        estado: Math.abs(totalMacro - 100) <= tolerancia ? 'OK' : 'Error',
        detalle: `Los macroproyectos suman ${totalMacro}%.`,
        accion: Math.abs(totalMacro - 100) <= tolerancia
            ? 'Sin acción requerida.'
            : 'Ajustar los pesos de macroproyectos para que sumen exactamente 100%.',
    });

    macros.forEach((macro) => addWeightCheck(
        'Macroproyecto → Proyectos',
        macro.codigo,
        proyectosPorMacro.get(String(macro._id)) || [],
        `Macroproyecto ${macro.codigo}`
    ));
    proyectos.forEach((proyecto) => addWeightCheck(
        'Proyecto → Acciones',
        proyecto.codigo,
        accionesPorProyecto.get(String(proyecto._id)) || [],
        `Proyecto ${proyecto.codigo}`
    ));
    acciones.forEach((accion) => addWeightCheck(
        'Acción → Indicadores',
        accion.codigo,
        indicadoresPorAccion.get(String(accion._id)) || [],
        `Acción ${accion.codigo}`
    ));

    return rows;
}

function validarRelaciones({ macros, proyectos, acciones, indicadores }) {
    const macroIds = new Set(macros.map((m) => String(m._id)));
    const proyectoIds = new Set(proyectos.map((p) => String(p._id)));
    const accionIds = new Set(acciones.map((a) => String(a._id)));
    const rows = [];

    proyectos.forEach((p) => {
        const parentId = String(p.macroproyecto_id?._id ?? p.macroproyecto_id ?? '');
        if (!parentId || !macroIds.has(parentId)) {
            rows.push({
                categoria: 'Relaciones jerárquicas',
                nivel: 'Proyecto',
                codigo: p.codigo,
                estado: 'Error',
                detalle: 'El proyecto no tiene un macroproyecto válido asociado.',
                accion: 'Asignar el proyecto a un macroproyecto existente.',
            });
        }
    });
    acciones.forEach((a) => {
        const parentId = String(a.proyecto_id?._id ?? a.proyecto_id ?? '');
        if (!parentId || !proyectoIds.has(parentId)) {
            rows.push({
                categoria: 'Relaciones jerárquicas',
                nivel: 'Acción estratégica',
                codigo: a.codigo,
                estado: 'Error',
                detalle: 'La acción no tiene un proyecto válido asociado.',
                accion: 'Asignar la acción a un proyecto existente.',
            });
        }
    });
    indicadores.forEach((i) => {
        const parentId = String(i.accion_id?._id ?? i.accion_id ?? '');
        if (!parentId || !accionIds.has(parentId)) {
            rows.push({
                categoria: 'Relaciones jerárquicas',
                nivel: 'Indicador',
                codigo: i.codigo,
                estado: 'Error',
                detalle: 'El indicador no tiene una acción estratégica válida asociada.',
                accion: 'Asignar el indicador a una acción estratégica existente.',
            });
        }
    });

    return rows;
}

function validarIndicadores(indicadores = []) {
    const tiposValidos = new Set(['acumulado', 'promedio', 'ultimo_valor']);
    const rows = [];

    indicadores.forEach((ind) => {
        const tipo = ind.tipo_calculo || 'promedio';
        if (!tiposValidos.has(tipo)) {
            rows.push({
                categoria: 'Tipo de cálculo',
                nivel: 'Indicador',
                codigo: ind.codigo,
                estado: 'Error',
                detalle: `Tipo de cálculo no reconocido: ${tipo}.`,
                accion: 'Usar Acumulado, Promedio o Último valor reportado.',
            });
        }

        if (!Array.isArray(ind.periodos) || ind.periodos.length === 0) {
            rows.push({
                categoria: 'Periodos',
                nivel: 'Indicador',
                codigo: ind.codigo,
                estado: 'Advertencia',
                detalle: 'El indicador no tiene periodos de seguimiento configurados.',
                accion: 'Configurar los cortes/periodos que alimentan el avance.',
            });
        }

        if (!(toNumberValue(ind.meta_final_2029) > 0)) {
            rows.push({
                categoria: 'Meta final',
                nivel: 'Indicador',
                codigo: ind.codigo,
                estado: 'Advertencia',
                detalle: 'No hay Meta final 2029 numérica mayor a 0 para calcular el porcentaje de avance.',
                accion: 'Registrar una meta final numérica para el indicador.',
            });
        }

        (ind.periodos || []).forEach((periodo) => {
            const rawAvance = periodo.avance;
            const rawMeta = periodo.meta;
            if (rawAvance !== null && rawAvance !== undefined && rawAvance !== '' && toNumberValue(rawAvance) === null) {
                rows.push({
                    categoria: 'Valores numéricos',
                    nivel: 'Periodo',
                    codigo: `${ind.codigo} / ${periodo.periodo}`,
                    estado: 'Error',
                    detalle: `Avance no numérico: ${rawAvance}.`,
                    accion: 'Registrar el avance como número.',
                });
            }
            if (rawMeta !== null && rawMeta !== undefined && rawMeta !== '' && toNumberValue(rawMeta) === null) {
                rows.push({
                    categoria: 'Valores numéricos',
                    nivel: 'Periodo',
                    codigo: `${ind.codigo} / ${periodo.periodo}`,
                    estado: 'Advertencia',
                    detalle: `Meta del periodo no numérica: ${rawMeta}.`,
                    accion: 'Registrar la meta del periodo como número si debe participar en validaciones.',
                });
            }
        });
    });

    return rows;
}

function validarDiferenciasCalculadas({ macros, proyectos, acciones, indicadores }) {
    const rows = [];
    const tolerancia = 0.5;
    const addDiff = (nivel, item, calculado, guardado) => {
        const diff = round2((Number(calculado) || 0) - (Number(guardado) || 0));
        if (Math.abs(diff) <= tolerancia) return;
        rows.push({
            categoria: 'Diferencias de cálculo',
            nivel,
            codigo: item.codigo,
            estado: 'Advertencia',
            detalle: `Calculado al descargar: ${round2(calculado)}%. Guardado en sistema: ${round2(guardado)}%. Diferencia: ${diff} puntos.`,
            accion: 'Recalcular o guardar nuevamente el elemento para sincronizar el valor almacenado.',
        });
    };

    indicadores.forEach((ind) => addDiff('Indicador', ind, ind.avance_descarga, ind.avance));
    acciones.forEach((accion) => addDiff('Acción estratégica', accion, accion.avance_descarga, accion.avance));
    proyectos.forEach((proyecto) => addDiff('Proyecto', proyecto, proyecto.avance_descarga, proyecto.avance));
    macros.forEach((macro) => addDiff('Macroproyecto', macro, macro.avance_descarga, macro.avance));

    return rows;
}

// Réplica de la selección de "último periodo con avance REPORTADO" usada por ultimoValorReportado
function marcarUltimoPeriodoConAvance(periodos = []) {
    const ordenados = ordenarPeriodos(periodos);
    let ultimoPeriodoKey = null;
    ordenados.forEach((p) => {
        if (fueReportado(p) && toNumberValue(p.avance) !== null) ultimoPeriodoKey = p.periodo;
    });
    return periodos.map((p) => ({
        ...p,
        _es_ultimo_con_avance: ultimoPeriodoKey !== null && p.periodo === ultimoPeriodoKey,
    }));
}

const TIPO_LABEL = {
    acumulado: 'Acumulado',
    promedio: 'Promedio',
    ultimo_valor: 'Último valor reportado',
};

const FORMULA_TEXTO = {
    acumulado: 'Se suman los valores reportados en todos los períodos del indicador. El porcentaje de avance se obtiene dividiendo dicho valor entre la Meta final 2029, aplicando un límite máximo del 100 %.',
    promedio: 'Se promedian los valores reportados en los períodos del indicador con información registrada. El porcentaje de avance se obtiene dividiendo dicho valor entre la Meta final 2029, aplicando un límite máximo del 100 %.',
    ultimo_valor: 'Se toma el valor reportado en el último período con información registrada. El porcentaje de avance se obtiene dividiendo dicho valor entre la Meta final 2029, aplicando un límite máximo del 100 %.',
};

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF7C3AED' } };
const HEADER_FONT = { bold: true, color: { argb: 'FFFFFFFF' } };
const SUBHEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDE9FE' } };

function styleHeaderRow(row) {
    row.eachCell((cell) => {
        cell.font = HEADER_FONT;
        cell.fill = HEADER_FILL;
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    row.height = 32;
}

function addExplanationBlock(ws, startRow, lines) {
    let row = startRow;
    for (const line of lines) {
        const cell = ws.getCell(`A${row}`);
        cell.value = line;
        if (line.endsWith(':') || row === startRow) cell.font = { bold: true };
        ws.mergeCells(`A${row}:H${row}`);
        cell.alignment = { wrapText: true, vertical: 'top' };
        row += 1;
    }
    return row;
}

async function buildAvanceWorkbook({ macros, proyectos, acciones, indicadores }) {
    const workbook = new ExcelJS.Workbook();
    const generatedAt = new Date();
    workbook.creator = 'MIRÓ - Tablero de control PDI';
    workbook.created = generatedAt;
    workbook.modified = generatedAt;
    workbook.calcProperties = workbook.calcProperties || {};
    workbook.calcProperties.fullCalcOnLoad = true;

    // ── Datos preprocesados ──────────────────────────────────────────────────
    const indicadoresConPeriodos = indicadores.map((ind) => ({
        ...ind,
        peso_norm: normalizePeso(ind.peso),
        periodos_marcados: marcarUltimoPeriodoConAvance(ind.periodos || []),
    }));

    const accionesNorm = acciones.map((a) => ({ ...a, peso_norm: normalizePeso(a.peso) }));
    const proyectosNorm = proyectos.map((p) => ({ ...p, peso_norm: normalizePeso(p.peso) }));
    const macrosNorm = macros.map((m) => ({ ...m, peso_norm: normalizePeso(m.peso) }));

    const accionPorId = new Map(accionesNorm.map((a) => [String(a._id), a]));
    const proyectoPorId = new Map(proyectosNorm.map((p) => [String(p._id), p]));
    const macroPorId = new Map(macrosNorm.map((m) => [String(m._id), m]));
    indicadoresConPeriodos.forEach((ind) => {
        const calculado = calcularIndicadorExport(ind);
        ind.avance_operacion_descarga = calculado.avance_operacion;
        ind.avance_descarga = calculado.porcentaje_avance;
        ind.avance_total_real_descarga = calculado.avance_total_real;
        ind.semaforo_descarga = calculado.semaforo;
    });

    const indicadoresPorAccion = groupBy(indicadoresConPeriodos, (i) => i.accion_id?._id ?? i.accion_id);
    accionesNorm.forEach((accion) => {
        accion.avance_descarga = weightedContribution(
            indicadoresPorAccion.get(String(accion._id)) || [],
            (indicador) => indicador.avance_descarga,
            (indicador) => indicador.peso
        );
    });

    const accionesPorProyecto = groupBy(accionesNorm, (a) => a.proyecto_id?._id ?? a.proyecto_id);
    proyectosNorm.forEach((proyecto) => {
        proyecto.avance_descarga = weightedContribution(
            accionesPorProyecto.get(String(proyecto._id)) || [],
            (accion) => accion.avance_descarga,
            (accion) => accion.peso
        );
    });

    const proyectosPorMacro = groupBy(proyectosNorm, (p) => p.macroproyecto_id?._id ?? p.macroproyecto_id);
    macrosNorm.forEach((macro) => {
        // Macroproyecto es un valor final que se muestra: sí se redondea, a
        // diferencia de Indicador/Acción/Proyecto.
        macro.avance_descarga = Math.round(weightedContribution(
            proyectosPorMacro.get(String(macro._id)) || [],
            (proyecto) => proyecto.avance_descarga,
            (proyecto) => proyecto.peso
        ));
    });

    // PDI global también es un valor final: se redondea aquí.
    const avanceGlobalDescarga = Math.round(weightedAverage(
        macrosNorm,
        (macro) => macro.avance_descarga,
        (macro) => macro.peso
    ));

    const validationRows = [
        ...duplicateCodes(macrosNorm, 'Macroproyecto'),
        ...duplicateCodes(proyectosNorm, 'Proyecto'),
        ...duplicateCodes(accionesNorm, 'Acción estratégica'),
        ...duplicateCodes(indicadoresConPeriodos, 'Indicador'),
        ...validarRelaciones({ macros: macrosNorm, proyectos: proyectosNorm, acciones: accionesNorm, indicadores: indicadoresConPeriodos }),
        ...validarPesos({ macros: macrosNorm, proyectos: proyectosNorm, acciones: accionesNorm, indicadores: indicadoresConPeriodos }),
        ...validarIndicadores(indicadoresConPeriodos),
        ...validarDiferenciasCalculadas({ macros: macrosNorm, proyectos: proyectosNorm, acciones: accionesNorm, indicadores: indicadoresConPeriodos }),
    ];

    // Se crean todas las hojas primero, en el orden en que deben quedar las
    // pestañas ("Resumen PDI" primero); se llenan más abajo en orden de
    // dependencia (Periodos -> Indicadores -> Acciones -> Proyectos -> Macros -> Resumen).
    const wsResumen = workbook.addWorksheet('Resumen PDI');
    const wsGuia = workbook.addWorksheet('Guía');
    const wsValidaciones = workbook.addWorksheet('Validaciones');
    const wsMacro = workbook.addWorksheet('Macroproyectos');
    const wsProy = workbook.addWorksheet('Proyectos');
    const wsAcc = workbook.addWorksheet('Acciones');
    const wsInd = workbook.addWorksheet('Indicadores');
    const wsPeriodos = workbook.addWorksheet('Periodos');
    wsPeriodos.columns = [
        { header: 'Código indicador', key: 'codigo', width: 20 },
        { header: 'Periodo', key: 'periodo', width: 12 },
        { header: 'Meta del periodo', key: 'meta', width: 16 },
        { header: 'Avance del periodo', key: 'avance', width: 18 },
        { header: '¿Es el último periodo con avance?', key: 'ultimo', width: 26 },
        { header: 'Estado del reporte', key: 'estado', width: 18 },
        { header: 'Reportado por', key: 'reportado_por', width: 28 },
        { header: 'Fecha de envío', key: 'fecha_envio', width: 18 },
    ];
    styleHeaderRow(wsPeriodos.getRow(1));
    wsPeriodos.autoFilter = { from: 'A1', to: 'H1' };

    // ── Hoja "Metas y Avances por Periodo" — versión consolidada y legible de
    // "Periodos" para consulta humana, con la jerarquía completa (Macroproyecto
    // → Proyecto → Acción → Indicador). "Periodos" se deja intacta porque las
    // fórmulas de la hoja Indicadores la referencian por columna (SUMIF/
    // AVERAGEIF/SUMIFS); esta hoja nueva no alimenta ninguna fórmula, es solo
    // de lectura.
    const wsConsolidado = workbook.addWorksheet('Metas y Avances por Periodo');
    wsConsolidado.columns = [
        { header: 'Macroproyecto', key: 'macro', width: 16 },
        { header: 'Proyecto', key: 'proyecto', width: 16 },
        { header: 'Acción', key: 'accion', width: 16 },
        { header: 'Indicador', key: 'indicador', width: 16 },
        { header: 'Nombre del indicador', key: 'nombre', width: 46 },
        { header: 'Periodo', key: 'periodo', width: 12 },
        { header: 'Meta del período', key: 'meta', width: 16 },
        { header: 'Valor reportado del período', key: 'avance', width: 22 },
        { header: 'Estado del reporte', key: 'estado', width: 18 },
        { header: 'Reportado por', key: 'reportado_por', width: 28 },
        { header: 'Fecha de envío', key: 'fecha_envio', width: 18 },
    ];
    styleHeaderRow(wsConsolidado.getRow(1));
    wsConsolidado.autoFilter = { from: 'A1', to: 'K1' };
    wsConsolidado.views = [{ state: 'frozen', ySplit: 1 }];

    for (const ind of indicadoresConPeriodos) {
        const accion = accionPorId.get(String(ind.accion_id?._id ?? ind.accion_id));
        const proyecto = proyectoPorId.get(String(accion?.proyecto_id?._id ?? accion?.proyecto_id ?? ''));
        const macro = macroPorId.get(String(proyecto?.macroproyecto_id?._id ?? proyecto?.macroproyecto_id ?? ''));
        for (const p of ind.periodos_marcados) {
            wsPeriodos.addRow({
                codigo: ind.codigo,
                periodo: p.periodo,
                meta: toNumberValue(p.meta),
                avance: toNumberValue(p.avance),
                ultimo: p._es_ultimo_con_avance,
                estado: p.estado_reporte || '',
                reportado_por: p.reportado_por || '',
                fecha_envio: p.fecha_envio || null,
            });
            wsConsolidado.addRow({
                macro: macro?.codigo ?? '',
                proyecto: proyecto?.codigo ?? '',
                accion: accion?.codigo ?? '',
                indicador: ind.codigo,
                nombre: ind.nombre,
                periodo: p.periodo,
                meta: toNumberValue(p.meta),
                avance: toNumberValue(p.avance),
                estado: p.estado_reporte || '',
                reportado_por: p.reportado_por || '',
                fecha_envio: p.fecha_envio || null,
            });
        }
    }
    wsConsolidado.getColumn('K').numFmt = 'yyyy-mm-dd';
    wsConsolidado.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        row.getCell(5).alignment = { wrapText: true, vertical: 'top' };
    });
    const lastPeriodosRow = Math.max(wsPeriodos.rowCount, 2);
    wsPeriodos.getColumn('H').numFmt = 'yyyy-mm-dd';
    const P = {
        codigo: `Periodos!$A$2:$A$${lastPeriodosRow}`,
        meta: `Periodos!$C$2:$C$${lastPeriodosRow}`,
        avance: `Periodos!$D$2:$D$${lastPeriodosRow}`,
        ultimo: `Periodos!$E$2:$E$${lastPeriodosRow}`,
    };

    // ── Hoja "Indicadores" ────────────────────────────────────────────────────
    wsInd.columns = [
        { header: 'Código', key: 'codigo', width: 16 },
        { header: 'Nombre del indicador', key: 'nombre', width: 46 },
        { header: 'Código Acción', key: 'accion', width: 16 },
        { header: 'Peso en su Acción (%)', key: 'peso', width: 16 },
        { header: 'Tipo de cálculo', key: 'tipo', width: 20 },
        { header: 'Meta final 2029', key: 'meta_final', width: 16 },
        { header: 'Valor utilizado para el cálculo', key: 'avance_actual', width: 20 },
        { header: 'Porcentaje de avance del indicador (%)', key: 'pct_avance', width: 20 },
        { header: 'Avance guardado\nen el sistema', key: 'sistema', width: 18 },
        { header: 'Diferencia', key: 'diferencia', width: 12 },
        { header: 'Semáforo', key: 'semaforo', width: 12 },
        { header: 'Fórmula aplicada', key: 'formula_texto', width: 60 },
    ];
    styleHeaderRow(wsInd.getRow(1));
    wsInd.autoFilter = { from: 'A1', to: 'L1' };
    wsInd.views = [{ state: 'frozen', ySplit: 1 }];

    indicadoresConPeriodos.forEach((ind, idx) => {
        const r = idx + 2;
        const accion = accionPorId.get(String(ind.accion_id?._id ?? ind.accion_id));
        const tipo = ind.tipo_calculo || 'promedio';

        wsInd.getCell(`A${r}`).value = ind.codigo;
        wsInd.getCell(`B${r}`).value = ind.nombre;
        wsInd.getCell(`C${r}`).value = accion?.codigo ?? '';
        wsInd.getCell(`D${r}`).value = ind.peso_norm;
        wsInd.getCell(`E${r}`).value = TIPO_LABEL[tipo] ?? tipo;
        wsInd.getCell(`F${r}`).value = toNumberValue(ind.meta_final_2029) ?? 0;

        // G: avance actual, calculado con fórmula según el tipo de cálculo (usa el TEXTO plano del tipo, no la etiqueta)
        const tipoRaw = tipo;
        const gFormula =
            tipoRaw === 'acumulado'
                ? `SUMIF(${P.codigo},$A${r},${P.avance})`
                : tipoRaw === 'ultimo_valor'
                ? `SUMIFS(${P.avance},${P.codigo},$A${r},${P.ultimo},TRUE)`
                : `IFERROR(ROUND(AVERAGEIF(${P.codigo},$A${r},${P.avance}),2),0)`;
        wsInd.getCell(`G${r}`).value = { formula: gFormula, result: ind.avance_operacion_descarga };

        // H: % avance final del indicador, siempre G ÷ Meta final 2029 (tope 100%).
        // Sin redondear: alimenta la Acción (columna E de "Acciones").
        const hFormula = `IF($F${r}>0,MIN(G${r}/$F${r},1)*100,0)`;
        wsInd.getCell(`H${r}`).value = { formula: hFormula, result: ind.avance_descarga };

        wsInd.getCell(`I${r}`).value = Number(ind.avance) || 0;
        wsInd.getCell(`J${r}`).value = {
            formula: `ROUND(H${r}-I${r},2)`,
            result: round2((Number(ind.avance_descarga) || 0) - (Number(ind.avance) || 0)),
        };
        wsInd.getCell(`K${r}`).value = {
            formula: `IF(H${r}>=90,"Verde",IF(H${r}>=60,"Amarillo","Rojo"))`,
            result: ({ verde: 'Verde', amarillo: 'Amarillo', rojo: 'Rojo' })[ind.semaforo_descarga] || '',
        };
        wsInd.getCell(`L${r}`).value = FORMULA_TEXTO[tipoRaw] ?? '';

        ['G', 'H', 'I', 'J'].forEach((col) => { wsInd.getCell(`${col}${r}`).numFmt = '0.00'; });
        wsInd.getCell(`L${r}`).alignment = { wrapText: true, vertical: 'top' };
        wsInd.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
    });
    const lastIndRow = Math.max(wsInd.rowCount, 2);
    const IND = {
        accion: `Indicadores!$C$2:$C$${lastIndRow}`,
        pct: `Indicadores!$H$2:$H$${lastIndRow}`,
        peso: `Indicadores!$D$2:$D$${lastIndRow}`,
    };

    // ── Hoja "Acciones" ───────────────────────────────────────────────────────
    wsAcc.columns = [
        { header: 'Código', key: 'codigo', width: 16 },
        { header: 'Nombre de la acción', key: 'nombre', width: 46 },
        { header: 'Código Proyecto', key: 'proyecto', width: 16 },
        { header: 'Peso en su Proyecto (%)', key: 'peso', width: 18 },
        { header: 'Avance\n(calculado con fórmula)', key: 'avance_calc', width: 18 },
        { header: 'Avance guardado\nen el sistema', key: 'sistema', width: 18 },
        { header: 'Diferencia', key: 'diferencia', width: 12 },
        { header: 'Fórmula aplicada', key: 'formula_texto', width: 70 },
    ];
    styleHeaderRow(wsAcc.getRow(1));
    wsAcc.autoFilter = { from: 'A1', to: 'H1' };
    wsAcc.views = [{ state: 'frozen', ySplit: 1 }];

    const ACCION_FORMULA_TXT = 'Consolidación del avance de la Acción Estratégica mediante la sumatoria ponderada del avance de los indicadores que la conforman, utilizando el peso asignado a cada uno.\nFórmula aplicada: Σ (Avance del Indicador × Peso del Indicador) ÷ 100.';
    accionesNorm.forEach((acc, idx) => {
        const r = idx + 2;
        const proyecto = proyectoPorId.get(String(acc.proyecto_id?._id ?? acc.proyecto_id));
        wsAcc.getCell(`A${r}`).value = acc.codigo;
        wsAcc.getCell(`B${r}`).value = acc.nombre;
        wsAcc.getCell(`C${r}`).value = proyecto?.codigo ?? '';
        wsAcc.getCell(`D${r}`).value = acc.peso_norm;
        // Sin redondear, igual que recalcularAccion en controllers/pdiIndicador.js:
        // alimenta el Proyecto y no debe llevar redondeo propio.
        wsAcc.getCell(`E${r}`).value = {
            formula: `SUMPRODUCT((${IND.accion}=$A${r})*${IND.pct}*${IND.peso})/100`,
            result: acc.avance_descarga,
        };
        wsAcc.getCell(`F${r}`).value = Number(acc.avance) || 0;
        wsAcc.getCell(`G${r}`).value = {
            formula: `ROUND(E${r}-F${r},2)`,
            result: round2((Number(acc.avance_descarga) || 0) - (Number(acc.avance) || 0)),
        };
        wsAcc.getCell(`H${r}`).value = ACCION_FORMULA_TXT;
        ['D', 'E', 'F', 'G'].forEach((col) => { wsAcc.getCell(`${col}${r}`).numFmt = '0.00'; });
        wsAcc.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
        wsAcc.getCell(`H${r}`).alignment = { wrapText: true, vertical: 'top' };
    });
    const lastAccRow = Math.max(wsAcc.rowCount, 2);
    const ACC = {
        proyecto: `Acciones!$C$2:$C$${lastAccRow}`,
        avance: `Acciones!$E$2:$E$${lastAccRow}`,
        peso: `Acciones!$D$2:$D$${lastAccRow}`,
    };

    // ── Hoja "Proyectos" ──────────────────────────────────────────────────────
    wsProy.columns = [
        { header: 'Código', key: 'codigo', width: 16 },
        { header: 'Nombre del proyecto', key: 'nombre', width: 46 },
        { header: 'Código Macroproyecto', key: 'macro', width: 18 },
        { header: 'Peso en su Macroproyecto (%)', key: 'peso', width: 20 },
        { header: 'Avance\n(calculado con fórmula)', key: 'avance_calc', width: 18 },
        { header: 'Avance guardado\nen el sistema', key: 'sistema', width: 18 },
        { header: 'Diferencia', key: 'diferencia', width: 12 },
        { header: 'Fórmula aplicada', key: 'formula_texto', width: 70 },
    ];
    styleHeaderRow(wsProy.getRow(1));
    wsProy.autoFilter = { from: 'A1', to: 'H1' };
    wsProy.views = [{ state: 'frozen', ySplit: 1 }];

    const PROYECTO_FORMULA_TXT = 'Consolidación del avance del proyecto mediante la sumatoria ponderada del avance de las acciones estratégicas que lo conforman, utilizando el peso asignado a cada una.\nFórmula aplicada: Σ (Avance de la acción estratégica × Peso de la acción estratégica) ÷ 100.';
    proyectosNorm.forEach((p, idx) => {
        const r = idx + 2;
        const macro = macroPorId.get(String(p.macroproyecto_id?._id ?? p.macroproyecto_id));
        wsProy.getCell(`A${r}`).value = p.codigo;
        wsProy.getCell(`B${r}`).value = p.nombre;
        wsProy.getCell(`C${r}`).value = macro?.codigo ?? '';
        wsProy.getCell(`D${r}`).value = p.peso_norm;
        // Sin redondear, igual que recalcularProyecto en controllers/pdiAccionEstrategica.js:
        // alimenta el Macroproyecto y no debe llevar redondeo propio.
        wsProy.getCell(`E${r}`).value = {
            formula: `SUMPRODUCT((${ACC.proyecto}=$A${r})*${ACC.avance}*${ACC.peso})/100`,
            result: p.avance_descarga,
        };
        wsProy.getCell(`F${r}`).value = Number(p.avance) || 0;
        wsProy.getCell(`G${r}`).value = {
            formula: `ROUND(E${r}-F${r},2)`,
            result: round2((Number(p.avance_descarga) || 0) - (Number(p.avance) || 0)),
        };
        wsProy.getCell(`H${r}`).value = PROYECTO_FORMULA_TXT;
        ['D', 'E', 'F', 'G'].forEach((col) => { wsProy.getCell(`${col}${r}`).numFmt = '0.00'; });
        wsProy.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
        wsProy.getCell(`H${r}`).alignment = { wrapText: true, vertical: 'top' };
    });
    const lastProyRow = Math.max(wsProy.rowCount, 2);
    const PROY = {
        macro: `Proyectos!$C$2:$C$${lastProyRow}`,
        avance: `Proyectos!$E$2:$E$${lastProyRow}`,
        peso: `Proyectos!$D$2:$D$${lastProyRow}`,
    };

    // ── Hoja "Macroproyectos" ─────────────────────────────────────────────────
    wsMacro.columns = [
        { header: 'Código', key: 'codigo', width: 16 },
        { header: 'Nombre del macroproyecto', key: 'nombre', width: 46 },
        { header: 'Peso (para el ponderado global)', key: 'peso', width: 20 },
        { header: 'Avance\n(calculado con fórmula)', key: 'avance_calc', width: 18 },
        { header: 'Avance guardado\nen el sistema', key: 'sistema', width: 18 },
        { header: 'Diferencia', key: 'diferencia', width: 12 },
        { header: 'Fórmula aplicada', key: 'formula_texto', width: 70 },
    ];
    styleHeaderRow(wsMacro.getRow(1));
    wsMacro.autoFilter = { from: 'A1', to: 'G1' };
    wsMacro.views = [{ state: 'frozen', ySplit: 1 }];

    const MACRO_FORMULA_TXT = 'El avance del macroproyecto se obtiene mediante la sumatoria ponderada del avance de los proyectos asociados, utilizando el peso definido para cada proyecto (Σ Avance × Peso ÷ 100).';
    macrosNorm.forEach((m, idx) => {
        const r = idx + 2;
        wsMacro.getCell(`A${r}`).value = m.codigo;
        wsMacro.getCell(`B${r}`).value = m.nombre;
        wsMacro.getCell(`C${r}`).value = m.peso_norm;
        // Macroproyecto SÍ se redondea a entero (valor final que se muestra),
        // igual que recalcularMacroproyecto en controllers/pdiProyecto.js.
        wsMacro.getCell(`D${r}`).value = {
            formula: `ROUND(SUMPRODUCT((${PROY.macro}=$A${r})*${PROY.avance}*${PROY.peso})/100,0)`,
            result: m.avance_descarga,
        };
        wsMacro.getCell(`E${r}`).value = Number(m.avance) || 0;
        wsMacro.getCell(`F${r}`).value = {
            formula: `ROUND(D${r}-E${r},2)`,
            result: round2((Number(m.avance_descarga) || 0) - (Number(m.avance) || 0)),
        };
        wsMacro.getCell(`G${r}`).value = MACRO_FORMULA_TXT;
        ['C', 'D', 'E', 'F'].forEach((col) => { wsMacro.getCell(`${col}${r}`).numFmt = '0.00'; });
        wsMacro.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
        wsMacro.getCell(`G${r}`).alignment = { wrapText: true, vertical: 'top' };
    });
    const lastMacroRow = Math.max(wsMacro.rowCount, 2);
    const MACRO = {
        peso: `Macroproyectos!$C$2:$C$${lastMacroRow}`,
        avance: `Macroproyectos!$D$2:$D$${lastMacroRow}`,
    };

    // ── Hoja "Resumen" (primera pestaña, resultado principal) ────────────────
    wsResumen.columns = [
        { width: 22 }, { width: 46 }, { width: 16 }, { width: 18 }, { width: 18 }, { width: 12 }, { width: 12 }, { width: 12 },
    ];

    wsResumen.mergeCells('A1:H1');
    wsResumen.getCell('A1').value = 'Tablero de control PDI 2026–2029 — Memoria de cálculo del avance';
    wsResumen.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF4C1D95' } };
    wsResumen.mergeCells('A2:H2');
    wsResumen.getCell('A2').value = `Generado el ${generatedAt.toLocaleString('es-CO', { timeZone: 'America/Bogota' })}. Datos consultados y recalculados al momento de la descarga.`;
    wsResumen.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' } };

    let nextRow = addExplanationBlock(wsResumen, 4, [
        'Cómo leer este archivo:',
        '• Este archivo presenta y documenta el cálculo del avance del PDI utilizando las mismas reglas de negocio implementadas en el sistema, con base en la información disponible al momento de la descarga.',
        '• La cadena de cálculo va de abajo hacia arriba: Periodos → Indicadores → Acciones Estratégicas → Proyectos → Macroproyectos → PDI general.',
        '• Cada hoja tiene una columna "calculado con fórmula" (recalculada aquí con datos frescos) y otra "guardado en el sistema" (el valor almacenado al descargar). La columna "Diferencia" permite validar que los valores calculados coincidan con los valores almacenados en el sistema. Si existen diferencias, estas deben revisarse antes de utilizar la información para seguimiento o toma de decisiones.',
        '• Los indicadores usan 3 formas distintas de calcular su avance según su "Tipo de cálculo" (ver hoja Indicadores, columna "Fórmula aplicada" para el detalle de cada uno):',
        '   - Acumulado: suma los avances de todos los periodos y los compara contra la Meta final 2029.',
        '   - Promedio: aplica a indicadores cuya medición corresponda al promedio de los valores reportados durante el periodo. Su lógica de cálculo dependerá de la configuración implementada en el sistema, cuando este tipo de cálculo sea utilizado.',
        '   - Último valor: toma el periodo más reciente con avance reportado y lo compara contra la Meta final 2029.',
        '• La consolidación del avance en Acciones Estratégicas, Proyectos, Macroproyectos y el PDI general se realiza mediante una sumatoria ponderada del avance de los elementos del nivel inmediatamente inferior, utilizando el peso asignado a cada uno (Σ Avance × Peso).',
    ]);

    nextRow += 1;
    wsResumen.getCell(`A${nextRow}`).value = 'Avance ponderado global del PDI';
    wsResumen.getCell(`A${nextRow}`).font = { bold: true, size: 13 };
    nextRow += 1;

    const tablaMacrosHeaderRow = nextRow;
    wsResumen.getCell(`A${tablaMacrosHeaderRow}`).value = 'Código';
    wsResumen.getCell(`B${tablaMacrosHeaderRow}`).value = 'Macroproyecto';
    wsResumen.getCell(`C${tablaMacrosHeaderRow}`).value = 'Peso (%)';
    wsResumen.getCell(`D${tablaMacrosHeaderRow}`).value = 'Avance calculado (%)';
    wsResumen.getCell(`E${tablaMacrosHeaderRow}`).value = 'Avance en el sistema (%)';
    wsResumen.getRow(tablaMacrosHeaderRow).eachCell((cell, colNumber) => {
        if (colNumber > 5) return;
        cell.font = { bold: true };
        cell.fill = SUBHEADER_FILL;
    });
    nextRow += 1;
    const firstMacroDataRow = nextRow;
    macrosNorm.forEach((m, idx) => {
        const r = nextRow + idx;
        wsResumen.getCell(`A${r}`).value = m.codigo;
        wsResumen.getCell(`B${r}`).value = m.nombre;
        wsResumen.getCell(`C${r}`).value = { formula: `Macroproyectos!C${idx + 2}`, result: m.peso_norm };
        wsResumen.getCell(`D${r}`).value = { formula: `Macroproyectos!D${idx + 2}`, result: m.avance_descarga };
        wsResumen.getCell(`E${r}`).value = { formula: `Macroproyectos!E${idx + 2}`, result: Number(m.avance) || 0 };
        ['C', 'D', 'E'].forEach((col) => { wsResumen.getCell(`${col}${r}`).numFmt = '0.00'; });
    });
    nextRow += macrosNorm.length;
    const lastMacroDataRow = nextRow - 1;

    nextRow += 1;
    wsResumen.getCell(`A${nextRow}`).value = 'Avance ponderado global (calculado con fórmula)';
    wsResumen.getCell(`A${nextRow}`).font = { bold: true };
    wsResumen.mergeCells(`A${nextRow}:C${nextRow}`);
    // Redondeada a entero, igual que ctrl.resumen en controllers/pdiDashboard.js
    wsResumen.getCell(`D${nextRow}`).value = {
        formula: `IFERROR(ROUND(SUMPRODUCT(D${firstMacroDataRow}:D${lastMacroDataRow},C${firstMacroDataRow}:C${lastMacroDataRow})/SUM(C${firstMacroDataRow}:C${lastMacroDataRow}),0),0)`,
        result: avanceGlobalDescarga,
    };
    wsResumen.getCell(`D${nextRow}`).font = { bold: true, size: 13, color: { argb: 'FF15803D' } };
    wsResumen.getCell(`D${nextRow}`).numFmt = '0.00';
    nextRow += 1;
    wsResumen.getCell(`A${nextRow}`).value = 'Avance ponderado global (guardado en el sistema / mostrado en el tablero)';
    wsResumen.getCell(`A${nextRow}`).font = { bold: true };
    wsResumen.mergeCells(`A${nextRow}:C${nextRow}`);
    const totalPesoMacro = macrosNorm.reduce((acc, m) => acc + (Number(m.peso_norm) || 0), 0);
    const avanceGlobalSistema = totalPesoMacro > 0
        ? Math.round(macrosNorm.reduce((acc, m) => acc + (Number(m.avance) || 0) * (Number(m.peso_norm) || 0), 0) / totalPesoMacro)
        : 0;
    wsResumen.getCell(`D${nextRow}`).value = avanceGlobalSistema;
    wsResumen.getCell(`D${nextRow}`).font = { bold: true, size: 13 };
    wsResumen.getCell(`D${nextRow}`).numFmt = '0.00';
    nextRow += 1;

    nextRow += 1;
    wsResumen.getCell(`A${nextRow}`).value = 'Estructura del PDI';
    wsResumen.getCell(`A${nextRow}`).font = { bold: true, size: 13 };
    nextRow += 1;
    const estructura = [
        ['Macroproyectos', macros.length],
        ['Proyectos', proyectos.length],
        ['Acciones estratégicas', acciones.length],
        ['Indicadores', indicadores.length],
    ];
    estructura.forEach(([label, value]) => {
        wsResumen.getCell(`A${nextRow}`).value = label;
        wsResumen.getCell(`B${nextRow}`).value = value;
        nextRow += 1;
    });

    nextRow += 1;
    wsResumen.getCell(`A${nextRow}`).value = 'Hojas de este archivo:';
    wsResumen.getCell(`A${nextRow}`).font = { bold: true };
    nextRow += 1;
    [
        'Guía — propósito de cada hoja, diccionario de columnas, tipos de cálculo y reglas de validación.',
        'Validaciones — hallazgos calculados al momento de la descarga: pesos, códigos, relaciones, metas y datos numéricos.',
        'Macroproyectos — avance de cada macroproyecto y su fórmula.',
        'Proyectos — avance de cada proyecto y su fórmula.',
        'Acciones — avance de cada acción estratégica y su fórmula.',
        'Indicadores — avance de cada indicador, su tipo de cálculo y su fórmula detallada.',
        'Periodos — meta y avance reportados en cada corte, que alimentan todas las fórmulas anteriores (no editar: es la base técnica de los cálculos).',
        'Metas y Avances por Periodo — la misma información de "Periodos", pero en formato consolidado y legible, con la jerarquía completa (Macroproyecto, Proyecto, Acción, Indicador). Es solo de consulta, no alimenta fórmulas.',
    ].forEach((line) => {
        wsResumen.getCell(`A${nextRow}`).value = `• ${line}`;
        wsResumen.mergeCells(`A${nextRow}:H${nextRow}`);
        nextRow += 1;
    });

    // ── Hoja "Guía" ──────────────────────────────────────────────────────────
    wsGuia.columns = [
        { width: 24 }, { width: 42 }, { width: 44 }, { width: 44 }, { width: 34 }, { width: 52 },
    ];
    wsGuia.mergeCells('A1:F1');
    wsGuia.getCell('A1').value = 'Guía de lectura de la memoria de cálculo PDI';
    wsGuia.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF4C1D95' } };
    wsGuia.mergeCells('A2:F2');
    wsGuia.getCell('A2').value = 'Este archivo documenta qué recibe cada hoja, qué genera y cómo se calcula el avance desde Indicador hasta PDI.';
    wsGuia.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' } };

    const writeGuideTable = (title, headers, rows, startRow) => {
        let row = startRow;
        wsGuia.getCell(`A${row}`).value = title;
        wsGuia.getCell(`A${row}`).font = { bold: true, size: 13 };
        wsGuia.mergeCells(`A${row}:F${row}`);
        row += 1;

        headers.forEach((header, index) => {
            const cell = wsGuia.getCell(row, index + 1);
            cell.value = header;
            cell.font = HEADER_FONT;
            cell.fill = HEADER_FILL;
            cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
        });
        row += 1;

        rows.forEach((values) => {
            values.forEach((value, index) => {
                const cell = wsGuia.getCell(row, index + 1);
                cell.value = value;
                cell.alignment = { wrapText: true, vertical: 'top' };
            });
            row += 1;
        });

        return row + 2;
    };

    let guiaRow = 4;
    guiaRow = writeGuideTable(
        'Propósito, entradas y salidas por hoja',
        ['Hoja', 'Propósito', 'Información que recibe', 'Información que genera'],
        [
            ['Resumen PDI', 'Presenta el resultado global y la estructura del PDI.', 'Avances calculados de macroproyectos y pesos globales.', 'Avance ponderado global calculado y comparación con el avance guardado.'],
            ['Guía', 'Explica cómo leer el archivo.', 'Reglas de negocio y estructura del libro.', 'Diccionario de columnas, tipos de cálculo y reglas de validación.'],
            ['Validaciones', 'Muestra controles de calidad del modelo.', 'Códigos, pesos, relaciones jerárquicas, metas y valores reportados.', 'Estados OK, Advertencia o Error con acción sugerida.'],
            ['Macroproyectos', 'Calcula avance por macroproyecto.', 'Proyectos asociados al macroproyecto y sus pesos.', 'Avance calculado, avance guardado y diferencia.'],
            ['Proyectos', 'Calcula avance por proyecto.', 'Acciones estratégicas asociadas al proyecto y sus pesos.', 'Avance calculado, avance guardado y diferencia.'],
            ['Acciones', 'Calcula avance por acción estratégica.', 'Indicadores asociados a la acción y sus pesos.', 'Avance calculado, avance guardado y diferencia.'],
            ['Indicadores', 'Calcula avance por indicador.', 'Periodos, tipo de cálculo, meta final y peso en la acción.', 'Avance operativo, porcentaje final, semáforo y fórmula aplicada.'],
            ['Periodos', 'Conserva la base granular del cálculo.', 'Metas y avances reportados por corte.', 'Marca el último periodo con avance y alimenta las fórmulas de indicadores. No editar: es la base técnica del cálculo.'],
            ['Metas y Avances por Periodo', 'Presenta lo mismo que "Periodos", en formato legible para consulta.', 'Metas y avances reportados por corte, con la jerarquía completa.', 'Tabla consolidada con Macroproyecto, Proyecto, Acción, Indicador, meta y valor reportado de cada periodo. Solo de consulta, no alimenta fórmulas.'],
        ],
        guiaRow
    );

    guiaRow = writeGuideTable(
        'Cálculo del avance por nivel',
        ['Nivel', 'Cálculo', 'Resultado'],
        [
            ['Indicador', 'Según tipo de cálculo: Acumulado, Promedio o Último valor reportado. Luego se compara con la Meta final 2029 cuando aplica.', '% de avance del indicador, capado a 100%.'],
            ['Acción Estratégica', 'Σ(% avance del indicador × peso del indicador) ÷ 100.', 'Avance ponderado de la acción.'],
            ['Proyecto', 'Σ(avance de la acción × peso de la acción) ÷ 100.', 'Avance ponderado del proyecto.'],
            ['Macroproyecto', 'Σ(avance del proyecto × peso del proyecto) ÷ 100.', 'Avance ponderado del macroproyecto.'],
            ['PDI', 'Sumatoria ponderada del avance de los macroproyectos: Σ (Avance del Macroproyecto × Peso del Macroproyecto) ÷ 100.', 'Avance global mostrado en el tablero.'],
        ],
        guiaRow
    );

    guiaRow = writeGuideTable(
        'Tipos de cálculo disponibles',
        ['Tipo', 'Cuándo usarlo', 'Fórmula del indicador'],
        [
            ['Acumulado', 'Indicadores que suman cantidades a lo largo del tiempo.', 'SUMA(avances reportados) ÷ Meta final 2029 × 100.'],
            ['Promedio', 'Aplica a indicadores cuya medición corresponda al promedio de los valores reportados durante el periodo.', 'Su lógica de cálculo dependerá de la configuración implementada en el sistema, cuando este tipo de cálculo sea utilizado.'],
            ['Último valor reportado', 'Indicadores donde solo importa el corte más reciente con avance.', 'Último avance reportado ÷ Meta final 2029 × 100.'],
        ],
        guiaRow
    );

    guiaRow = writeGuideTable(
        'Qué representa cada columna',
        ['Hoja', 'Columna', 'Representa'],
        [
            ['Resumen PDI', 'Código / Macroproyecto', 'Identificación y nombre del macroproyecto.'],
            ['Resumen PDI', 'Peso (%)', 'Peso del macroproyecto en el avance global.'],
            ['Resumen PDI', 'Avance calculado (%)', 'Avance recalculado en la descarga con fórmulas del archivo.'],
            ['Resumen PDI', 'Avance en el sistema (%)', 'Valor almacenado en base de datos al momento de descargar.'],
            ['Macroproyectos', 'Código / Nombre / Peso', 'Identificación, descripción y peso del macroproyecto.'],
            ['Macroproyectos', 'Avance calculado / Avance guardado / Diferencia', 'Permite validar que los valores calculados coincidan con los valores almacenados en el sistema. Si existen diferencias, estas deben revisarse antes de utilizar la información para seguimiento o toma de decisiones.'],
            ['Proyectos', 'Código Macroproyecto', 'Macroproyecto padre del proyecto.'],
            ['Proyectos', 'Peso en su Macroproyecto (%)', 'Peso del proyecto dentro del macroproyecto.'],
            ['Acciones', 'Código Proyecto', 'Proyecto padre de la acción estratégica.'],
            ['Acciones', 'Peso en su Proyecto (%)', 'Peso de la acción dentro del proyecto.'],
            ['Indicadores', 'Código Acción', 'Acción estratégica padre del indicador.'],
            ['Indicadores', 'Peso en su Acción (%)', 'Peso del indicador dentro de su acción estratégica.'],
            ['Indicadores', 'Tipo de cálculo', 'Regla usada para consolidar los periodos.'],
            ['Indicadores', 'Meta final 2029', 'Valor objetivo contra el que se compara el avance operativo cuando aplica.'],
            ['Indicadores', 'Valor utilizado para el cálculo', 'Valor operativo: suma, promedio o cumplimiento del último periodo según el tipo de cálculo.'],
            ['Indicadores', 'Porcentaje de avance del indicador (%)', 'Porcentaje final que sube a Acción Estratégica.'],
            ['Indicadores', 'Avance guardado / Diferencia', 'Permite validar que los valores calculados coincidan con los valores almacenados en el sistema. Si existen diferencias, estas deben revisarse antes de utilizar la información para seguimiento o toma de decisiones.'],
            ['Indicadores', 'Semáforo', 'Clasificación por avance: Verde >= 90, Amarillo >= 60, Rojo < 60.'],
            ['Indicadores', 'Fórmula aplicada', 'Explicación textual de la regla aplicada.'],
            ['Periodos', 'Código indicador / Periodo', 'Indicador y corte de seguimiento.'],
            ['Periodos', 'Meta del periodo', 'Meta específica del corte, usada especialmente para Último valor reportado y validaciones.'],
            ['Periodos', 'Avance del periodo', 'Valor reportado por el responsable en el corte.'],
            ['Periodos', '¿Es el último periodo con avance?', 'Marca el corte que alimenta el tipo Último valor reportado.'],
            ['Periodos', 'Estado / Reportado por / Fecha', 'Trazabilidad básica del reporte usado en la descarga.'],
            ['Validaciones', 'Categoría / Nivel / Código', 'Dónde se encontró la validación.'],
            ['Validaciones', 'Estado / Detalle / Acción sugerida', 'Resultado del control y recomendación de corrección.'],
        ],
        guiaRow
    );

    writeGuideTable(
        'Validaciones que realiza el archivo',
        ['Validación', 'Qué revisa', 'Resultado esperado'],
        [
            ['Pesos al 100%', 'Macroproyectos del PDI y elementos hijos en cada nivel.', 'Cada grupo debe sumar exactamente 100%.'],
            ['Códigos duplicados', 'Códigos repetidos en macroproyectos, proyectos, acciones e indicadores.', 'No debe haber códigos repetidos dentro del mismo nivel.'],
            ['Relaciones jerárquicas', 'Proyecto → Macroproyecto, Acción → Proyecto, Indicador → Acción.', 'Cada elemento debe tener un padre válido.'],
            ['Valores numéricos', 'Avances, metas de periodo y Meta final 2029.', 'Los campos que participan en cálculo deben ser numéricos.'],
            ['Tipos de cálculo', 'Tipo configurado en cada indicador.', 'Debe ser Acumulado, Promedio o Último valor reportado.'],
            ['Diferencias de cálculo', 'Calculado con fórmula vs guardado en sistema.', 'Permite validar que los valores calculados coincidan con los valores almacenados en el sistema. Si existen diferencias, estas deben revisarse antes de utilizar la información para seguimiento o toma de decisiones.'],
        ],
        guiaRow
    );
    wsGuia.views = [{ state: 'frozen', ySplit: 1 }];

    // ── Hoja "Validaciones" ───────────────────────────────────────────────────
    wsValidaciones.columns = [
        { header: 'Categoría', key: 'categoria', width: 26 },
        { header: 'Nivel', key: 'nivel', width: 24 },
        { header: 'Código', key: 'codigo', width: 20 },
        { header: 'Estado', key: 'estado', width: 16 },
        { header: 'Detalle', key: 'detalle', width: 62 },
        { header: 'Acción sugerida', key: 'accion', width: 62 },
    ];
    styleHeaderRow(wsValidaciones.getRow(1));
    wsValidaciones.autoFilter = { from: 'A1', to: 'F1' };
    wsValidaciones.views = [{ state: 'frozen', ySplit: 1 }];

    validationRows.forEach((validation) => {
        const row = wsValidaciones.addRow(validation);
        const statusCell = row.getCell(4);
        if (validation.estado === 'OK') {
            statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
            statusCell.font = { bold: true, color: { argb: 'FF166534' } };
        } else if (validation.estado === 'Advertencia') {
            statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
            statusCell.font = { bold: true, color: { argb: 'FF92400E' } };
        } else {
            statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
            statusCell.font = { bold: true, color: { argb: 'FF991B1B' } };
        }
        row.eachCell((cell) => {
            cell.alignment = { wrapText: true, vertical: 'top' };
        });
    });

    workbook.views = [{ activeTab: 0 }];

    return workbook;
}

function getPeriodoMap(periodos = []) {
    return new Map((periodos || []).map((periodo) => [String(periodo.periodo || ''), periodo]));
}

function getUltimoPeriodoConAvance(periodos = []) {
    const conAvance = ordenarPeriodos(periodos).filter((periodo) => fueReportado(periodo) && toNumberValue(periodo.avance) !== null);
    return conAvance.length ? conAvance[conAvance.length - 1] : null;
}

function getOperacionIndicador(ind = {}) {
    const tipo = ind.tipo_calculo || 'promedio';
    const periodos = ordenarPeriodos(ind.periodos || []);
    const metaFinal = toNumberValue(ind.meta_final_2029);

    if (tipo === 'acumulado') {
        const valor = round2(sumarCampo(periodos, 'avance'));
        return {
            tipoLabel: TIPO_LABEL.acumulado,
            operacion: 'Suma acumulada de avances',
            valorUsado: valor,
            periodoUsado: '',
            metaReferencia: metaFinal,
            avancePct: metaFinal > 0 ? round2(Math.min(valor / metaFinal, 1) * 100) : 0,
        };
    }

    if (tipo === 'ultimo_valor') {
        const ultimo = getUltimoPeriodoConAvance(periodos);
        const avance = toNumberValue(ultimo?.avance) ?? 0;
        return {
            tipoLabel: TIPO_LABEL.ultimo_valor,
            operacion: 'Último valor reportado',
            valorUsado: avance,
            periodoUsado: ultimo?.periodo || '',
            metaReferencia: metaFinal,
            avancePct: metaFinal > 0 ? round2(Math.min(avance / metaFinal, 1) * 100) : 0,
        };
    }

    const valor = promedioCampo(periodos, 'avance') ?? 0;
    return {
        tipoLabel: TIPO_LABEL.promedio,
        operacion: 'Promedio de avances reportados',
        valorUsado: valor,
        periodoUsado: '',
        metaReferencia: metaFinal,
        avancePct: metaFinal > 0 ? round2(Math.min(valor / metaFinal, 1) * 100) : 0,
    };
}

function naturalCompare(a, b) {
    return String(a ?? '').localeCompare(String(b ?? ''), 'es', { numeric: true, sensitivity: 'base' });
}

async function buildIndicadoresMetasWorkbook({ macros, proyectos, acciones, indicadores, cortes = [] }) {
    const workbook = new ExcelJS.Workbook();
    const generatedAt = new Date();
    workbook.creator = 'MIRÓ - Tablero de control PDI';
    workbook.created = generatedAt;
    workbook.modified = generatedAt;

    const macrosById = new Map(macros.map((macro) => [String(macro._id), macro]));
    const proyectosById = new Map(proyectos.map((proyecto) => [String(proyecto._id), proyecto]));
    const accionesById = new Map(acciones.map((accion) => [String(accion._id), accion]));
    const cortesPorNombre = new Map(
        (cortes || []).map((corte) => [String(corte.nombre || '').trim().toUpperCase(), corte])
    );
    const hoy = new Date();
    const esPeriodoFuturo = (nombrePeriodo) => {
        const corte = cortesPorNombre.get(String(nombrePeriodo || '').trim().toUpperCase());
        if (!corte?.fecha_inicio) return false;
        const fechaInicio = new Date(corte.fecha_inicio);
        return !Number.isNaN(fechaInicio.getTime()) && fechaInicio > hoy;
    };
    const periodos = [...new Set(
        indicadores.flatMap((indicador) => (indicador.periodos || []).map((periodo) => String(periodo.periodo || '').trim()).filter(Boolean))
    )].sort((a, b) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' }));

    // Enriquecer cada indicador con su jerarquía resuelta y ordenar
    // Macroproyecto -> Proyecto -> Acción -> Indicador (orden natural, no alfabético,
    // para que M2 no quede antes que M10 ni A2 antes que A10).
    const filas = indicadores.map((indicador) => {
        const accion = accionesById.get(String(indicador.accion_id?._id ?? indicador.accion_id ?? ''));
        const proyecto = proyectosById.get(String(accion?.proyecto_id?._id ?? accion?.proyecto_id ?? ''));
        const macro = macrosById.get(String(proyecto?.macroproyecto_id?._id ?? proyecto?.macroproyecto_id ?? ''));
        return { indicador, accion, proyecto, macro };
    }).sort((a, b) =>
        naturalCompare(a.macro?.codigo, b.macro?.codigo) ||
        naturalCompare(a.proyecto?.codigo, b.proyecto?.codigo) ||
        naturalCompare(a.accion?.codigo, b.accion?.codigo) ||
        naturalCompare(a.indicador?.codigo, b.indicador?.codigo)
    );

    const ws = workbook.addWorksheet('Indicadores PDI');
    // Las primeras 4 columnas (solo códigos, en orden jerárquico) quedan
    // inmovilizadas; nombres y el resto de datos van después, sin congelar.
    const baseColumns = [
        { header: 'Macroproyecto', key: 'macro', width: 18 },
        { header: 'Código del proyecto', key: 'codigo_proyecto', width: 20 },
        { header: 'Código acción', key: 'codigo_accion', width: 18 },
        { header: 'Código indicador', key: 'codigo_indicador', width: 18 },
        { header: 'Proyecto', key: 'proyecto', width: 36 },
        { header: 'Acción estratégica', key: 'accion', width: 42 },
        { header: 'Indicador de resultado', key: 'indicador_resultado', width: 62 },
        { header: 'Meta al año 2029', key: 'meta_final_2029', width: 18 },
        { header: 'Tipo de cálculo', key: 'tipo_calculo', width: 22 },
        { header: 'Valor final usado', key: 'valor_usado', width: 18 },
        { header: 'Periodo usado', key: 'periodo_usado', width: 16 },
        { header: 'Avance calculado (%)', key: 'avance_pct', width: 18 },
    ];
    const periodoColumns = periodos.flatMap((periodo) => [
        { header: `Meta ${periodo}`, key: `meta_${periodo}`, width: 14 },
        { header: `Avance ${periodo}`, key: `avance_${periodo}`, width: 14 },
    ]);
    ws.columns = [...baseColumns, ...periodoColumns];
    styleHeaderRow(ws.getRow(1));
    ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 4 }];
    ws.autoFilter = {
        from: 'A1',
        to: ws.getCell(1, ws.columnCount).address,
    };

    filas.forEach(({ indicador, accion, proyecto, macro }) => {
        const operacion = getOperacionIndicador(indicador);
        const periodoMap = getPeriodoMap(indicador.periodos || []);
        const row = {
            macro: macro?.codigo || '',
            codigo_proyecto: proyecto?.codigo || '',
            codigo_accion: accion?.codigo || '',
            codigo_indicador: indicador.codigo || '',
            proyecto: proyecto?.nombre || '',
            accion: accion?.nombre || '',
            indicador_resultado: indicador.indicador_resultado || indicador.nombre || '',
            meta_final_2029: toNumberValue(indicador.meta_final_2029) ?? indicador.meta_final_2029 ?? 'Sin meta',
            tipo_calculo: operacion.tipoLabel,
            valor_usado: operacion.valorUsado,
            periodo_usado: operacion.periodoUsado,
            avance_pct: operacion.avancePct,
        };

        periodos.forEach((periodo) => {
            const periodoData = periodoMap.get(periodo);
            const metaNum = toNumberValue(periodoData?.meta);
            const tieneMeta = metaNum !== null;
            row[`meta_${periodo}`] = tieneMeta ? metaNum : 'Sin meta';

            if (!tieneMeta) {
                // Sin meta definida para este periodo: no hay nada contra qué medir avance.
                row[`avance_${periodo}`] = 'No aplica';
            } else if (esPeriodoFuturo(periodo)) {
                // Periodo con meta pero que aún no inicia: vacío, no 0.
                row[`avance_${periodo}`] = '';
            } else {
                // Periodo vigente o pasado con meta: solo mostrar el avance si
                // ya fue reportado de verdad (estado_reporte distinto de Borrador);
                // de lo contrario queda vacío en vez de un 0 engañoso.
                const yaReportado = periodoData?.estado_reporte && periodoData.estado_reporte !== 'Borrador';
                const avanceNum = toNumberValue(periodoData?.avance);
                row[`avance_${periodo}`] = (yaReportado && avanceNum !== null) ? avanceNum : '';
            }
        });

        ws.addRow(row);
    });

    ['meta_final_2029', 'valor_usado', 'avance_pct'].forEach((key) => {
        ws.getColumn(key).numFmt = '0.00';
    });
    periodos.forEach((periodo) => {
        ws.getColumn(`meta_${periodo}`).numFmt = '0.00';
        ws.getColumn(`avance_${periodo}`).numFmt = '0.00';
    });
    ws.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        row.eachCell((cell) => {
            cell.alignment = { wrapText: true, vertical: 'top' };
        });
    });

    const wsInfo = workbook.addWorksheet('Información');
    wsInfo.columns = [{ width: 28 }, { width: 90 }];
    wsInfo.addRow(['Archivo', 'Indicadores PDI - metas por periodo']);
    wsInfo.addRow(['Generado', generatedAt.toLocaleString('es-CO', { timeZone: 'America/Bogota' })]);
    wsInfo.addRow(['Estructura', 'Las primeras cuatro columnas (códigos de macroproyecto, proyecto, acción e indicador) quedan inmovilizadas para orientarse al desplazar la tabla. Las columnas siguientes agregan los nombres, la meta final, el tipo de cálculo y todas las metas/avances por periodo disponibles en el sistema. "Sin meta" indica que ese periodo no tiene meta definida; "No aplica" indica que no hay avance evaluable; las celdas vacías corresponden a periodos futuros que aún no inician.']);
    wsInfo.addRow(['Acumulado', 'Toma la suma de los avances reportados y la compara contra la Meta al año 2029.']);
    wsInfo.addRow(['Promedio', 'Toma el promedio aritmético de los avances reportados y lo compara contra la Meta al año 2029.']);
    wsInfo.addRow(['Último valor reportado', 'Toma el último periodo con avance reportado y lo compara contra la Meta al año 2029.']);
    wsInfo.getRow(1).font = { bold: true };
    wsInfo.eachRow((row) => {
        row.eachCell((cell) => {
            cell.alignment = { wrapText: true, vertical: 'top' };
        });
    });

    workbook.views = [{ activeTab: 0 }];
    return workbook;
}

// Igual que marcarUltimoPeriodoConAvance, pero solo considera los periodos de
// UN año: el "último periodo con avance" para el tipo Último valor reportado
// debe salir de dentro del año, no de todo el histórico del indicador.
function marcarUltimoPeriodoConAvanceAnio(periodos = [], anio) {
    const periodosAnio = (periodos || []).filter((p) => String(p.periodo ?? '').slice(0, 4) === anio);
    const ordenados = ordenarPeriodos(periodosAnio);
    let ultimoPeriodoKey = null;
    ordenados.forEach((p) => {
        if (fueReportado(p) && toNumberValue(p.avance) !== null) ultimoPeriodoKey = p.periodo;
    });
    return periodosAnio.map((p) => ({
        ...p,
        _es_ultimo_con_avance: ultimoPeriodoKey !== null && p.periodo === ultimoPeriodoKey,
    }));
}

const FORMULA_TEXTO_ANIO = (anio) => ({
    acumulado: `Se suman los valores reportados en los períodos de ${anio} del indicador. El porcentaje de avance se obtiene dividiendo dicho valor entre la Meta ${anio}, aplicando un límite máximo del 100 %.`,
    promedio: `Se promedian los valores reportados en los períodos de ${anio} del indicador con información registrada. El porcentaje de avance se obtiene dividiendo dicho valor entre la Meta ${anio}, aplicando un límite máximo del 100 %.`,
    ultimo_valor: `Se toma el valor reportado en el último período de ${anio} con información registrada. El porcentaje de avance se obtiene dividiendo dicho valor entre la meta de ese mismo período, aplicando un límite máximo del 100 %.`,
});

// Detecta, por cada Acción, si el peso de sus indicadores CON meta en el año
// no suma 100% (porque otros indicadores de esa acción no tienen meta ese
// año). Como el avance de la acción se calcula dividiendo entre 100 (no entre
// el peso realmente cubierto — igual que en el archivo general), cuando eso
// pasa el avance del año puede quedar subestimado; se deja como advertencia
// explícita en vez de un cálculo silencioso.
function validarCoberturaPesoAnio(accionesNorm, indicadoresPorAccionAnio, anio) {
    const rows = [];
    const tolerancia = 0.01;
    accionesNorm.forEach((accion) => {
        const inds = indicadoresPorAccionAnio.get(String(accion._id)) || [];
        if (!inds.length) return;
        const total = round2(inds.reduce((acc, i) => acc + normalizePeso(i.peso), 0));
        if (Math.abs(total - 100) <= tolerancia) return;
        rows.push({
            categoria: `Peso cubierto en ${anio}`,
            nivel: 'Acción → Indicadores',
            codigo: accion.codigo,
            estado: 'Advertencia',
            detalle: `Los indicadores con meta en ${anio} de esta acción suman ${total}% de peso (no 100%): el resto de sus indicadores no tiene meta definida en ${anio}.`,
            accion: `El avance ${anio} de esta acción (y de su proyecto/macroproyecto) puede estar subestimado, porque se divide entre 100 y no entre el ${total}% realmente cubierto ese año.`,
        });
    });
    return rows;
}

/**
 * Igual que buildAvanceWorkbook (mismas hojas, mismo estilo de fórmulas en
 * cascada Periodos → Indicadores → Acciones → Proyectos → Macroproyectos →
 * PDI), pero enfocado en UN solo año: cada nivel calcula su avance usando
 * solo las metas/avances de los periodos de ese año (no la Meta final 2029),
 * y solo se incluyen los indicadores que tienen meta definida en ese año.
 * No incluye columnas "guardado en el sistema" / "Diferencia": el sistema no
 * persiste un avance por año a nivel de Acción/Proyecto/Macroproyecto/PDI
 * (solo el avance por periodo de cada indicador), así que no hay con qué
 * compararlas.
 */
async function buildAvanceWorkbookAnio({ macros, proyectos, acciones, indicadores, anio }) {
    const anioStr = String(anio);
    const workbook = new ExcelJS.Workbook();
    const generatedAt = new Date();
    workbook.creator = 'MIRÓ - Tablero de control PDI';
    workbook.created = generatedAt;
    workbook.modified = generatedAt;
    workbook.calcProperties = workbook.calcProperties || {};
    workbook.calcProperties.fullCalcOnLoad = true;

    const accionesNorm = acciones.map((a) => ({ ...a, peso_norm: normalizePeso(a.peso) }));
    const proyectosNorm = proyectos.map((p) => ({ ...p, peso_norm: normalizePeso(p.peso) }));
    const macrosNorm = macros.map((m) => ({ ...m, peso_norm: normalizePeso(m.peso) }));
    const accionPorId = new Map(accionesNorm.map((a) => [String(a._id), a]));
    const proyectoPorId = new Map(proyectosNorm.map((p) => [String(p._id), p]));
    const macroPorId = new Map(macrosNorm.map((m) => [String(m._id), m]));

    // Solo los indicadores con meta definida en el año quedan en el libro:
    // los demás no "aplican" a ${anioStr} y distorsionarían el cálculo.
    const indicadoresAnio = indicadores
        .map((ind) => ({ ...ind, peso_norm: normalizePeso(ind.peso), periodos_marcados: marcarUltimoPeriodoConAvanceAnio(ind.periodos || [], anioStr) }))
        .map((ind) => ({ ind, calc: calcularIndicadorExportAnio(ind, anioStr) }))
        .filter(({ calc }) => calc.tiene_meta_anio)
        .map(({ ind, calc }) => Object.assign(ind, {
            meta_anio: calc.meta_anio,
            avance_operacion_anio: calc.avance_operacion_anio,
            avance_descarga: calc.porcentaje_avance_anio,
            semaforo_descarga: calc.semaforo_anio,
        }));

    const indicadoresPorAccion = groupBy(indicadoresAnio, (i) => i.accion_id?._id ?? i.accion_id);
    accionesNorm.forEach((accion) => {
        accion.avance_descarga = weightedContribution(
            indicadoresPorAccion.get(String(accion._id)) || [],
            (indicador) => indicador.avance_descarga,
            (indicador) => indicador.peso
        );
    });

    const accionesPorProyecto = groupBy(accionesNorm, (a) => a.proyecto_id?._id ?? a.proyecto_id);
    proyectosNorm.forEach((proyecto) => {
        proyecto.avance_descarga = weightedContribution(
            accionesPorProyecto.get(String(proyecto._id)) || [],
            (accion) => accion.avance_descarga,
            (accion) => accion.peso
        );
    });

    const proyectosPorMacro = groupBy(proyectosNorm, (p) => p.macroproyecto_id?._id ?? p.macroproyecto_id);
    macrosNorm.forEach((macro) => {
        // Macroproyecto es un valor final que se muestra: sí se redondea, a
        // diferencia de Indicador/Acción/Proyecto.
        macro.avance_descarga = Math.round(weightedContribution(
            proyectosPorMacro.get(String(macro._id)) || [],
            (proyecto) => proyecto.avance_descarga,
            (proyecto) => proyecto.peso
        ));
    });

    // PDI global también es un valor final: se redondea aquí.
    const avanceGlobalDescarga = Math.round(weightedAverage(
        macrosNorm,
        (macro) => macro.avance_descarga,
        (macro) => macro.peso
    ));

    const validationRows = [
        ...duplicateCodes(macrosNorm, 'Macroproyecto'),
        ...duplicateCodes(proyectosNorm, 'Proyecto'),
        ...duplicateCodes(accionesNorm, 'Acción estratégica'),
        ...duplicateCodes(indicadoresAnio, 'Indicador'),
        ...validarRelaciones({ macros: macrosNorm, proyectos: proyectosNorm, acciones: accionesNorm, indicadores: indicadoresAnio }),
        ...validarPesos({ macros: macrosNorm, proyectos: proyectosNorm, acciones: accionesNorm, indicadores: indicadoresAnio }),
        ...validarIndicadores(indicadoresAnio),
        ...validarCoberturaPesoAnio(accionesNorm, indicadoresPorAccion, anioStr),
    ];

    const wsResumen = workbook.addWorksheet(`Resumen PDI ${anioStr}`);
    const wsGuia = workbook.addWorksheet('Guía');
    const wsValidaciones = workbook.addWorksheet('Validaciones');
    const wsMacro = workbook.addWorksheet('Macroproyectos');
    const wsProy = workbook.addWorksheet('Proyectos');
    const wsAcc = workbook.addWorksheet('Acciones');
    const wsInd = workbook.addWorksheet('Indicadores');
    const wsPeriodos = workbook.addWorksheet('Periodos');

    // ── Hoja "Periodos" (solo periodos de ${anioStr}, de indicadores incluidos) ──
    wsPeriodos.columns = [
        { header: 'Código indicador', key: 'codigo', width: 20 },
        { header: 'Periodo', key: 'periodo', width: 12 },
        { header: 'Meta del periodo', key: 'meta', width: 16 },
        { header: 'Avance del periodo', key: 'avance', width: 18 },
        { header: '¿Es el último periodo con avance?', key: 'ultimo', width: 26 },
        { header: 'Estado del reporte', key: 'estado', width: 18 },
        { header: 'Reportado por', key: 'reportado_por', width: 28 },
        { header: 'Fecha de envío', key: 'fecha_envio', width: 18 },
    ];
    styleHeaderRow(wsPeriodos.getRow(1));
    wsPeriodos.autoFilter = { from: 'A1', to: 'H1' };

    // ── Hoja "Metas y Avances por Periodo" — versión consolidada y legible de
    // "Periodos" (que se deja intacta: alimenta las fórmulas por columna).
    const wsConsolidado = workbook.addWorksheet('Metas y Avances por Periodo');
    wsConsolidado.columns = [
        { header: 'Macroproyecto', key: 'macro', width: 16 },
        { header: 'Proyecto', key: 'proyecto', width: 16 },
        { header: 'Acción', key: 'accion', width: 16 },
        { header: 'Indicador', key: 'indicador', width: 16 },
        { header: 'Nombre del indicador', key: 'nombre', width: 46 },
        { header: 'Periodo', key: 'periodo', width: 12 },
        { header: 'Meta del período', key: 'meta', width: 16 },
        { header: 'Valor reportado del período', key: 'avance', width: 22 },
        { header: 'Estado del reporte', key: 'estado', width: 18 },
        { header: 'Reportado por', key: 'reportado_por', width: 28 },
        { header: 'Fecha de envío', key: 'fecha_envio', width: 18 },
    ];
    styleHeaderRow(wsConsolidado.getRow(1));
    wsConsolidado.autoFilter = { from: 'A1', to: 'K1' };
    wsConsolidado.views = [{ state: 'frozen', ySplit: 1 }];

    for (const ind of indicadoresAnio) {
        const accion = accionPorId.get(String(ind.accion_id?._id ?? ind.accion_id));
        const proyecto = proyectoPorId.get(String(accion?.proyecto_id?._id ?? accion?.proyecto_id ?? ''));
        const macro = macroPorId.get(String(proyecto?.macroproyecto_id?._id ?? proyecto?.macroproyecto_id ?? ''));
        for (const p of ind.periodos_marcados) {
            wsPeriodos.addRow({
                codigo: ind.codigo,
                periodo: p.periodo,
                meta: toNumberValue(p.meta),
                avance: toNumberValue(p.avance),
                ultimo: p._es_ultimo_con_avance,
                estado: p.estado_reporte || '',
                reportado_por: p.reportado_por || '',
                fecha_envio: p.fecha_envio || null,
            });
            wsConsolidado.addRow({
                macro: macro?.codigo ?? '',
                proyecto: proyecto?.codigo ?? '',
                accion: accion?.codigo ?? '',
                indicador: ind.codigo,
                nombre: ind.nombre,
                periodo: p.periodo,
                meta: toNumberValue(p.meta),
                avance: toNumberValue(p.avance),
                estado: p.estado_reporte || '',
                reportado_por: p.reportado_por || '',
                fecha_envio: p.fecha_envio || null,
            });
        }
    }
    wsConsolidado.getColumn('K').numFmt = 'yyyy-mm-dd';
    wsConsolidado.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        row.getCell(5).alignment = { wrapText: true, vertical: 'top' };
    });
    const lastPeriodosRow = Math.max(wsPeriodos.rowCount, 2);
    wsPeriodos.getColumn('H').numFmt = 'yyyy-mm-dd';
    const P = {
        codigo: `Periodos!$A$2:$A$${lastPeriodosRow}`,
        meta: `Periodos!$C$2:$C$${lastPeriodosRow}`,
        avance: `Periodos!$D$2:$D$${lastPeriodosRow}`,
        ultimo: `Periodos!$E$2:$E$${lastPeriodosRow}`,
    };

    // ── Hoja "Indicadores" (solo con meta en ${anioStr}) ──────────────────────
    wsInd.columns = [
        { header: 'Código', key: 'codigo', width: 16 },
        { header: 'Nombre del indicador', key: 'nombre', width: 46 },
        { header: 'Código Acción', key: 'accion', width: 16 },
        { header: 'Peso en su Acción (%)', key: 'peso', width: 16 },
        { header: 'Tipo de cálculo', key: 'tipo', width: 20 },
        { header: `Meta ${anioStr}`, key: 'meta_anio', width: 16 },
        { header: 'Valor utilizado para el cálculo', key: 'avance_actual', width: 20 },
        { header: 'Porcentaje de avance del indicador (%)', key: 'pct_avance', width: 22 },
        { header: 'Semáforo', key: 'semaforo', width: 12 },
        { header: 'Fórmula aplicada', key: 'formula_texto', width: 60 },
    ];
    styleHeaderRow(wsInd.getRow(1));
    wsInd.autoFilter = { from: 'A1', to: 'J1' };
    wsInd.views = [{ state: 'frozen', ySplit: 1 }];

    const formulaTextoAnio = FORMULA_TEXTO_ANIO(anioStr);
    indicadoresAnio.forEach((ind, idx) => {
        const r = idx + 2;
        const accion = accionPorId.get(String(ind.accion_id?._id ?? ind.accion_id));
        const tipo = ind.tipo_calculo || 'promedio';

        wsInd.getCell(`A${r}`).value = ind.codigo;
        wsInd.getCell(`B${r}`).value = ind.nombre;
        wsInd.getCell(`C${r}`).value = accion?.codigo ?? '';
        wsInd.getCell(`D${r}`).value = ind.peso_norm;
        wsInd.getCell(`E${r}`).value = TIPO_LABEL[tipo] ?? tipo;

        // F: meta del año, calculada con fórmula (mismo criterio que el avance según tipo)
        const fFormula =
            tipo === 'acumulado'
                ? `SUMIF(${P.codigo},$A${r},${P.meta})`
                : tipo === 'ultimo_valor'
                ? `SUMIFS(${P.meta},${P.codigo},$A${r},${P.ultimo},TRUE)`
                : `IFERROR(ROUND(AVERAGEIF(${P.codigo},$A${r},${P.meta}),2),0)`;
        wsInd.getCell(`F${r}`).value = { formula: fFormula, result: ind.meta_anio };

        // G: avance operativo del año, calculado con fórmula según el tipo de cálculo
        const gFormula =
            tipo === 'acumulado'
                ? `SUMIF(${P.codigo},$A${r},${P.avance})`
                : tipo === 'ultimo_valor'
                ? `SUMIFS(${P.avance},${P.codigo},$A${r},${P.ultimo},TRUE)`
                : `IFERROR(ROUND(AVERAGEIF(${P.codigo},$A${r},${P.avance}),2),0)`;
        wsInd.getCell(`G${r}`).value = { formula: gFormula, result: ind.avance_operacion_anio };

        // H: % avance del indicador en el año, siempre G ÷ F (tope 100%).
        // Sin redondear: alimenta la Acción (columna E de "Acciones").
        const hFormula = `IF($F${r}>0,MIN(G${r}/$F${r},1)*100,0)`;
        wsInd.getCell(`H${r}`).value = { formula: hFormula, result: ind.avance_descarga };

        wsInd.getCell(`I${r}`).value = {
            formula: `IF(H${r}>=90,"Verde",IF(H${r}>=60,"Amarillo","Rojo"))`,
            result: ({ verde: 'Verde', amarillo: 'Amarillo', rojo: 'Rojo' })[ind.semaforo_descarga] || '',
        };
        wsInd.getCell(`J${r}`).value = formulaTextoAnio[tipo] ?? '';

        ['F', 'G', 'H'].forEach((col) => { wsInd.getCell(`${col}${r}`).numFmt = '0.00'; });
        wsInd.getCell(`J${r}`).alignment = { wrapText: true, vertical: 'top' };
        wsInd.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
    });
    const lastIndRow = Math.max(wsInd.rowCount, 2);
    const IND = {
        accion: `Indicadores!$C$2:$C$${lastIndRow}`,
        pct: `Indicadores!$H$2:$H$${lastIndRow}`,
        peso: `Indicadores!$D$2:$D$${lastIndRow}`,
    };

    // ── Hoja "Acciones" ───────────────────────────────────────────────────────
    wsAcc.columns = [
        { header: 'Código', key: 'codigo', width: 16 },
        { header: 'Nombre de la acción', key: 'nombre', width: 46 },
        { header: 'Código Proyecto', key: 'proyecto', width: 16 },
        { header: 'Peso en su Proyecto (%)', key: 'peso', width: 18 },
        { header: `Avance ${anioStr}\n(calculado con fórmula)`, key: 'avance_calc', width: 18 },
        { header: 'Fórmula aplicada', key: 'formula_texto', width: 70 },
    ];
    styleHeaderRow(wsAcc.getRow(1));
    wsAcc.autoFilter = { from: 'A1', to: 'F1' };
    wsAcc.views = [{ state: 'frozen', ySplit: 1 }];

    const ACCION_FORMULA_TXT = `Consolidación del avance ${anioStr} de la Acción Estratégica mediante la sumatoria ponderada del avance ${anioStr} de los indicadores que la conforman (solo los que tienen meta ese año), utilizando el peso asignado a cada uno.\nFórmula aplicada: Σ (Avance del Indicador × Peso del Indicador) ÷ 100.`;
    accionesNorm.forEach((acc, idx) => {
        const r = idx + 2;
        const proyecto = proyectoPorId.get(String(acc.proyecto_id?._id ?? acc.proyecto_id));
        wsAcc.getCell(`A${r}`).value = acc.codigo;
        wsAcc.getCell(`B${r}`).value = acc.nombre;
        wsAcc.getCell(`C${r}`).value = proyecto?.codigo ?? '';
        wsAcc.getCell(`D${r}`).value = acc.peso_norm;
        // Sin redondear: alimenta el Proyecto.
        wsAcc.getCell(`E${r}`).value = {
            formula: `SUMPRODUCT((${IND.accion}=$A${r})*${IND.pct}*${IND.peso})/100`,
            result: acc.avance_descarga,
        };
        wsAcc.getCell(`F${r}`).value = ACCION_FORMULA_TXT;
        ['D', 'E'].forEach((col) => { wsAcc.getCell(`${col}${r}`).numFmt = '0.00'; });
        wsAcc.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
        wsAcc.getCell(`F${r}`).alignment = { wrapText: true, vertical: 'top' };
    });
    const lastAccRow = Math.max(wsAcc.rowCount, 2);
    const ACC = {
        proyecto: `Acciones!$C$2:$C$${lastAccRow}`,
        avance: `Acciones!$E$2:$E$${lastAccRow}`,
        peso: `Acciones!$D$2:$D$${lastAccRow}`,
    };

    // ── Hoja "Proyectos" ──────────────────────────────────────────────────────
    wsProy.columns = [
        { header: 'Código', key: 'codigo', width: 16 },
        { header: 'Nombre del proyecto', key: 'nombre', width: 46 },
        { header: 'Código Macroproyecto', key: 'macro', width: 18 },
        { header: 'Peso en su Macroproyecto (%)', key: 'peso', width: 20 },
        { header: `Avance ${anioStr}\n(calculado con fórmula)`, key: 'avance_calc', width: 18 },
        { header: 'Fórmula aplicada', key: 'formula_texto', width: 70 },
    ];
    styleHeaderRow(wsProy.getRow(1));
    wsProy.autoFilter = { from: 'A1', to: 'F1' };
    wsProy.views = [{ state: 'frozen', ySplit: 1 }];

    const PROYECTO_FORMULA_TXT = `Consolidación del avance ${anioStr} del proyecto mediante la sumatoria ponderada del avance ${anioStr} de las acciones estratégicas que lo conforman, utilizando el peso asignado a cada una.\nFórmula aplicada: Σ (Avance de la acción estratégica × Peso de la acción estratégica) ÷ 100.`;
    proyectosNorm.forEach((p, idx) => {
        const r = idx + 2;
        const macro = macroPorId.get(String(p.macroproyecto_id?._id ?? p.macroproyecto_id));
        wsProy.getCell(`A${r}`).value = p.codigo;
        wsProy.getCell(`B${r}`).value = p.nombre;
        wsProy.getCell(`C${r}`).value = macro?.codigo ?? '';
        wsProy.getCell(`D${r}`).value = p.peso_norm;
        // Sin redondear: alimenta el Macroproyecto.
        wsProy.getCell(`E${r}`).value = {
            formula: `SUMPRODUCT((${ACC.proyecto}=$A${r})*${ACC.avance}*${ACC.peso})/100`,
            result: p.avance_descarga,
        };
        wsProy.getCell(`F${r}`).value = PROYECTO_FORMULA_TXT;
        ['D', 'E'].forEach((col) => { wsProy.getCell(`${col}${r}`).numFmt = '0.00'; });
        wsProy.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
        wsProy.getCell(`F${r}`).alignment = { wrapText: true, vertical: 'top' };
    });
    const lastProyRow = Math.max(wsProy.rowCount, 2);
    const PROY = {
        macro: `Proyectos!$C$2:$C$${lastProyRow}`,
        avance: `Proyectos!$E$2:$E$${lastProyRow}`,
        peso: `Proyectos!$D$2:$D$${lastProyRow}`,
    };

    // ── Hoja "Macroproyectos" ─────────────────────────────────────────────────
    wsMacro.columns = [
        { header: 'Código', key: 'codigo', width: 16 },
        { header: 'Nombre del macroproyecto', key: 'nombre', width: 46 },
        { header: 'Peso (para el ponderado global)', key: 'peso', width: 20 },
        { header: `Avance ${anioStr}\n(calculado con fórmula)`, key: 'avance_calc', width: 18 },
        { header: 'Fórmula aplicada', key: 'formula_texto', width: 70 },
    ];
    styleHeaderRow(wsMacro.getRow(1));
    wsMacro.autoFilter = { from: 'A1', to: 'E1' };
    wsMacro.views = [{ state: 'frozen', ySplit: 1 }];

    const MACRO_FORMULA_TXT = `El avance ${anioStr} del macroproyecto se obtiene mediante la sumatoria ponderada del avance ${anioStr} de los proyectos asociados, utilizando el peso definido para cada proyecto (Σ Avance × Peso ÷ 100).`;
    macrosNorm.forEach((m, idx) => {
        const r = idx + 2;
        wsMacro.getCell(`A${r}`).value = m.codigo;
        wsMacro.getCell(`B${r}`).value = m.nombre;
        wsMacro.getCell(`C${r}`).value = m.peso_norm;
        // Macroproyecto SÍ se redondea a entero (valor final que se muestra).
        wsMacro.getCell(`D${r}`).value = {
            formula: `ROUND(SUMPRODUCT((${PROY.macro}=$A${r})*${PROY.avance}*${PROY.peso})/100,0)`,
            result: m.avance_descarga,
        };
        wsMacro.getCell(`E${r}`).value = MACRO_FORMULA_TXT;
        ['C', 'D'].forEach((col) => { wsMacro.getCell(`${col}${r}`).numFmt = '0.00'; });
        wsMacro.getCell(`B${r}`).alignment = { wrapText: true, vertical: 'top' };
        wsMacro.getCell(`E${r}`).alignment = { wrapText: true, vertical: 'top' };
    });

    // ── Hoja "Resumen PDI {año}" (primera pestaña, resultado principal) ──────
    wsResumen.columns = [
        { width: 22 }, { width: 46 }, { width: 16 }, { width: 18 }, { width: 18 }, { width: 12 }, { width: 12 }, { width: 12 },
    ];

    wsResumen.mergeCells('A1:H1');
    wsResumen.getCell('A1').value = `Tablero de control PDI — Memoria de cálculo del avance ${anioStr}`;
    wsResumen.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF4C1D95' } };
    wsResumen.mergeCells('A2:H2');
    wsResumen.getCell('A2').value = `Generado el ${generatedAt.toLocaleString('es-CO', { timeZone: 'America/Bogota' })}. Datos consultados y recalculados al momento de la descarga.`;
    wsResumen.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' } };

    let nextRow = addExplanationBlock(wsResumen, 4, [
        'Cómo leer este archivo:',
        `• Este archivo es la versión de la memoria de cálculo enfocada SOLO en ${anioStr}: usa la misma cadena de cálculo Periodos → Indicadores → Acciones → Proyectos → Macroproyectos → PDI que el archivo general, pero cada nivel se calcula contra la meta de ${anioStr}, no contra la Meta final 2029.`,
        `• Solo se incluyen los indicadores que tienen meta definida en ${anioStr}: los que aplican a otros años del plan no aparecen aquí.`,
        '• Cada hoja tiene una columna "Fórmula aplicada" con el detalle del cálculo. Este archivo no compara contra un valor "guardado en el sistema": el sistema no persiste un avance por año a nivel de Acción/Proyecto/Macroproyecto/PDI (solo el avance por periodo de cada indicador).',
        `• Si una Acción tiene indicadores que no aplican a ${anioStr}, su peso total con meta ese año puede no sumar 100%; en ese caso el avance de esa acción (y el de su proyecto/macroproyecto) puede quedar subestimado. Ver hoja Validaciones, categoría "Peso cubierto en ${anioStr}".`,
    ]);

    nextRow += 1;
    wsResumen.getCell(`A${nextRow}`).value = `Avance ponderado ${anioStr}`;
    wsResumen.getCell(`A${nextRow}`).font = { bold: true, size: 13 };
    nextRow += 1;

    const tablaMacrosHeaderRow = nextRow;
    wsResumen.getCell(`A${tablaMacrosHeaderRow}`).value = 'Código';
    wsResumen.getCell(`B${tablaMacrosHeaderRow}`).value = 'Macroproyecto';
    wsResumen.getCell(`C${tablaMacrosHeaderRow}`).value = 'Peso (%)';
    wsResumen.getCell(`D${tablaMacrosHeaderRow}`).value = `Avance ${anioStr} calculado (%)`;
    wsResumen.getRow(tablaMacrosHeaderRow).eachCell((cell, colNumber) => {
        if (colNumber > 4) return;
        cell.font = { bold: true };
        cell.fill = SUBHEADER_FILL;
    });
    nextRow += 1;
    const firstMacroDataRow = nextRow;
    macrosNorm.forEach((m, idx) => {
        const r = nextRow + idx;
        wsResumen.getCell(`A${r}`).value = m.codigo;
        wsResumen.getCell(`B${r}`).value = m.nombre;
        wsResumen.getCell(`C${r}`).value = { formula: `Macroproyectos!C${idx + 2}`, result: m.peso_norm };
        wsResumen.getCell(`D${r}`).value = { formula: `Macroproyectos!D${idx + 2}`, result: m.avance_descarga };
        ['C', 'D'].forEach((col) => { wsResumen.getCell(`${col}${r}`).numFmt = '0.00'; });
    });
    nextRow += macrosNorm.length;
    const lastMacroDataRow = nextRow - 1;

    nextRow += 1;
    wsResumen.getCell(`A${nextRow}`).value = `Avance ponderado global ${anioStr} (calculado con fórmula)`;
    wsResumen.getCell(`A${nextRow}`).font = { bold: true };
    wsResumen.mergeCells(`A${nextRow}:C${nextRow}`);
    wsResumen.getCell(`D${nextRow}`).value = {
        formula: `IFERROR(ROUND(SUMPRODUCT(D${firstMacroDataRow}:D${lastMacroDataRow},C${firstMacroDataRow}:C${lastMacroDataRow})/SUM(C${firstMacroDataRow}:C${lastMacroDataRow}),0),0)`,
        result: avanceGlobalDescarga,
    };
    wsResumen.getCell(`D${nextRow}`).font = { bold: true, size: 13, color: { argb: 'FF15803D' } };
    wsResumen.getCell(`D${nextRow}`).numFmt = '0.00';
    nextRow += 1;

    nextRow += 1;
    wsResumen.getCell(`A${nextRow}`).value = 'Estructura considerada';
    wsResumen.getCell(`A${nextRow}`).font = { bold: true, size: 13 };
    nextRow += 1;
    [
        ['Macroproyectos', macros.length],
        ['Proyectos', proyectos.length],
        ['Acciones estratégicas', acciones.length],
        [`Indicadores con meta en ${anioStr}`, indicadoresAnio.length],
        ['Indicadores totales del PDI', indicadores.length],
    ].forEach(([label, value]) => {
        wsResumen.getCell(`A${nextRow}`).value = label;
        wsResumen.getCell(`B${nextRow}`).value = value;
        nextRow += 1;
    });

    nextRow += 1;
    wsResumen.getCell(`A${nextRow}`).value = 'Hojas de este archivo:';
    wsResumen.getCell(`A${nextRow}`).font = { bold: true };
    nextRow += 1;
    [
        'Guía — propósito de cada hoja y diccionario de columnas de este archivo enfocado en el año.',
        'Validaciones — hallazgos calculados al momento de la descarga: pesos, códigos, relaciones, metas y cobertura del peso en el año.',
        `Macroproyectos — avance ${anioStr} de cada macroproyecto y su fórmula.`,
        `Proyectos — avance ${anioStr} de cada proyecto y su fórmula.`,
        `Acciones — avance ${anioStr} de cada acción estratégica y su fórmula.`,
        `Indicadores — avance ${anioStr} de cada indicador con meta ese año, su tipo de cálculo y su fórmula detallada.`,
        `Periodos — meta y avance reportados en los cortes de ${anioStr} que alimentan las fórmulas anteriores (no editar: es la base técnica de los cálculos).`,
        `Metas y Avances por Periodo — la misma información de "Periodos", pero en formato consolidado y legible, con la jerarquía completa (Macroproyecto, Proyecto, Acción, Indicador). Es solo de consulta, no alimenta fórmulas.`,
    ].forEach((line) => {
        wsResumen.getCell(`A${nextRow}`).value = `• ${line}`;
        wsResumen.mergeCells(`A${nextRow}:H${nextRow}`);
        nextRow += 1;
    });

    // ── Hoja "Guía" ──────────────────────────────────────────────────────────
    wsGuia.columns = [
        { width: 24 }, { width: 42 }, { width: 44 }, { width: 44 }, { width: 34 }, { width: 52 },
    ];
    wsGuia.mergeCells('A1:F1');
    wsGuia.getCell('A1').value = `Guía de lectura de la memoria de cálculo PDI — ${anioStr}`;
    wsGuia.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FF4C1D95' } };
    wsGuia.mergeCells('A2:F2');
    wsGuia.getCell('A2').value = `Este archivo documenta qué recibe cada hoja, qué genera y cómo se calcula el avance de ${anioStr} desde Indicador hasta PDI.`;
    wsGuia.getCell('A2').font = { italic: true, color: { argb: 'FF6B7280' } };

    const writeGuideTable = (title, headers, rows, startRow) => {
        let row = startRow;
        wsGuia.getCell(`A${row}`).value = title;
        wsGuia.getCell(`A${row}`).font = { bold: true, size: 13 };
        wsGuia.mergeCells(`A${row}:F${row}`);
        row += 1;

        headers.forEach((header, index) => {
            const cell = wsGuia.getCell(row, index + 1);
            cell.value = header;
            cell.font = HEADER_FONT;
            cell.fill = HEADER_FILL;
            cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
        });
        row += 1;

        rows.forEach((values) => {
            values.forEach((value, index) => {
                const cell = wsGuia.getCell(row, index + 1);
                cell.value = value;
                cell.alignment = { wrapText: true, vertical: 'top' };
            });
            row += 1;
        });

        return row + 2;
    };

    let guiaRow = 4;
    guiaRow = writeGuideTable(
        'Propósito, entradas y salidas por hoja',
        ['Hoja', 'Propósito', 'Información que recibe', 'Información que genera'],
        [
            [`Resumen PDI ${anioStr}`, `Presenta el resultado de ${anioStr} y la estructura considerada.`, 'Avances calculados de macroproyectos y pesos globales para ese año.', `Avance ponderado ${anioStr} calculado.`],
            ['Guía', 'Explica cómo leer el archivo.', 'Reglas de negocio y estructura del libro.', 'Diccionario de columnas y reglas de validación.'],
            ['Validaciones', 'Muestra controles de calidad del modelo.', 'Códigos, pesos, relaciones jerárquicas, metas y cobertura del peso en el año.', 'Estados OK, Advertencia o Error con acción sugerida.'],
            ['Macroproyectos', `Calcula avance ${anioStr} por macroproyecto.`, 'Proyectos asociados al macroproyecto y sus pesos.', `Avance ${anioStr} calculado.`],
            ['Proyectos', `Calcula avance ${anioStr} por proyecto.`, 'Acciones estratégicas asociadas al proyecto y sus pesos.', `Avance ${anioStr} calculado.`],
            ['Acciones', `Calcula avance ${anioStr} por acción estratégica.`, `Indicadores con meta en ${anioStr} asociados a la acción y sus pesos.`, `Avance ${anioStr} calculado.`],
            ['Indicadores', `Calcula avance ${anioStr} por indicador.`, `Periodos de ${anioStr}, tipo de cálculo y peso en la acción.`, `Meta ${anioStr}, avance operativo, porcentaje final y semáforo.`],
            ['Periodos', `Conserva la base granular del cálculo de ${anioStr}.`, `Metas y avances reportados en los cortes de ${anioStr}.`, 'Marca el último periodo del año con avance y alimenta las fórmulas de indicadores. No editar: es la base técnica del cálculo.'],
            ['Metas y Avances por Periodo', 'Presenta lo mismo que "Periodos", en formato legible para consulta.', `Metas y avances reportados en los cortes de ${anioStr}, con la jerarquía completa.`, 'Tabla consolidada con Macroproyecto, Proyecto, Acción, Indicador, meta y valor reportado de cada periodo. Solo de consulta, no alimenta fórmulas.'],
        ],
        guiaRow
    );

    guiaRow = writeGuideTable(
        `Cálculo del avance por nivel (todo referido a ${anioStr})`,
        ['Nivel', 'Cálculo', 'Resultado'],
        [
            ['Indicador', `Según tipo de cálculo (Acumulado, Promedio o Último valor reportado), usando solo los periodos de ${anioStr}. Se compara contra la Meta ${anioStr} (no la Meta final 2029).`, `% de avance del indicador en ${anioStr}, capado a 100%.`],
            ['Acción Estratégica', `Σ(% avance ${anioStr} del indicador × peso del indicador) ÷ 100, solo con indicadores que tienen meta en ${anioStr}.`, `Avance ponderado ${anioStr} de la acción.`],
            ['Proyecto', `Σ(avance ${anioStr} de la acción × peso de la acción) ÷ 100.`, `Avance ponderado ${anioStr} del proyecto.`],
            ['Macroproyecto', `Σ(avance ${anioStr} del proyecto × peso del proyecto) ÷ 100.`, `Avance ponderado ${anioStr} del macroproyecto.`],
            ['PDI', `Sumatoria ponderada del avance ${anioStr} de los macroproyectos: Σ (Avance ${anioStr} del Macroproyecto × Peso del Macroproyecto) ÷ 100.`, `Avance global de ${anioStr}.`],
        ],
        guiaRow
    );

    guiaRow = writeGuideTable(
        'Tipos de cálculo disponibles',
        ['Tipo', 'Cuándo usarlo', `Fórmula del indicador en ${anioStr}`],
        [
            ['Acumulado', 'Indicadores que suman cantidades a lo largo del tiempo.', `SUMA(avances reportados en ${anioStr}) ÷ SUMA(metas de ${anioStr}) × 100.`],
            ['Promedio', 'Aplica a indicadores cuya medición corresponda al promedio de los valores reportados durante el periodo.', `Promedio de los avances de ${anioStr} ÷ promedio de las metas de ${anioStr} × 100.`],
            ['Último valor reportado', 'Indicadores donde solo importa el corte más reciente con avance.', `Último avance reportado en ${anioStr} ÷ meta de ese mismo periodo × 100.`],
        ],
        guiaRow
    );

    writeGuideTable(
        'Validaciones que realiza el archivo',
        ['Validación', 'Qué revisa', 'Resultado esperado'],
        [
            ['Pesos al 100%', 'Macroproyectos del PDI y elementos hijos en cada nivel (estructura completa, no solo lo de este año).', 'Cada grupo debe sumar exactamente 100%.'],
            ['Códigos duplicados', `Códigos repetidos entre los indicadores con meta en ${anioStr} (y en macroproyectos/proyectos/acciones).`, 'No debe haber códigos repetidos dentro del mismo nivel.'],
            ['Relaciones jerárquicas', 'Proyecto → Macroproyecto, Acción → Proyecto, Indicador → Acción.', 'Cada elemento debe tener un padre válido.'],
            ['Valores numéricos', `Avances y metas de los periodos de ${anioStr}.`, 'Los campos que participan en cálculo deben ser numéricos.'],
            ['Tipos de cálculo', 'Tipo configurado en cada indicador incluido.', 'Debe ser Acumulado, Promedio o Último valor reportado.'],
            [`Peso cubierto en ${anioStr}`, `Que el peso de los indicadores con meta en ${anioStr} sume 100% dentro de cada acción.`, `Si no suma 100%, el avance ${anioStr} de esa acción (y de su proyecto/macroproyecto) puede estar subestimado.`],
        ],
        guiaRow
    );
    wsGuia.views = [{ state: 'frozen', ySplit: 1 }];

    // ── Hoja "Validaciones" ───────────────────────────────────────────────────
    wsValidaciones.columns = [
        { header: 'Categoría', key: 'categoria', width: 26 },
        { header: 'Nivel', key: 'nivel', width: 24 },
        { header: 'Código', key: 'codigo', width: 20 },
        { header: 'Estado', key: 'estado', width: 16 },
        { header: 'Detalle', key: 'detalle', width: 62 },
        { header: 'Acción sugerida', key: 'accion', width: 62 },
    ];
    styleHeaderRow(wsValidaciones.getRow(1));
    wsValidaciones.autoFilter = { from: 'A1', to: 'F1' };
    wsValidaciones.views = [{ state: 'frozen', ySplit: 1 }];

    validationRows.forEach((validation) => {
        const row = wsValidaciones.addRow(validation);
        const statusCell = row.getCell(4);
        if (validation.estado === 'OK') {
            statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDCFCE7' } };
            statusCell.font = { bold: true, color: { argb: 'FF166534' } };
        } else if (validation.estado === 'Advertencia') {
            statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
            statusCell.font = { bold: true, color: { argb: 'FF92400E' } };
        } else {
            statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
            statusCell.font = { bold: true, color: { argb: 'FF991B1B' } };
        }
        row.eachCell((cell) => {
            cell.alignment = { wrapText: true, vertical: 'top' };
        });
    });

    workbook.views = [{ activeTab: 0 }];

    return workbook;
}

module.exports = { buildAvanceWorkbook, buildIndicadoresMetasWorkbook, buildAvanceWorkbookAnio };
