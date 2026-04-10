const Indicador         = require('../models/pdiIndicador');
const { withSemaforo }  = require('../helpers/pdiSemaforo');
const { recalcularProyecto } = require('./pdiAccionEstrategica');
const { deleteFile, buildUrl } = require('../services/pdiFileStorage');

async function recalcularAccion(accion_id) {
    const AccionEstrategica = require('../models/pdiAccionEstrategica');
    const indicadores = await Indicador.find({ accion_id });
    if (!indicadores.length) return;

    const totalPeso = indicadores.reduce((acc, i) => acc + i.peso, 0);
    const avance = totalPeso > 0
        ? Math.round(indicadores.reduce((acc, i) => acc + (i.avance * i.peso), 0) / totalPeso)
        : 0;

    const accion = await AccionEstrategica.findByIdAndUpdate(accion_id, { avance }, { new: true });
    if (accion) await recalcularProyecto(accion.proyecto_id);
}

// Promedia los avances de un array de periodos que tengan avance registrado
function promediarAvances(lista) {
    const con = lista.filter(p => p.avance !== null && p.avance !== undefined && !isNaN(Number(p.avance)));
    if (!con.length) return null;
    return Math.round(con.reduce((acc, p) => acc + Number(p.avance), 0) / con.length * 100) / 100;
}

// Último valor registrado (orden tal como vienen los periodos)
function ultimoValor(lista) {
    const con = lista.filter(p => p.avance !== null && p.avance !== undefined && !isNaN(Number(p.avance)));
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
  - avance_YYYY: promedio de los dos semestres de ese año (A y B)
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

    const avances_por_anio = {};
    for (const [anio, lista] of Object.entries(porAnio)) {
        const val = promediarAvances(lista);
        if (val !== null) avances_por_anio[anio] = val;
    }

    let avanceTotal = 0;
    if (tipo_calculo === 'acumulado')         avanceTotal = acumular(periodos)         ?? 0;
    else if (tipo_calculo === 'ultimo_valor') avanceTotal = ultimoValor(periodos)      ?? 0;
    else                                      avanceTotal = promediarAvances(periodos) ?? 0;

    const meta_num = typeof meta_final_2029 === 'number' ? meta_final_2029
        : !isNaN(Number(meta_final_2029)) && meta_final_2029 !== null && meta_final_2029 !== ''
            ? Number(meta_final_2029) : null;

    const avance_total_real = (meta_num && avanceTotal !== null)
        ? Math.round((avanceTotal / meta_num) * 100)
        : null;

    return { avances_por_anio, avance: avanceTotal, avance_total_real };
}

const ctrl = {};

ctrl.getAll = async (req, res) => {
    try {
        const query = {};
        if (req.query.accion_id) query.accion_id = req.query.accion_id;
        const docs = await Indicador.find(query).populate('accion_id', 'codigo nombre').sort({ codigo: 1 });
        res.json(docs.map(withSemaforo));
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

ctrl.getById = async (req, res) => {
    try {
        const doc = await Indicador.findById(req.params.id).populate('accion_id', 'codigo nombre');
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
        const doc = await Indicador.findByIdAndUpdate(req.params.id, { ...body, ...calculados }, { new: true, runValidators: true });
        await recalcularAccion(doc.accion_id);
        res.json(withSemaforo(doc));
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

// PATCH para registrar o actualizar un periodo semestral específico
ctrl.updatePeriodo = async (req, res) => {
    try {
        const { periodo, meta, avance } = req.body;
        const doc = await Indicador.findById(req.params.id);
        if (!doc) return res.status(404).json({ error: 'No encontrado' });

        const idx = doc.periodos.findIndex(p => p.periodo === periodo);
        if (idx >= 0) {
            if (meta   !== undefined) doc.periodos[idx].meta   = meta;
            if (avance !== undefined) doc.periodos[idx].avance = avance;
        } else {
            doc.periodos.push({ periodo, meta: meta ?? null, avance: avance ?? null });
        }

        const calculados = calcularCamposDinamicos(doc.periodos, doc.tipo_calculo, doc.meta_final_2029);
        Object.assign(doc, calculados);
        await doc.save();
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

ctrl.getEvidencias = async (req, res) => {
    try {
        const doc = await Indicador.findById(req.params.id).select('evidencias');
        if (!doc) return res.status(404).json({ error: 'Indicador no encontrado' });
        res.json(doc.evidencias);
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

module.exports = ctrl;
