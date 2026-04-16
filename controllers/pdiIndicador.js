const Indicador         = require('../models/pdiIndicador');
const { withSemaforo }  = require('../helpers/pdiSemaforo');
const { recalcularProyecto } = require('./pdiAccionEstrategica');
const { deleteFile, buildUrl } = require('../services/pdiFileStorage');
const Historial         = require('../models/pdiIndicadorHistorial');

async function recalcularAccion(accion_id) {
    const AccionEstrategica = require('../models/pdiAccionEstrategica');
    const indicadores = await Indicador.find({ accion_id });
    if (!indicadores.length) return;

    const avanceEfectivo = (i) => i.avance_total_real != null ? i.avance_total_real : i.avance;
    const totalPeso = indicadores.reduce((acc, i) => acc + i.peso, 0);
    const avance = totalPeso > 0
        ? Math.round(indicadores.reduce((acc, i) => acc + (avanceEfectivo(i) * i.peso), 0) / totalPeso)
        : 0;

    const accion = await AccionEstrategica.findByIdAndUpdate(accion_id, { avance }, { new: true });
    if (accion) await recalcularProyecto(accion.proyecto_id);
}

// Fórmula Excel: MIN(SUMA(avances) / SUMA(metas), 1) * 100
// Si suma de metas = 0 devuelve 0. Resultado en porcentaje (0-100).
function formulaExcel(lista) {
    const con = lista.filter(p =>
        p.avance !== null && p.avance !== undefined && !isNaN(Number(p.avance)) &&
        p.meta   !== null && p.meta   !== undefined && !isNaN(Number(p.meta))
    );
    if (!con.length) return null;
    const sumaMetas   = con.reduce((acc, p) => acc + Number(p.meta),   0);
    const sumaAvances = con.reduce((acc, p) => acc + Number(p.avance), 0);
    if (sumaMetas === 0) return 0;
    return Math.round(Math.min(sumaAvances / sumaMetas, 1) * 100 * 100) / 100;
}

// Último valor registrado (excluye null, undefined y 0 — 0 indica "sin registrar")
function ultimoValor(lista) {
    const con = lista.filter(p =>
        p.avance !== null && p.avance !== undefined &&
        !isNaN(Number(p.avance)) && Number(p.avance) !== 0
    );
    return con.length ? Number(con[con.length - 1].avance) : null;
}

// Suma acumulada de avances
function acumular(lista) {
    const con = lista.filter(p => p.avance !== null && p.avance !== undefined && !isNaN(Number(p.avance)));
    if (!con.length) return null;
    return Math.round(con.reduce((acc, p) => acc + Number(p.avance), 0) * 100) / 100;
}

/*
  Calcula todos los campos derivados del indicador a partir de sus periodos:
  - avances_por_anio: fórmula Excel MIN(SUMA(avances)/SUMA(metas), 1)*100 por año
  - avance (% avance total): según tipo_calculo sobre todos los periodos
  - avance_total_real: (avance / meta_final_2029) * 100 si existe meta
  Los años se detectan dinámicamente desde los periodos registrados.
*/
function calcularCamposDinamicos(periodos, tipo_calculo, meta_final_2029) {
    // Agrupar por año
    const porAnio = {};
    for (const p of periodos) {
        const anio = p.periodo.slice(0, 4);
        if (!porAnio[anio]) porAnio[anio] = [];
        porAnio[anio].push(p);
    }

    // avances_por_anio: fórmula Excel si metas numéricas, sino último valor del año
    const avances_por_anio = {};
    for (const [anio, lista] of Object.entries(porAnio)) {
        const val = formulaExcel(lista) ?? ultimoValor(lista);
        if (val !== null) avances_por_anio[anio] = val;
    }

    // avance total según tipo_calculo
    let avanceTotal = 0;
    if (tipo_calculo === 'acumulado') {
        avanceTotal = acumular(periodos) ?? 0;
    } else if (tipo_calculo === 'ultimo_valor') {
        avanceTotal = ultimoValor(periodos) ?? 0;
    } else {
        // 'promedio' → fórmula Excel; si metas no son numéricas, usar último valor registrado
        const porExcel = formulaExcel(periodos);
        avanceTotal = porExcel !== null ? porExcel : (ultimoValor(periodos) ?? 0);
    }

    const meta_num = typeof meta_final_2029 === 'number' ? meta_final_2029
        : !isNaN(Number(meta_final_2029)) && meta_final_2029 !== null && meta_final_2029 !== ''
            ? Number(meta_final_2029) : null;

    const avance_total_real = (meta_num && avanceTotal !== null)
        ? Math.round((avanceTotal / meta_num) * 100)
        : null;

    return { avances_por_anio, avance: avanceTotal, avance_total_real };
}

