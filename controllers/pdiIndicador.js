const Indicador = require('../models/pdiIndicador');
const RespuestaFormulario = require('../models/pdiFormularioRespuesta');
const { withSemaforo } = require('../helpers/pdiSemaforo');
const { recalcularProyecto } = require('./pdiAccionEstrategica');
const { deleteFile, buildUrl } = require('../services/pdiFileStorage');
const fs = require('fs/promises');
const { uploadFile: uploadDriveFile, deleteFile: deleteDriveFile } = require('../services/pdiDriveStorage');
const { getHierarchyForIndicador } = require('../services/pdiDriveHierarchy');
const Historial = require('../models/pdiIndicadorHistorial');
const User = require('../models/users');
const AccionEstrategica = require('../models/pdiAccionEstrategica');
require('../models/pdiProyecto');
require('../models/pdiMacroproyecto');
const {
    toNumberValue,
    clampPercentage,
    weightedContribution,
} = require('../services/pdiAvanceCalculator');
const {
    autoApproveAllPendingLeaderSubmittedResponses,
} = require('../services/pdiFormulario');

const normalizePeriodoKey = (value) => String(value ?? '').trim().toUpperCase();
const INDICADOR_CODE_REGEX = /^(M[1-9]\d*)-(P[1-9]\d*)-(A[1-9]\d*)-(I([1-9]\d*))$/;

