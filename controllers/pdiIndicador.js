const Indicador = require('../models/pdiIndicador');
const { withSemaforo } = require('../helpers/pdiSemaforo');
const { recalcularProyecto } = require('./pdiAccionEstrategica');
const { deleteFile, buildUrl } = require('../services/pdiFileStorage');
const Historial = require('../models/pdiIndicadorHistorial');
const User = require('../models/users');

function withCalculatedFields(doc) {
    const base = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    return {
        ...base,
        ...calcularCamposDinamicos(base.periodos || [], base.tipo_calculo, base.meta_final_2029),
    };
}

function toNumberValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isNaN(value) ? null : value;
    const normalized = String(value).replace('%', '').replace(',', '.').trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isNaN(parsed) ? null : parsed;
}

function normalizePeso(peso) {
    const value = Number(peso) || 0;
    return value <= 1 ? value * 100 : value;
}

function clampPercentage(value) {
    return Math.min(Math.max(Number(value) || 0, 0), 100);
}

// Formula del Excel para indicadores tipo "promedio":
// MIN(SUMA(avances) / SUMA(metas), 1) * 100
function formulaExcel(lista) {
    const con = lista.filter((p) =>
        toNumberValue(p.avance) !== null &&
        toNumberValue(p.meta) !== null
    );
    if (!con.length) return null;
    const sumaMetas = con.reduce((acc, p) => acc + toNumberValue(p.meta), 0);
    const sumaAvances = con.reduce((acc, p) => acc + toNumberValue(p.avance), 0);
    if (sumaMetas === 0) return 0;
    return Math.round(Math.min(sumaAvances / sumaMetas, 1) * 100 * 100) / 100;
}

function ordenarPeriodos(lista = []) {
    return [...lista].sort((a, b) => String(a.periodo ?? '').localeCompare(String(b.periodo ?? '')));
}

function ultimoValor(lista) {
    const con = ordenarPeriodos(lista).filter((p) =>
        p.avance !== null && p.avance !== undefined &&
        p.avance !== '' && toNumberValue(p.avance) !== null
    );
    return con.length ? toNumberValue(con[con.length - 1].avance) : null;
}

function cumplimientoUltimoValor(lista) {
    const con = ordenarPeriodos(lista).filter((p) =>
        p.avance !== null && p.avance !== undefined &&
        p.avance !== '' && toNumberValue(p.avance) !== null
    );
    if (!con.length) return 0;

    const ultimo = con[con.length - 1];
    const avance = toNumberValue(ultimo.avance);
    const meta = toNumberValue(ultimo.meta);

    if (avance === null) return 0;
    if (meta !== null && meta > 0) {
        return Math.round(Math.min(avance / meta, 1) * 100 * 100) / 100;
    }

    return Math.round(Math.min(avance, 100) * 100) / 100;
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
        return cumplimientoUltimoValor(periodosOrdenados);
    }

    const porExcel = formulaExcel(periodosOrdenados);
    return porExcel !== null ? porExcel : 0;
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
  - avanceActual: suma acumulada o cumplimiento del ultimo valor, segun tipo_calculo
  - avance: % de avance total capado a 100
  - avance_total_real: % de avance total mostrado en la UI
  - avances_por_anio: % del avance reportado en cada anio frente a la meta de ese mismo anio
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
        const metaAnual = sumarMetas(periodosDelAnio);
        const avanceAnual = calcularAvanceAnual(periodosOrdenados, tipo_calculo, anio);
        avances_por_anio[anio] = tipo_calculo === 'ultimo_valor'
            ? Math.min(avanceAnual, 100)
            : (metaAnual > 0
                ? Math.round(Math.min(avanceAnual / metaAnual, 1) * 100 * 100) / 100
                : 0);
    }

    const avance = tipo_calculo === 'ultimo_valor'
        ? Math.min(avanceActual, 100)
        : (metaFinal > 0
            ? Math.round(Math.min(avanceActual / metaFinal, 1) * 100 * 100) / 100
            : 0);

    const avance_total_real = tipo_calculo === 'ultimo_valor'
        ? avance
        : (metaFinal > 0
            ? Math.round((avanceActual / metaFinal) * 100 * 100) / 100
            : null);

    return { avances_por_anio, avance, avance_total_real };
}

async function recalcularAccion(accion_id) {
    const AccionEstrategica = require('../models/pdiAccionEstrategica');
    const indicadores = await Indicador.find({ accion_id });
    if (!indicadores.length) return;

    // En Excel la accion suma la contribucion ponderada de los indicadores
    // usando el % de avance total capado (no el porcentaje real sin tope).
    const avance = Math.round(
        indicadores.reduce(
            (acc, indicador) => acc + (clampPercentage(indicador.avance) * normalizePeso(indicador.peso)),
            0
        ) / 100
    );

    const accion = await AccionEstrategica.findByIdAndUpdate(accion_id, { avance }, { new: true });
    if (accion) await recalcularProyecto(accion.proyecto_id);
}

const ctrl = {};

async function guardarHistorial(antes, despues, modificado_por = '') {
    try {
        const camposIgnorar = ['updatedAt', 'createdAt', '__v', 'avances_por_anio', 'avance', 'avance_total_real'];
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
        res.json(docs.map((doc) => withSemaforo(withCalculatedFields(doc))));
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.getById = async (req, res) => {
    try {
        const doc = await Indicador.findById(req.params.id).populate('accion_id', 'codigo nombre responsable responsable_email');
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        res.json(withSemaforo(withCalculatedFields(doc)));
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.create = async (req, res) => {
    try {
        const body = { ...req.body };
        const calculados = calcularCamposDinamicos(body.periodos || [], body.tipo_calculo, body.meta_final_2029);
        const doc = await Indicador.create({ ...body, ...calculados });
        await recalcularAccion(doc.accion_id);
        res.status(201).json(withSemaforo(doc));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

ctrl.update = async (req, res) => {
    try {
        const body = { ...req.body };
        const existing = await Indicador.findById(req.params.id);
        if (!existing) return res.status(404).json({ error: 'No encontrado' });
        const periodos = body.periodos ?? existing.periodos;
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
        for (const ev of doc.evidencias ?? []) deleteFile(ev.filename);
        await recalcularAccion(doc.accion_id);
        res.json({ message: 'Indicador eliminado' });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.uploadEvidencia = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo PDF' });
        const doc = await Indicador.findById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'Indicador no encontrado' });

        const evidencia = {
            nombre_original: req.file.originalname,
            filename: req.file.filename,
            url: buildUrl(req.file.filename),
            subido_por: req.body.subido_por ?? '',
            periodo: req.body.periodo ?? '',
            descripcion: req.body.descripcion ?? '',
        };

        doc.evidencias.push(evidencia);
        await doc.save();
        res.status(201).json(doc.evidencias[doc.evidencias.length - 1]);
    } catch (e) {
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