const ctrl = {};

// Guarda un snapshot antes/después en el historial
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

        await Historial.create({
            indicador_id:     antes._id,
            indicador_codigo: antes.codigo,
            indicador_nombre: antes.nombre,
            modificado_por,
            antes:   JSON.parse(JSON.stringify(antes)),
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
        res.json(docs.map(withSemaforo));
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.getById = async (req, res) => {
    try {
        const doc = await Indicador.findById(req.params.id).populate('accion_id', 'codigo nombre responsable responsable_email');
        if (!doc) return res.status(404).json({ error: 'No encontrado' });
        res.json(withSemaforo(doc));
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
        const periodos      = body.periodos      ?? existing.periodos;
        const tipo_calculo  = body.tipo_calculo  ?? existing.tipo_calculo;
        const meta_final    = body.meta_final_2029 ?? existing.meta_final_2029;
        const calculados = calcularCamposDinamicos(periodos, tipo_calculo, meta_final);
        const doc = await Indicador.findByIdAndUpdate(req.params.id, { ...body, ...calculados }, { new: true, runValidators: true }).populate('accion_id', 'codigo nombre');
        await guardarHistorial(existing.toObject(), doc.toObject(), body.modificado_por ?? '');
        await recalcularAccion(doc.accion_id);
        res.json(withSemaforo(doc));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

// PATCH para registrar o actualizar un periodo semestral específico
// Acepta campos cuantitativos (meta, avance) y cualitativos
// (resultados_alcanzados, logros, alertas, justificacion_retrasos, estado_reporte)
ctrl.updatePeriodo = async (req, res) => {
    try {
        const {
            periodo,
            meta,
            avance,
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

        const idx = doc.periodos.findIndex(p => p.periodo === periodo);

        if (idx >= 0) {
            // Actualizar campos cuantitativos
            if (meta   !== undefined) doc.periodos[idx].meta   = meta;
            if (avance !== undefined) doc.periodos[idx].avance = avance;
            // Actualizar campos cualitativos
            if (resultados_alcanzados !== undefined) doc.periodos[idx].resultados_alcanzados = resultados_alcanzados;
            if (logros                !== undefined) doc.periodos[idx].logros                = logros;
            if (alertas               !== undefined) doc.periodos[idx].alertas               = alertas;
            if (justificacion_retrasos !== undefined) doc.periodos[idx].justificacion_retrasos = justificacion_retrasos;
            if (reportado_por         !== undefined) doc.periodos[idx].reportado_por         = reportado_por;
            // Al enviar el reporte marcar fecha_envio
            if (estado_reporte !== undefined) {
                doc.periodos[idx].estado_reporte = estado_reporte;
                if (estado_reporte === 'Enviado' && !doc.periodos[idx].fecha_envio) {
                    doc.periodos[idx].fecha_envio = new Date();
                }
            }
        } else {
            doc.periodos.push({
                periodo,
                meta:                   meta   ?? null,
                avance:                 avance ?? null,
                resultados_alcanzados:  resultados_alcanzados  ?? '',
                logros:                 logros                 ?? '',
                alertas:                alertas                ?? '',
                justificacion_retrasos: justificacion_retrasos ?? '',
                estado_reporte:         estado_reporte         ?? 'Borrador',
                reportado_por:          reportado_por          ?? '',
                fecha_envio:            estado_reporte === 'Enviado' ? new Date() : null,
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
        // Eliminar archivos del disco al borrar el indicador
        for (const ev of doc.evidencias ?? []) deleteFile(ev.filename);
        await recalcularAccion(doc.accion_id);
        res.json({ message: 'Indicador eliminado' });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

// ── Evidencias ─────────────────────────────────────────────────────────────

ctrl.uploadEvidencia = async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo PDF' });
        const doc = await Indicador.findById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'Indicador no encontrado' });

        const evidencia = {
            nombre_original: req.file.originalname,
            filename:        req.file.filename,
            url:             buildUrl(req.file.filename),
            subido_por:      req.body.subido_por  ?? '',
            periodo:         req.body.periodo     ?? '',
            descripcion:     req.body.descripcion ?? '',
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

// Recalcula avances_por_anio y avance_total_real en todos los indicadores existentes
ctrl.recalcularTodos = async (req, res) => {
    try {
        const todos = await Indicador.find({});
        let count = 0;
        for (const doc of todos) {
            const calculados = calcularCamposDinamicos(doc.periodos, doc.tipo_calculo, doc.meta_final_2029);
            Object.assign(doc, calculados);
            doc.markModified('avances_por_anio');
            await doc.save();
            count++;
        }
        res.json({ message: `Recalculados ${count} indicadores` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

module.exports = ctrl;