function normalizeIndicatorCode(value) {
    return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

function getEntityId(value) {
    return String(value?._id ?? value?.id ?? value ?? '').trim();
}

function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseIndicatorCode(value) {
    const normalized = normalizeIndicatorCode(value);
    const match = normalized.match(INDICADOR_CODE_REGEX);
    if (!match) return null;

    return {
        normalized,
        macro: match[1],
        proyecto: match[2],
        accion: match[3],
        indicador: match[4],
        indicadorNumero: Number(match[5]),
    };
}

function extractCodeSegment(value, letter) {
    const segmentRegex = new RegExp(`^${letter}[1-9]\\d*$`);
    return normalizeIndicatorCode(value)
        .split('-')
        .find((part) => segmentRegex.test(part)) || null;
}

function extractIndicatorNumber(value) {
    const segment = normalizeIndicatorCode(value)
        .split('-')
        .find((part) => /^I[1-9]\d*$/.test(part));
    return segment ? Number(segment.slice(1)) : null;
}

function getFirstAvailableIndicatorNumber(usedNumbers) {
    let nextNumber = 1;
    while (usedNumbers.has(nextNumber)) nextNumber += 1;
    return nextNumber;
}

function buildFlexibleCodeRegex(normalizedCode) {
    return `^\\s*${normalizedCode.split('-').map(escapeRegex).join('\\s*-\\s*')}\\s*$`;
}

async function getAccionHierarchy(accionId) {
    const accion = await AccionEstrategica.findById(accionId)
        .select('codigo nombre proyecto_id')
        .populate({
            path: 'proyecto_id',
            select: 'codigo nombre macroproyecto_id',
            populate: {
                path: 'macroproyecto_id',
                select: 'codigo nombre',
            },
        })
        .lean();

    if (!accion) {
        throw new Error('La accion estrategica seleccionada no existe.');
    }

    const proyecto = accion.proyecto_id;
    const macro = proyecto?.macroproyecto_id;

    if (!proyecto || !macro) {
        throw new Error('La accion estrategica seleccionada no tiene una jerarquia completa de macroproyecto y proyecto.');
    }

    return { accion, proyecto, macro };
}

function buildExpectedIndicatorPrefix({ accion, proyecto, macro }) {
    const macroSegment = extractCodeSegment(macro?.codigo, 'M');
    const proyectoSegment = extractCodeSegment(proyecto?.codigo, 'P');
    const accionSegment = extractCodeSegment(accion?.codigo, 'A');

    if (!macroSegment || !proyectoSegment || !accionSegment) {
        throw new Error('No se puede validar el codigo porque la jerarquia seleccionada no tiene codigos M/P/A completos.');
    }

    return `${macroSegment}-${proyectoSegment}-${accionSegment}`;
}

async function findDuplicateIndicatorCode(normalizedCode, currentId) {
    const query = {
        codigo: { $regex: buildFlexibleCodeRegex(normalizedCode), $options: 'i' },
    };
    if (currentId) query._id = { $ne: currentId };

    return Indicador.findOne(query).select('_id codigo nombre').lean();
}

async function validateIndicatorNumberSequence({ parsed, accionId, expectedPrefix, currentId, existing, accion }) {
    const query = { accion_id: accionId };
    if (currentId) query._id = { $ne: currentId };

    const siblings = await Indicador.find(query).select('_id codigo nombre').lean();
    const usedNumbers = new Set();
    let sameNumberSibling = null;

    for (const sibling of siblings) {
        const number = extractIndicatorNumber(sibling.codigo);
        if (!number) continue;
        usedNumbers.add(number);
        if (number === parsed.indicadorNumero) sameNumberSibling = sibling;
    }

    if (sameNumberSibling) {
        throw new Error(`Ya existe un indicador con la numeracion I${parsed.indicadorNumero} dentro de la accion ${accion.codigo}. Codigo actual: ${sameNumberSibling.codigo}.`);
    }

    const existingParsed = parseIndicatorCode(existing?.codigo);
    const keepsSameActionAndNumber = Boolean(
        currentId &&
        getEntityId(existing?.accion_id) === accionId &&
        existingParsed?.indicadorNumero === parsed.indicadorNumero
    );

    if (keepsSameActionAndNumber) return;

    const expectedNumber = getFirstAvailableIndicatorNumber(usedNumbers);
    if (parsed.indicadorNumero !== expectedNumber) {
        throw new Error(`La numeracion del indicador no es consecutiva dentro de la accion ${accion.codigo}. El siguiente codigo esperado es ${expectedPrefix}-I${expectedNumber}.`);
    }
}

async function validateIndicatorPayload(body, { currentId = null, existing = null } = {}) {
    const parsed = parseIndicatorCode(body.codigo ?? existing?.codigo);
    if (!parsed) {
        throw new Error('El codigo del indicador debe tener la estructura completa M#-P#-A#-I# (por ejemplo, M4-P1-A4-I1).');
    }

    const accionId = getEntityId(body.accion_id ?? existing?.accion_id);
    if (!accionId) {
        throw new Error('Debes seleccionar una accion estrategica para validar el codigo del indicador.');
    }

    const hierarchy = await getAccionHierarchy(accionId);
    const expectedPrefix = buildExpectedIndicatorPrefix(hierarchy);
    const currentPrefix = `${parsed.macro}-${parsed.proyecto}-${parsed.accion}`;

    if (currentPrefix !== expectedPrefix) {
        throw new Error(`El codigo ${parsed.normalized} no corresponde con la jerarquia seleccionada. Para la accion ${hierarchy.accion.codigo} debe iniciar con ${expectedPrefix}-I.`);
    }

    const duplicate = await findDuplicateIndicatorCode(parsed.normalized, currentId);
    if (duplicate) {
        throw new Error(`Ya existe un indicador con el codigo ${duplicate.codigo}. Corrige el codigo antes de guardar.`);
    }

    await validateIndicatorNumberSequence({
        parsed,
        accionId,
        expectedPrefix,
        currentId,
        existing,
        accion: hierarchy.accion,
    });

    return { codigo: parsed.normalized, accionId };
}

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

async function applyRespuestaStateToIndicadores(input) {
    const docs = Array.isArray(input) ? input : [input].filter(Boolean);
    if (!docs.length) return input;

    const ids = docs.map((doc) => String(doc?._id || '')).filter(Boolean);
    if (!ids.length) return input;

    const respuestas = await RespuestaFormulario.find({
        indicador_id: { $in: ids },
        estado: 'Enviado',
    }).select('indicador_id corte estado estado_aval aval_planeacion fecha_envio respondido_por').lean();

    if (!respuestas.length) return input;

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

    for (const doc of docs) {
        if (!Array.isArray(doc.periodos)) continue;

        let changed = false;
        doc.periodos.forEach((periodo) => {
            const estado = estadosPorIndicadorCorte.get(`${String(doc?._id || '')}::${normalizePeriodoKey(periodo.periodo)}`);
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

        if (changed && typeof doc.save === 'function') {
            doc.markModified('periodos');
            await doc.save();
        }
    }

    return input;
}

async function applyPlaneacionStateToIndicadores(input) {
    return applyRespuestaStateToIndicadores(input);
}

function withCalculatedFields(doc) {
    const base = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    return {
        ...base,
        ...calcularCamposDinamicos(base.periodos || [], base.tipo_calculo, base.meta_final_2029),
    };
}

function round2(value) {
    return Math.round((Number(value) || 0) * 100) / 100;
}

function valoresNumericos(lista = [], campo) {
    return lista
        .map((p) => toNumberValue(p[campo]))
        .filter((value) => value !== null);
}

// Indicadores tipo "promedio":
// promedio aritmético de los avances reportados en los periodos con dato.
function promedioAvances(lista = []) {
    const valores = valoresNumericos(lista, 'avance');
    if (!valores.length) return null;
    return round2(valores.reduce((acc, value) => acc + value, 0) / valores.length);
}

function promedioMetas(lista = []) {
    const valores = valoresNumericos(lista, 'meta');
    if (!valores.length) return null;
    return round2(valores.reduce((acc, value) => acc + value, 0) / valores.length);
}

function ordenarPeriodos(lista = []) {
    return [...lista].sort((a, b) => String(a.periodo ?? '').localeCompare(String(b.periodo ?? '')));
}

// Un periodo recien agregado guarda avance:0 por defecto aunque nadie lo haya
// reportado (estado_reporte queda en 'Borrador'). Si solo filtraramos por
// "avance no nulo" ese 0 de relleno se confundiria con un reporte real y
// desplazaria el ultimo valor genuino hacia un periodo futuro sin reportar.
function fueReportado(p) {
    return Boolean(p.estado_reporte) && p.estado_reporte !== 'Borrador';
}

function ultimoValor(lista) {
    const con = ordenarPeriodos(lista).filter((p) =>
        fueReportado(p) &&
        p.avance !== null && p.avance !== undefined &&
        p.avance !== '' && toNumberValue(p.avance) !== null
    );
    return con.length ? toNumberValue(con[con.length - 1].avance) : null;
}

function sumarAvances(lista = []) {
    return lista.reduce((acc, p) => acc + (toNumberValue(p.avance) ?? 0), 0);
}

function sumarMetas(lista = []) {
    return lista.reduce((acc, p) => acc + (toNumberValue(p.meta) ?? 0), 0);
}

function calcularAvanceActual(periodosOrdenados, tipo_calculo) {
    if (tipo_calculo === 'acumulado') {
        return Math.round(sumarAvances(periodosOrdenados) * 100) / 100;
    }

    if (tipo_calculo === 'ultimo_valor') {
        const ultimo = ultimoValor(periodosOrdenados);
        return ultimo !== null ? ultimo : 0;
    }

    const promedio = promedioAvances(periodosOrdenados);
    return promedio !== null ? promedio : 0;
}

function calcularAvanceAnual(periodosOrdenados, tipo_calculo, anio) {
    const periodosDelAnio = periodosOrdenados.filter(
        (p) => String(p.periodo ?? '').slice(0, 4) === anio
    );

    if (!periodosDelAnio.length) return 0;
    return calcularAvanceActual(periodosDelAnio, tipo_calculo);
}

/*
  Formula tomada del Excel:
  - avanceActual: suma acumulada, promedio aritmetico o ultimo valor reportado (crudo), segun tipo_calculo
  - avance: % de avance total capado a 100, siempre referenciado contra la Meta final 2029
  - avance_total_real: % de avance total mostrado en la UI
  - avances_por_anio: % del avance reportado en cada anio, tambien referenciado contra la Meta final 2029
    para "ultimo_valor" (es la misma medicion evolucionando hacia una unica meta final, no una cuota
    independiente por anio); para "acumulado"/"promedio" sigue comparando cada anio contra la meta
    propia de ese anio, porque ahi si son cuotas anuales independientes.
*/
function calcularCamposDinamicos(periodos, tipo_calculo, meta_final_2029) {
    const periodosOrdenados = ordenarPeriodos(periodos);
    const metaFinal = toNumberValue(meta_final_2029);
    const avanceActual = calcularAvanceActual(periodosOrdenados, tipo_calculo);

    const anios = [...new Set(
        periodosOrdenados
            .map((p) => String(p.periodo ?? '').slice(0, 4))
            .filter(Boolean)
    )].sort();

    const avances_por_anio = {};
    for (const anio of anios) {
        const periodosDelAnio = periodosOrdenados.filter((p) => String(p.periodo ?? '').slice(0, 4) === anio);
        const avanceAnual = calcularAvanceAnual(periodosOrdenados, tipo_calculo, anio);
        const metaReferencia = tipo_calculo === 'ultimo_valor'
            ? metaFinal
            : tipo_calculo === 'promedio'
            ? promedioMetas(periodosDelAnio)
            : sumarMetas(periodosDelAnio);
        avances_por_anio[anio] = metaReferencia > 0
            ? round2(Math.min(avanceAnual / metaReferencia, 1) * 100)
            : 0;
    }

    const avance = metaFinal > 0
        ? round2(Math.min(avanceActual / metaFinal, 1) * 100)
        : 0;

    const avanceTotalRealRaw = metaFinal > 0
        ? round2((avanceActual / metaFinal) * 100)
        : null;
    const avance_total_real = avanceTotalRealRaw === null ? null : clampPercentage(avanceTotalRealRaw);
    const avance_actual = clampPercentage(avance_total_real ?? avance);

    return { avances_por_anio, avance, avance_total_real, avance_actual };
}

async function recalcularAccion(accion_id) {
    const indicadores = await Indicador.find({ accion_id });
    if (!indicadores.length) return;

    // En Excel la accion suma la contribucion ponderada de los indicadores
    // usando el % de avance total capado (no el porcentaje real sin tope).
    const avance = weightedContribution(
        indicadores,
        (indicador) => indicador.avance,
        (indicador) => indicador.peso
    );

    const accion = await AccionEstrategica.findByIdAndUpdate(accion_id, { avance }, { new: true });
    if (accion) await recalcularProyecto(accion.proyecto_id);
}

const ctrl = {};

async function guardarHistorial(antes, despues, modificado_por = '') {
    try {
        const camposIgnorar = ['updatedAt', 'createdAt', '__v', 'avances_por_anio', 'avance', 'avance_total_real', 'avance_actual'];
        const campos_cambiados = [];

        const comparar = (a, b, prefix = '') => {
            const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
            for (const k of keys) {
                if (camposIgnorar.includes(k)) continue;
                const va = JSON.stringify(a?.[k]);
                const vb = JSON.stringify(b?.[k]);
                if (va !== vb) campos_cambiados.push(prefix ? `${prefix}.${k}` : k);
            }
        };

        comparar(antes, despues);

        // Resolver nombre completo si modificado_por es un email
        let modificado_por_nombre = '';
        if (modificado_por && modificado_por.includes('@')) {
            const usuario = await User.findOne({ email: modificado_por }).select('full_name name').lean();
            modificado_por_nombre = usuario?.full_name || usuario?.name || '';
        }

        await Historial.create({
            indicador_id: antes._id,
            indicador_codigo: antes.codigo,
            indicador_nombre: antes.nombre,
            modificado_por,
            modificado_por_nombre,
            antes: JSON.parse(JSON.stringify(antes)),
            despues: JSON.parse(JSON.stringify(despues)),
            campos_cambiados,
        });
    } catch (e) {
        console.error('Error guardando historial:', e.message);
    }
}

ctrl.getAll = async (req, res) => {
    try {
        const query = {};
        if (req.query.accion_id) query.accion_id = req.query.accion_id;
        const docs = await Indicador.find(query).populate('accion_id', 'codigo nombre responsable responsable_email').sort({ codigo: 1 });
        await autoApproveAllPendingLeaderSubmittedResponses();
        await applyPlaneacionStateToIndicadores(docs);
        res.json(docs.map((doc) => withSemaforo(withCalculatedFields(doc))));
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.getById = async (req, res) => {
    try {
        const doc = await Indicador.findById(req.params.id).populate('accion_id', 'codigo nombre responsable responsable_email');
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        await autoApproveAllPendingLeaderSubmittedResponses();
        await applyPlaneacionStateToIndicadores(doc);
        res.json(withSemaforo(withCalculatedFields(doc)));
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.create = async (req, res) => {
    try {
        const body = { ...req.body };
        const validated = await validateIndicatorPayload(body);
        body.codigo = validated.codigo;
        body.accion_id = validated.accionId;
        const calculados = calcularCamposDinamicos(body.periodos || [], body.tipo_calculo, body.meta_final_2029);
        const doc = await Indicador.create({ ...body, ...calculados });
        await recalcularAccion(doc.accion_id);
        res.status(201).json(withSemaforo(doc));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

// El formulario de "Editar Indicador" (pestaña Metas Periodos) solo conoce
// periodo/meta/avance/fechas; no carga resultados_alcanzados, logros,
// alertas, estado_reporte, reportado_por, etc. Si se reemplazara el arreglo
// de periodos tal cual llega, cualquier edicion general del indicador
// borraria lo que un productor ya hubiera reportado en esos campos. Por eso
// se combina cada periodo entrante con el existente (mismo nombre de
// periodo), y solo se sobreescriben los campos que realmente llegaron.
const mergePeriodos = (existingPeriodos, incomingPeriodos) => {
    if (!incomingPeriodos) return existingPeriodos;
    const existingByPeriodo = new Map(
        (existingPeriodos || []).map((p) => [p.periodo, p.toObject ? p.toObject() : p])
    );
    return incomingPeriodos.map((incoming) => {
        const existingPeriodo = existingByPeriodo.get(incoming.periodo) || {};
        return { ...existingPeriodo, ...incoming };
    });
};

ctrl.update = async (req, res) => {
    try {
        const body = { ...req.body };
        const existing = await Indicador.findById(req.params.id);
        if (!existing) return res.status(404).json({ error: 'No encontrado' });
        const incomingAccionId = getEntityId(body.accion_id);
        const existingAccionId = getEntityId(existing.accion_id);
        const shouldValidateCode = body.codigo !== undefined ||
            (body.accion_id !== undefined && incomingAccionId !== existingAccionId);

        if (shouldValidateCode) {
            const validated = await validateIndicatorPayload(body, { currentId: req.params.id, existing });
            body.codigo = validated.codigo;
            body.accion_id = validated.accionId;
        } else if (body.accion_id !== undefined) {
            body.accion_id = incomingAccionId || existingAccionId;
        }
        const periodos = mergePeriodos(existing.periodos, body.periodos);
        body.periodos = periodos;
        const tipo_calculo = body.tipo_calculo ?? existing.tipo_calculo;
        const meta_final = body.meta_final_2029 ?? existing.meta_final_2029;
        const calculados = calcularCamposDinamicos(periodos, tipo_calculo, meta_final);
        const doc = await Indicador.findByIdAndUpdate(req.params.id, { ...body, ...calculados }, { new: true, runValidators: true }).populate('accion_id', 'codigo nombre');
        await guardarHistorial(existing.toObject(), doc.toObject(), body.modificado_por ?? '');
        await recalcularAccion(doc.accion_id);
        res.json(withSemaforo(doc));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.updatePeriodo = async (req, res) => {
    try {
        const {
            periodo,
            meta,
            avance,
            presupuesto_ejecutado,
            resultados_alcanzados,
            logros,
            alertas,
            justificacion_retrasos,
            estado_reporte,
            reportado_por,
        } = req.body;

        if (!periodo) return res.status(400).json({ error: 'El campo periodo es requerido' });

        const doc = await Indicador.findById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        const antes = doc.toObject();

        const idx = doc.periodos.findIndex((p) => p.periodo === periodo);

        if (idx >= 0) {
            if (meta !== undefined) doc.periodos[idx].meta = meta;
            if (avance !== undefined) doc.periodos[idx].avance = avance;
            if (presupuesto_ejecutado !== undefined) doc.periodos[idx].presupuesto_ejecutado = presupuesto_ejecutado;
            if (resultados_alcanzados !== undefined) doc.periodos[idx].resultados_alcanzados = resultados_alcanzados;
            if (logros !== undefined) doc.periodos[idx].logros = logros;
            if (alertas !== undefined) doc.periodos[idx].alertas = alertas;
            if (justificacion_retrasos !== undefined) doc.periodos[idx].justificacion_retrasos = justificacion_retrasos;
            if (reportado_por !== undefined) doc.periodos[idx].reportado_por = reportado_por;
            if (estado_reporte !== undefined) {
                doc.periodos[idx].estado_reporte = estado_reporte;
                if (estado_reporte === 'Enviado' && !doc.periodos[idx].fecha_envio) {
                    doc.periodos[idx].fecha_envio = new Date();
                }
            }
        } else {
            doc.periodos.push({
                periodo,
                meta: meta ?? null,
                avance: avance ?? null,
                presupuesto_ejecutado: presupuesto_ejecutado ?? 0,
                resultados_alcanzados: resultados_alcanzados ?? '',
                logros: logros ?? '',
                alertas: alertas ?? '',
                justificacion_retrasos: justificacion_retrasos ?? '',
                estado_reporte: estado_reporte ?? 'Borrador',
                reportado_por: reportado_por ?? '',
                fecha_envio: estado_reporte === 'Enviado' ? new Date() : null,
            });
        }

        doc.markModified('periodos');
        const calculados = calcularCamposDinamicos(doc.periodos, doc.tipo_calculo, doc.meta_final_2029);
        Object.assign(doc, calculados);
        doc.markModified('avances_por_anio');
        await doc.save();
        await doc.populate('accion_id', 'codigo nombre');
        await guardarHistorial(antes, doc.toObject(), req.body.modificado_por ?? '');
        await recalcularAccion(doc.accion_id);
        res.json(withSemaforo(doc));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.remove = async (req, res) => {
    try {
        const doc = await Indicador.findByIdAndDelete(req.params.id);
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        for (const ev of doc.evidencias ?? []) {
            deleteFile(ev.filename);
            await deleteDriveFile(ev.drive_file_id);
        }
        await recalcularAccion(doc.accion_id);
        res.json({ message: 'Indicador eliminado' });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.uploadEvidencia = async (req, res) => {
    let uploaded = null;
    try {
        if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo PDF' });
        const doc = await Indicador.findById(req.params.id);
        if (!doc) {
            deleteFile(req.file.filename);
            return res.status(404).json({ error: 'Indicador no encontrado' });
        }

        const { jerarquia } = await getHierarchyForIndicador(doc);
        const buffer = await fs.readFile(req.file.path);
        uploaded = await uploadDriveFile(
            buffer,
            req.file.originalname,
            req.file.mimetype,
            jerarquia
        );
        deleteFile(req.file.filename);

        const evidencia = {
            nombre_original: req.file.originalname,
            filename: req.file.filename,
            url: uploaded.webViewLink || uploaded.webContentLink || buildUrl(req.file.filename),
            drive_file_id: uploaded.fileId,
            drive_web_view_link: uploaded.webViewLink || '',
            drive_web_content_link: uploaded.webContentLink || '',
            subido_por: req.body.subido_por ?? '',
            periodo: req.body.periodo ?? '',
            descripcion: req.body.descripcion ?? '',
        };

        doc.evidencias.push(evidencia);
        await doc.save();
        res.status(201).json(doc.evidencias[doc.evidencias.length - 1]);
    } catch (e) {
        if (req.file?.filename) deleteFile(req.file.filename);
        if (uploaded?.fileId) await deleteDriveFile(uploaded.fileId);
        res.status(500).json({ error: e.message });
    }
};

ctrl.uploadEvidencia = async (req, res) => {
    const files = req.files?.length ? req.files : (req.file ? [req.file] : []);
    const uploadedFiles = [];
    try {
        if (!files.length) return res.status(400).json({ error: 'No se recibio ningun archivo PDF' });
        const doc = await Indicador.findById(req.params.id);
        if (!doc) {
            files.forEach((file) => deleteFile(file.filename));
            return res.status(404).json({ error: 'Indicador no encontrado' });
        }

        const { jerarquia } = await getHierarchyForIndicador(doc);
        const evidencias = [];

        for (const file of files) {
            const buffer = await fs.readFile(file.path);
            const uploaded = await uploadDriveFile(
                buffer,
                file.originalname,
                file.mimetype,
                jerarquia
            );
            uploadedFiles.push(uploaded);
            deleteFile(file.filename);

            evidencias.push({
                nombre_original: file.originalname,
                filename: file.filename,
                url: uploaded.webViewLink || uploaded.webContentLink || buildUrl(file.filename),
                drive_file_id: uploaded.fileId,
                drive_web_view_link: uploaded.webViewLink || '',
                drive_web_content_link: uploaded.webContentLink || '',
                subido_por: req.body.subido_por ?? '',
                periodo: req.body.periodo ?? '',
                descripcion: req.body.descripcion ?? '',
            });
        }

        doc.evidencias.push(...evidencias);
        await doc.save();
        const created = doc.evidencias.slice(-evidencias.length);
        res.status(201).json(created.length === 1 ? created[0] : created);
    } catch (e) {
        files.forEach((file) => {
            if (file?.filename) deleteFile(file.filename);
        });
        for (const uploaded of uploadedFiles) {
            if (uploaded?.fileId) await deleteDriveFile(uploaded.fileId);
        }
        res.status(500).json({ error: e.message });
    }
};

ctrl.deleteEvidencia = async (req, res) => {
    try {
        const doc = await Indicador.findById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'Indicador no encontrado' });

        const ev = doc.evidencias.id(req.params.evidenciaId);
        if (!ev) return res.status(404).json({ error: 'Evidencia no encontrada' });

        deleteFile(ev.filename);
        await deleteDriveFile(ev.drive_file_id);
        ev.deleteOne();
        await doc.save();
        res.json({ message: 'Evidencia eliminada' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

ctrl.updateEvidenciaEstado = async (req, res) => {
    try {
        const { estado, comentario_revision } = req.body;
        const estadosValidos = ['En Revisión', 'Aprobado', 'Rechazado'];
        if (!estadosValidos.includes(estado)) {
            return res.status(400).json({ error: 'Estado inválido' });
        }
        const doc = await Indicador.findById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'Indicador no encontrado' });

        const ev = doc.evidencias.id(req.params.evidenciaId);
        if (!ev) return res.status(404).json({ error: 'Evidencia no encontrada' });

        ev.estado = estado;
        ev.comentario_revision = comentario_revision ?? '';
        await doc.save();

        // Enviar notificación cuando se aprueba o rechaza (no en "En Revisión")
        if (estado !== 'En Revisión') {
          try {
            const { sendIndicadorEvaluationNotification } = require('../services/pdiIndicadorUploadNotification');
            const User = require('../models/users');
            
            // Obtener email del usuario que subió la evidencia
            let emailProductor = null;
            let nombreProductor = ev.subido_por || 'Productor desconocido';
            
            if (ev.subido_por) {
              // Buscar usuario por nombre
              const usuario = await User.findOne({
                $or: [
                  { full_name: ev.subido_por },
                  { name: ev.subido_por }
                ]
              }).select('email full_name name').lean();
              
              if (usuario) {
                emailProductor = usuario.email;
                nombreProductor = usuario.full_name || usuario.name;
              }
            }
            
            // Si no encontramos email del productor, loguear y continuar (intentar enviar al responsable)
            if (!emailProductor) {
              console.warn(`[updateEvidenciaEstado] No se encontró email para productor: ${ev.subido_por}`);
            }
            
            // Preparar datos para la notificación con send_by completo
            const respuestaData = {
              respondido_por: emailProductor,
              send_by: {
                email: emailProductor,
                full_name: nombreProductor,
                name: nombreProductor
              },
              corte: doc.corte?.nombre || 'Sin especificar'
            };
            
            const formularioData = {
              nombre: 'Evidencia de Indicador'
            };

            const indicadorData = {
              codigo: doc.codigo,
              nombre: doc.nombre
            };

            console.log(`[updateEvidenciaEstado] Enviando notificación: email=${emailProductor}, estado=${estado}`);

            // Enviar al productor si tenemos su email
            if (emailProductor) {
              await sendIndicadorEvaluationNotification(
                respuestaData,
                formularioData,
                indicadorData,
                estado,
                comentario_revision || ''
              );
            }

            // Enviar al responsable del indicador si es rechazo
            if (estado === 'Rechazado' && doc.responsable) {
              console.log(`[updateEvidenciaEstado] Enviando notificación de rechazo al responsable: ${doc.responsable}`);
              
              await sendIndicadorEvaluationNotification(
                {
                  respondido_por: doc.responsable,
                  send_by: {
                    email: doc.responsable,
                    full_name: 'Responsable del Indicador',
                    name: 'Responsable del Indicador'
                  },
                  corte: doc.corte?.nombre || 'Sin especificar'
                },
                formularioData,
                indicadorData,
                estado,
                comentario_revision || ''
              );
              
              console.log(`[updateEvidenciaEstado] ✓ Notificación de rechazo enviada al responsable: ${doc.responsable}`);
            }

            // Enviar al admin cuando es aprobado
            if (estado === 'Aprobado') {
              console.log(`[updateEvidenciaEstado] Enviando notificación de aprobación a administradores...`);
              const User = require('../models/users');
              
              try {
                const admins = await User.find({ roles: 'Administrador' }).select('email full_name').lean();
                console.log(`[updateEvidenciaEstado] Administradores encontrados: ${admins ? admins.length : 0}`);
                
                if (admins && admins.length > 0) {
                  const adminEmails = admins.map(admin => admin.email).filter(Boolean);
                  console.log(`[updateEvidenciaEstado] Emails de administradores: ${adminEmails.join(', ')}`);
                  
                  if (adminEmails.length > 0) {
                    const { sendIndicadorUploadNotification } = require('../services/pdiIndicadorUploadNotification');
                    
                    // Enviar notificación especial al admin
                    const respuestaForAdmin = {
                      respondido_por: adminEmails[0],
                      send_by: {
                        email: adminEmails[0],
                        full_name: 'Administrador'
                      },
                      corte: doc.corte?.nombre || 'Sin especificar'
                    };
                    
                    // Usar la función de notificación a admin
                    const { sendIndicadorUploadNotification: sendToAdmin } = require('../services/pdiIndicadorUploadNotification');
                    
                    // Crear un transportador para enviar a múltiples admins
                    const nodemailer = require('nodemailer');
                    const { getEmailConfig } = require('../config/emailConfig');
                    const emailConfig = getEmailConfig('general');
                    
                    const transporter = nodemailer.createTransport({
                      host: emailConfig.host,
                      port: emailConfig.port,
                      secure: false,
                      auth: {
                        user: emailConfig.username,
                        pass: emailConfig.password
                      },
                      tls: { rejectUnauthorized: false }
                    });

                    const { buildEmailHtmlForAdmin } = require('../services/pdiIndicadorUploadNotification');
                    const emailHtml = buildEmailHtmlForAdmin(respuestaForAdmin, formularioData, indicadorData, 'Líder del Macroproyecto');
                    
                    await transporter.sendMail({
                      from: `"${emailConfig.fromName}" <${emailConfig.fromAddress}>`,
                      to: adminEmails.join(','),
                      subject: `[EVALUACIÓN] Indicador Aprobado: ${indicadorData.codigo}`,
                      html: emailHtml
                    });
                    
                    console.log(`[updateEvidenciaEstado] ✓ Notificación de aprobación enviada a administradores: ${adminEmails.join(', ')}`);
                  }
                } else {
                  console.warn(`[updateEvidenciaEstado] No se encontraron administradores`);
                }
              } catch (adminError) {
                console.error(`[updateEvidenciaEstado] Error enviando a administradores:`, adminError.message);
              }
            }
            
            console.log(`[updateEvidenciaEstado] ✓ Notificación enviada - Estado: ${estado}`);
          } catch (notifyError) {
            console.error('[updateEvidenciaEstado] Error al enviar notificación:', notifyError.message);
            // No fallar la solicitud principal por error en notificación
          }
        }

        res.json(ev);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

ctrl.getEvidencias = async (req, res) => {
    try {
        const doc = await Indicador.findById(req.params.id).select('evidencias');
        if (!doc) return res.status(404).json({ error: 'Indicador no encontrado' });
        res.json(doc.evidencias);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.recalcularTodos = async (req, res) => {
    try {
        const todos = await Indicador.find({});
        let count = 0;
        const accionIds = new Set();
        for (const doc of todos) {
            const calculados = calcularCamposDinamicos(doc.periodos, doc.tipo_calculo, doc.meta_final_2029);
            Object.assign(doc, calculados);
            doc.markModified('avances_por_anio');
            await doc.save();
            if (doc.accion_id) accionIds.add(String(doc.accion_id));
            count++;
        }

        for (const accionId of accionIds) {
            await recalcularAccion(accionId);
        }

        res.json({ message: `Recalculados ${count} indicadores y ${accionIds.size} acciones en cascada` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

module.exports = ctrl;
module.exports.recalcularAccion = recalcularAccion;
