const Process        = require('../models/processes');
const Phase          = require('../models/phases');
const ProcessDoc     = require('../models/processDocuments');
const Program        = require('../models/programs');
const ProcessHistory = require('../models/processHistory');
const Caso           = require('../models/casos');
const { calcularFechas } = require('./processes');
const { crearPMAutomatico } = require('../helpers/pmAutoCreate');
const { uploadFileToGoogleDrive, deleteDriveFile } = require('../config/googleDrive');

const processHistoryController = {};

/** Solo archivo en historial: RC vigente anterior mientras llega RC de oficio; no cuenta en total_rc ni es gestionable. */
const SUBTIPO_RC_VIGENCIA_TRANSITORIA = 'Vigencia transitoria';

async function countRcHistorialContable(programCode) {
  return ProcessHistory.countDocuments({
    program_code: programCode,
    tipo_proceso: 'RC',
    subtipo: { $ne: SUBTIPO_RC_VIGENCIA_TRANSITORIA },
  });
}

/** Caso «Acto administrativo MEN»: mismo PDF que suele subirse al cierre; no duplicar en historial. */
const CASO_DATE_KEYS_DUPLICAN_PDF_CIERRE = new Set(['fecha_resolucion']);

/** PDF del acto administrativo MEN (información del caso, fase 5). */
async function findDocActoAdminMenCaso(processId) {
  return ProcessDoc.findOne({
    process_id: processId,
    doc_type: 'proceso',
    caso_date_key: 'fecha_resolucion',
  })
    .sort({ createdAt: -1 })
    .lean();
}

/** PDF de cierre: borrador, legacy o acto admin MEN si ya se subió en el caso. */
async function findDocResolucionParaCierre(processId) {
  const cierre = await ProcessDoc.findOne({ process_id: processId, doc_type: 'resolucion_cierre' })
    .sort({ createdAt: -1 })
    .lean();
  if (cierre) return cierre;
  const legacy = await ProcessDoc.findOne({ process_id: processId, doc_type: 'resolucion' }).lean();
  if (legacy) return legacy;
  return findDocActoAdminMenCaso(processId);
}

/** Al cerrar aprobado: un solo PDF de resolución en el proceso antes de mover docs a ALERTA. */
async function promoverResolucionCierreSiExiste(processId) {
  const todosCierre = await ProcessDoc.find({ process_id: processId, doc_type: 'resolucion_cierre' })
    .sort({ createdAt: -1 });
  if (todosCierre.length) {
    const docCierre = todosCierre[0];
    await ProcessDoc.deleteMany({ process_id: processId, doc_type: 'resolucion' });
    await ProcessDoc.findByIdAndUpdate(docCierre._id, {
      $set: { doc_type: 'resolucion', caso_date_key: null },
    });
    if (todosCierre.length > 1) {
      await ProcessDoc.deleteMany({
        _id: { $in: todosCierre.slice(1).map((d) => d._id) },
      });
    }
    return;
  }
  const acto = await ProcessDoc.findOne({
    process_id: processId,
    doc_type: 'proceso',
    caso_date_key: 'fecha_resolucion',
  });
  if (!acto) return;
  await ProcessDoc.deleteMany({ process_id: processId, doc_type: 'resolucion' });
  await ProcessDoc.findByIdAndUpdate(acto._id, {
    $set: { doc_type: 'resolucion', caso_date_key: null },
  });
}

function docCasoDuplicaPdfCierre(d) {
  return d.doc_type === 'proceso'
    && d.caso_date_key
    && CASO_DATE_KEYS_DUPLICAN_PDF_CIERRE.has(String(d.caso_date_key));
}

const CASO_DATE_KEYS_SNAPSHOT = [
  'fecha_solicitud_radicado',
  'fecha_notificacion_completitud',
  'fecha_respuesta_completitud',
  'fecha_resolucion',
  'fecha_resolucion_apelacion',
  'fecha_respuesta_men',
];

const {
  findActividadByCasoKey,
  findSubactividadByCasoKey,
  dedupeDocs,
} = require('../helpers/casoActividadMap');

function obsConFallback(casoObs, actObs) {
  const t = String(casoObs ?? '').trim();
  if (t) return t;
  return String(actObs ?? '').trim();
}

/** Información del caso + documentos por fecha al archivar (incluye docs/obs de actividades vinculadas). */
async function buildCasoSnapshot(processId, mapDoc, fasesSnapshot = []) {
  const caso = await Caso.findOne({ proceso_id: processId }).lean();
  if (!caso) return null;

  const casoDocs = await ProcessDoc.find({
    process_id: processId,
    caso_date_key: { $in: CASO_DATE_KEYS_SNAPSHOT },
  }).lean();

  const documentos_por_fecha = {};
  for (const d of casoDocs) {
    const k = String(d.caso_date_key ?? '');
    if (!k) continue;
    if (!documentos_por_fecha[k]) documentos_por_fecha[k] = [];
    documentos_por_fecha[k].push(mapDoc(d));
  }

  for (const key of CASO_DATE_KEYS_SNAPSHOT) {
    const hitA = findActividadByCasoKey(fasesSnapshot, key);
    const hitS = !hitA ? findSubactividadByCasoKey(fasesSnapshot, key) : null;
    const docsAct = hitA
      ? (hitA.act.documentos ?? [])
      : hitS
        ? (hitS.sub.documentos ?? [])
        : [];
    if (docsAct.length > 0) {
      documentos_por_fecha[key] = dedupeDocs([
        ...(documentos_por_fecha[key] ?? []),
        ...docsAct,
      ]);
    }
  }

  const obsAct = (key) => {
    const hitA = findActividadByCasoKey(fasesSnapshot, key);
    if (hitA) return hitA.act.observaciones ?? '';
    const hitS = findSubactividadByCasoKey(fasesSnapshot, key);
    if (hitS) return hitS.sub.observaciones ?? '';
    return '';
  };

  return {
    codigo_caso:                    caso.codigo_caso ?? null,
    fecha_solicitud_radicado:       caso.fecha_solicitud_radicado ?? null,
    fecha_notificacion_completitud: caso.fecha_notificacion_completitud ?? null,
    fecha_respuesta_completitud:    caso.fecha_respuesta_completitud ?? null,
    fecha_resolucion:               caso.fecha_resolucion ?? null,
    resolucion_aprobada:            caso.resolucion_aprobada ?? null,
    aplica_apelacion:               caso.aplica_apelacion ?? false,
    fecha_resolucion_apelacion:     caso.fecha_resolucion_apelacion ?? null,
    fecha_respuesta_men:            caso.fecha_respuesta_men ?? null,
    obs_fecha_solicitud_radicado: obsConFallback(caso.obs_fecha_solicitud_radicado, obsAct('fecha_solicitud_radicado')),
    obs_fecha_notificacion_completitud: obsConFallback(caso.obs_fecha_notificacion_completitud, obsAct('fecha_notificacion_completitud')),
    obs_fecha_respuesta_completitud: obsConFallback(caso.obs_fecha_respuesta_completitud, obsAct('fecha_respuesta_completitud')),
    obs_fecha_resolucion: obsConFallback(caso.obs_fecha_resolucion, obsAct('fecha_resolucion')),
    obs_fecha_resolucion_apelacion: obsConFallback(caso.obs_fecha_resolucion_apelacion, obsAct('fecha_resolucion_apelacion')),
    obs_fecha_respuesta_men: obsConFallback(caso.obs_fecha_respuesta_men, obsAct('fecha_respuesta_men')),
    documentos_por_fecha,
  };
}

function normFecha(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().split('T')[0];
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

/* ─────────────────────────────────────────────────────────────────────────
   closePM — cierra un proceso PM y liga su historial al padre (AV o AE).
   ───────────────────────────────────────────────────────────────────────── */
async function closePM(proc, program, req, res) {
  try {
    const mapDoc = d => ({
      _id:           d._id,
      name:          d.name,
      drive_id:      d.drive_id,
      view_link:     d.view_link,
      download_link: d.download_link,
      mime_type:     d.mime_type ?? null,
      size:          d.size ?? null,
      subido_en:     d.createdAt ?? null,
    });

    // 1 — Snapshot de fases del PM
    const fasesPM = await Phase.find({ proceso_id: proc._id }).sort({ numero: 1 });
    const fasesSnapshot = await Promise.all(
      fasesPM.map(async (f) => {
        const faseDocs = await ProcessDoc.find({ phase_id: f._id, actividad_id: null }).lean();
        const actividadesArr = Array.isArray(f.actividades) ? f.actividades : [];
        const actividadesSnapshot = await Promise.all(
          actividadesArr.map(async (act) => {
            const actDocs = await ProcessDoc.find({ phase_id: f._id, actividad_id: act._id, subactividad_id: null }).lean();
            const subsArr = Array.isArray(act.subactividades) ? act.subactividades : [];
            const subactividades = await Promise.all(
              subsArr.map(async (sub) => {
                const subDocs = await ProcessDoc.find({ phase_id: f._id, actividad_id: act._id, subactividad_id: sub._id }).lean();
                return { nombre: sub.nombre, completada: sub.completada, no_aplica: !!sub.no_aplica, fecha_completado: sub.fecha_completado ?? null, observaciones: sub.observaciones ?? '', documentos: subDocs.map(mapDoc) };
              })
            );
            return { nombre: act.nombre, responsables: act.responsables ?? '', completada: act.completada, no_aplica: !!act.no_aplica, fecha_completado: act.fecha_completado ?? null, observaciones: act.observaciones ?? '', documentos: actDocs.map(mapDoc), subactividades };
          })
        );
        const actividadResueltaHist = (a) => !!a.completada || !!a.no_aplica;
        return { fase_numero: f.numero, fase_nombre: f.nombre, actividades_completadas: actividadesArr.filter(actividadResueltaHist).length, actividades_total: actividadesArr.length, documentos: faseDocs.map(mapDoc), actividades: actividadesSnapshot };
      })
    );

    // 2 — Docs directos del PM (no de fases)
    const docsDirectos = await ProcessDoc.find({ process_id: proc._id, phase_id: null }).lean();
    const docsDirectosSnapshot = docsDirectos.map(mapDoc);

    // 3 — Buscar el historial del padre (AV o AE) que tiene pm_proceso_id = proc._id
    const historialPadre = await ProcessHistory.findOne({ pm_proceso_id: proc._id });

    // 4 — Crear historial del PM con vínculo al padre
    const nombreProcesoHist = (proc.name && String(proc.name).trim())
      ? String(proc.name).trim()
      : `PM — ${program.nombre || proc.program_code}`;

    const casoSnapshotPm = await buildCasoSnapshot(proc._id, mapDoc, fasesSnapshot);

    const pmHistory = await ProcessHistory.create({
      program_code:      proc.program_code,
      dep_code_facultad: program.dep_code_facultad,
      nombre_programa:   program.nombre || proc.program_code,
      process_id:        proc._id,
      tipo_proceso:      'PM',
      nombre_proceso:    nombreProcesoHist,
      subtipo:           proc.subtipo ?? null,
      fecha_envio_pm_vicerrectoria:     proc.fecha_envio_pm_vicerrectoria ?? null,
      fecha_entrega_pm_cna:             proc.fecha_entrega_pm_cna ?? null,
      fecha_envio_avance_vicerrectoria: proc.fecha_envio_avance_vicerrectoria ?? null,
      fecha_radicacion_avance_cna:      proc.fecha_radicacion_avance_cna ?? null,
      obs_envio_pm_vicerrectoria:     proc.obs_envio_pm_vicerrectoria ?? '',
      obs_entrega_pm_cna:             proc.obs_entrega_pm_cna ?? '',
      obs_envio_avance_vicerrectoria: proc.obs_envio_avance_vicerrectoria ?? '',
      obs_radicacion_avance_cna:      proc.obs_radicacion_avance_cna ?? '',
      caso_snapshot: casoSnapshotPm,
      fase_al_cierre:    proc.fase_actual,
      observaciones:     proc.observaciones ?? '',
      fases:             fasesSnapshot,
      documentos_proceso:docsDirectosSnapshot,
      cerrado_por:       req.body?.cerrado_por ?? null,
      estado_solicitud:  'APROBADO',
      parent_history_id: historialPadre?._id ?? null,
    });

    // 5 — Actualizar historial del padre: pm_history_id + limpiar pm_proceso_id
    if (historialPadre) {
      await ProcessHistory.findByIdAndUpdate(historialPadre._id, {
        pm_history_id: pmHistory._id,
        pm_proceso_id: null,
      });
    }

    // 6 — Limpiar fases y docs del PM
    const faseIds = fasesPM.map(f => f._id);
    await ProcessDoc.deleteMany({ phase_id: { $in: faseIds } });
    await ProcessDoc.deleteMany({ process_id: proc._id });
    await Phase.deleteMany({ proceso_id: proc._id });

    // 7 — Eliminar la ALERTA ligada al PM (si existe)
    await Process.deleteMany({
      tipo_proceso:     'ALERTA',
      alert_para_tipo:  'PM',
      parent_process_id: proc._id,
    });

    // 8 — Eliminar el proceso PM
    await Process.findByIdAndDelete(proc._id);

    res.status(200).json({ message: 'Plan de Mejoramiento cerrado y archivado correctamente' });
  } catch (error) {
    console.error('Error cerrando PM:', error);
    res.status(500).json({ error: 'Error al cerrar el PM', detalle: error?.message || 'Error interno' });
  }
}

const SUBTIPOS_REFORMA_CLOSE = ['Reforma curricular', 'Renovación + reforma'];

function normalizarSubtipoStr(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

function subtipoEsReformaCierre(raw) {
  const n = normalizarSubtipoStr(raw);
  return SUBTIPOS_REFORMA_CLOSE.some((x) => n.toLowerCase() === x.toLowerCase());
}

/** Reforma curricular sin renovación: sin ALERTA poscierre. Tolerante a mayúsculas/espacios; si `subtipo` quedó vacío en BD, respaldo por `name` del formato de alta en la app. */
function esRcReformaCurricularSoloProc(proc) {
  if (proc.tipo_proceso !== 'RC') return false;
  const n = normalizarSubtipoStr(proc.subtipo);
  if (n.toLowerCase() === 'reforma curricular') return true;
  if (n === '' && /\(\s*Reforma\s+curricular\s*\)/i.test(String(proc.name ?? ''))) return true;
  return false;
}

/** Clave de subtipo sin tildes (p. ej. «no renovacion») para reglas de ficha (Inactivo, etc.). */
function subtipoClaveSinDiacriticos(raw) {
  return normalizarSubtipoStr(raw)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** RC trámite de no renovación (cierre con fecha + documento de respuesta; no resolución MEN con código/vigencia). */
function esRcNoRenovacionProc(proc) {
  return proc.tipo_proceso === 'RC' && subtipoClaveSinDiacriticos(proc.subtipo) === 'no renovacion';
}

function mergeTxtReforma(v) {
  if (v === '' || v === undefined || v === null) return null;
  return String(v);
}

function valEqReforma(a, b) {
  const na = a === null || a === undefined ? '' : String(a).trim();
  const nb = b === null || b === undefined ? '' : String(b).trim();
  if (na === '' && nb === '') return true;
  const ca = na !== '' && !Number.isNaN(Number(na));
  const cb = nb !== '' && !Number.isNaN(Number(nb));
  if (ca && cb) return Number(na) === Number(nb);
  return na === nb;
}

function dedupeDocumentosParaHistorial(docs, mapDoc) {
  const seen = new Set();
  const out = [];
  for (const d of docs) {
    const link = d.view_link != null ? String(d.view_link).trim() : '';
    const id = d._id != null ? String(d._id) : '';
    const key = id || link || `${String(d.name ?? '')}|${String(d.drive_id ?? '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mapDoc(d));
  }
  return out;
}

/** Diff ficha vs payload de cierre (historial; respaldo si el cliente no manda bien el diff). */
function computeProgramaCambiosReforma(programDoc, pr) {
  const LABELS = {
    dep_code_programa: 'Código del programa',
    nombre: 'Nombre del programa',
    codigo_snies: 'Código SNIES',
    modalidad: 'Modalidad',
    nivel_academico: 'Nivel académico',
    nivel_formacion: 'Nivel de formación',
    num_creditos: 'N° de créditos',
    num_semestres: 'N° de semestres',
    admision_estudiantes: 'Admisión de estudiantes',
    num_estudiantes_saces: 'N° estudiantes SACES',
  };
  const LABELS_CINE = {
    campo_amplio: 'CINE F — Campo amplio',
    campo_especifico: 'CINE F — Campo específico',
    campo_detallado: 'CINE F — Campo detallado',
  };
  const LABELS_NBC = {
    area_conocimiento: 'NBC — Área de conocimiento',
    nbc: 'NBC — Núcleo básico del conocimiento',
  };
  const campos = ['dep_code_programa', 'nombre', 'codigo_snies', 'modalidad', 'nivel_academico', 'nivel_formacion',
    'num_creditos', 'num_semestres', 'admision_estudiantes', 'num_estudiantes_saces'];
  const out = [];
  const p = programDoc.toObject ? programDoc.toObject() : programDoc;
  for (const k of campos) {
    if (!Object.prototype.hasOwnProperty.call(pr, k)) continue;
    const antes = p[k];
    const despues = pr[k];
    if (valEqReforma(antes ?? null, despues ?? null)) continue;
    out.push({
      campo: k,
      label: LABELS[k] || k,
      antes: antes ?? null,
      despues: despues ?? null,
    });
  }
  if (pr.cine_f && typeof pr.cine_f === 'object') {
    for (const ck of ['campo_amplio', 'campo_especifico', 'campo_detallado']) {
      if (!Object.prototype.hasOwnProperty.call(pr.cine_f, ck)) continue;
      const antes = p.cine_f?.[ck] ?? null;
      const despues = mergeTxtReforma(pr.cine_f[ck]);
      if (valEqReforma(antes, despues)) continue;
      out.push({
        campo: `cine_f.${ck}`,
        label: LABELS_CINE[ck],
        antes: antes ?? null,
        despues,
      });
    }
  }
  if (pr.nbc && typeof pr.nbc === 'object') {
    for (const nk of ['area_conocimiento', 'nbc']) {
      if (!Object.prototype.hasOwnProperty.call(pr.nbc, nk)) continue;
      const antes = p.nbc?.[nk] ?? null;
      const despues = mergeTxtReforma(pr.nbc[nk]);
      if (valEqReforma(antes, despues)) continue;
      out.push({
        campo: `nbc.${nk}`,
        label: LABELS_NBC[nk],
        antes: antes ?? null,
        despues,
      });
    }
  }
  return out;
}

async function aplicarNuevosValoresProgramaReforma(programDoc, pr) {
  const mergeTxt = mergeTxtReforma;

  /** Código institucional: solo valida unicidad en ficha; procesos siguen ligados por `_id` del programa. */
  if (Object.prototype.hasOwnProperty.call(pr, 'dep_code_programa')) {
    const trimmed = String(pr.dep_code_programa ?? '').trim();
    if (trimmed) {
      const dupe = await Program.findOne({
        dep_code_programa: trimmed,
        _id: { $ne: programDoc._id },
      }).select('_id').lean();
      if (dupe) {
        const err = new Error('Ese código de programa ya está en uso.');
        err.statusCode = 409;
        throw err;
      }
    }
  }

  const camposPermitidos = ['dep_code_programa', 'nombre', 'codigo_snies', 'modalidad', 'nivel_academico', 'nivel_formacion',
    'num_creditos', 'num_semestres', 'admision_estudiantes', 'num_estudiantes_saces'];
  const update = {};
  for (const campo of camposPermitidos) {
    if (Object.prototype.hasOwnProperty.call(pr, campo)) {
      update[campo] = campo === 'dep_code_programa' ? mergeTxt(pr[campo]) : pr[campo];
    }
  }
  if (pr.cine_f && typeof pr.cine_f === 'object') {
    const prev = {
      campo_amplio: programDoc.cine_f?.campo_amplio ?? null,
      campo_especifico: programDoc.cine_f?.campo_especifico ?? null,
      campo_detallado: programDoc.cine_f?.campo_detallado ?? null,
    };
    for (const k of ['campo_amplio', 'campo_especifico', 'campo_detallado']) {
      if (Object.prototype.hasOwnProperty.call(pr.cine_f, k)) {
        prev[k] = mergeTxt(pr.cine_f[k]);
      }
    }
    update.cine_f = prev;
  }
  if (pr.nbc && typeof pr.nbc === 'object') {
    const prev = {
      area_conocimiento: programDoc.nbc?.area_conocimiento ?? null,
      nbc: programDoc.nbc?.nbc ?? null,
    };
    for (const k of ['area_conocimiento', 'nbc']) {
      if (Object.prototype.hasOwnProperty.call(pr.nbc, k)) {
        prev[k] = mergeTxt(pr.nbc[k]);
      }
    }
    update.nbc = prev;
  }
  if (Object.keys(update).length > 0) {
    await Program.findByIdAndUpdate(programDoc._id, { $set: update });
  }
}

/* POST /processes/:id/close
   Archiva el proceso en processHistory, elimina sus fases/documentos y
   reinicia el proceso (fase 0, sin resolución, sin fechas). */
processHistoryController.close = async (req, res) => {
  try {
    const proc = await Process.findById(req.params.id);
    if (!proc) return res.status(404).json({ error: 'Proceso no encontrado' });
    if (proc.tipo_proceso === 'ALERTA') {
      return res.status(400).json({ error: 'Las alertas no se cierran con este flujo.' });
    }

    const { findProgramByProcessCode } = require('../helpers/programByCode');
    const program = await findProgramByProcessCode(Program, proc.program_code);
    if (!program) return res.status(404).json({ error: 'Programa asociado no encontrado' });

    // --- CASO ESPECIAL: Cierre de PM ---
    // Cuando se cierra un PM, su historial se liga al historial del proceso AV/AE padre.
    if (proc.tipo_proceso === 'PM') {
      return await closePM(proc, program, req, res);
    }

    const sufijo = proc.tipo_proceso === 'AE' ? 'ae' : proc.tipo_proceso.toLowerCase();
    const snapFechaRes = program[`fecha_resolucion_${sufijo}`];
    const snapCodigoRes = program[`codigo_resolucion_${sufijo}`];
    const snapDuracionRes = program[`duracion_resolucion_${sufijo}`];

    const {
      fecha_resolucion: bodyFechaRes,
      codigo_resolucion: bodyCodigoRes,
      duracion_resolucion: bodyDuracionRes,
      rc_oficio: bodyRcOficio,
      programa_cambios: bodyProgramaCambios,
      programa_nuevos_valores: bodyProgramaNuevosValores,
    } = req.body || {};

    const estadoRaw = req.body?.estado_solicitud != null
      ? String(req.body.estado_solicitud).toUpperCase() : 'APROBADO';
    const estadoSolicitud = ['NEGADO', 'CANCELADO'].includes(estadoRaw) ? estadoRaw : 'APROBADO';
    const esNegado = estadoSolicitud === 'NEGADO' || estadoSolicitud === 'CANCELADO';
    const esAV = proc.tipo_proceso === 'AV';
    const esAE = proc.tipo_proceso === 'AE';
    /** RC reforma sola: gestión interna, sin resolución MEN ni alerta poscierre. */
    const esReformaCurricularSolo = esRcReformaCurricularSoloProc(proc);
    const esRcNoRenov = esRcNoRenovacionProc(proc);

    const incluirRcDeOficio = !!(req.body
      && (req.body.incluir_rc_de_oficio === true || req.body.incluir_rc_de_oficio === 'true'));
    const avRcOficioPendienteRaw = !!(req.body
      && (req.body.av_rc_oficio_pendiente === true || req.body.av_rc_oficio_pendiente === 'true'));
    if (!esNegado && esAV && incluirRcDeOficio && avRcOficioPendienteRaw) {
      return res.status(400).json({
        error:
          'Indique solo una opción: RC de oficio ya incluido en la resolución del AV o RC de oficio aún pendiente de entrega por el MEN.',
      });
    }
    const esDualCierre = !esNegado && esAV && incluirRcDeOficio;
    /** AV aprobado: el MEN otorgará RC de oficio más adelante; se marca vigencia transitoria en programa e historial. */
    const esRcOficioPendienteCierre = !esNegado && esAV && avRcOficioPendienteRaw && !incluirRcDeOficio;

    const esCierreReformaAprobado =
      !esNegado &&
      estadoSolicitud === 'APROBADO' &&
      proc.tipo_proceso === 'RC' &&
      subtipoEsReformaCierre(proc.subtipo);
    if (esCierreReformaAprobado && (bodyProgramaNuevosValores == null || typeof bodyProgramaNuevosValores !== 'object')) {
      return res.status(400).json({
        error: 'Al cerrar una reforma aprobada debe enviarse programa_nuevos_valores (snapshot de la ficha del programa). Recarga la app y vuelve a intentar, o actualiza el cliente.',
      });
    }

    /* 1 — Obtener todas las fases del proceso con sus documentos, actividades y subactividades */
    const fases = await Phase.find({ proceso_id: proc._id }).sort({ numero: 1 });

    const mapDoc = d => ({
      _id:           d._id,
      name:          d.name,
      drive_id:      d.drive_id,
      view_link:     d.view_link,
      download_link: d.download_link,
      mime_type:     d.mime_type ?? null,
      size:          d.size ?? null,
      subido_en:     d.createdAt ?? null,
      doc_type:      d.doc_type ?? null,
      caso_date_key: d.caso_date_key ?? null,
    });

    const fasesSnapshot = await Promise.all(
      fases.map(async (f) => {
        // Docs de nivel fase (sin actividad)
        const faseDocs = await ProcessDoc.find({ phase_id: f._id, actividad_id: null }).lean();

        // Para cada actividad, capturar sus docs y los de sus subactividades
        const actividadesArr = Array.isArray(f.actividades) ? f.actividades : [];
        const actividadesSnapshot = await Promise.all(
          actividadesArr.map(async (act) => {
            const actDocs = await ProcessDoc.find({
              phase_id: f._id,
              actividad_id: act._id,
              subactividad_id: null,
            }).lean();

            const subsArr = Array.isArray(act.subactividades) ? act.subactividades : [];
            const subactividades = await Promise.all(
              subsArr.map(async (sub) => {
                const subDocs = await ProcessDoc.find({
                  phase_id: f._id,
                  actividad_id: act._id,
                  subactividad_id: sub._id,
                }).lean();
                return {
                  nombre:           sub.nombre,
                  completada:       sub.completada,
                  no_aplica:        !!sub.no_aplica,
                  fecha_completado: sub.fecha_completado ?? null,
                  observaciones:    sub.observaciones ?? '',
                  documentos:       subDocs.map(mapDoc),
                };
              })
            );

            return {
              nombre:           act.nombre,
              responsables:     act.responsables ?? '',
              completada:       act.completada,
              no_aplica:        !!act.no_aplica,
              fecha_completado: act.fecha_completado ?? null,
              observaciones:    act.observaciones ?? '',
              documentos:       actDocs.map(mapDoc),
              subactividades,
            };
          })
        );

        const actividadResueltaHist = (a) => !!a.completada || !!a.no_aplica;
        return {
          fase_numero:              f.numero,
          fase_nombre:              f.nombre,
          actividades_completadas:  actividadesArr.filter(actividadResueltaHist).length,
          actividades_total:        actividadesArr.length,
          documentos:               faseDocs.map(mapDoc),
          actividades:              actividadesSnapshot,
        };
      })
    );

    /* 2 — Capturar documentos ligados directamente al proceso (resolución / constancia reforma) */
    const docsDirectos = await ProcessDoc.find({ process_id: proc._id, phase_id: null }).lean();
    let docsParaHistorialDirectos = docsDirectos;
    if (esReformaCurricularSolo) {
      const soloConstancia = docsDirectos.filter((d) => d.doc_type === 'constancia_reforma');
      if (soloConstancia.length > 0) docsParaHistorialDirectos = soloConstancia;
    } else if (!esNegado && esRcNoRenov) {
      const soloRespuesta = docsDirectos.filter((d) => d.doc_type === 'respuesta_no_renovacion');
      if (soloRespuesta.length > 0) docsParaHistorialDirectos = soloRespuesta;
    }
    let docCierreHist = docsDirectos
      .filter((d) => d.doc_type === 'resolucion_cierre')
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
    if (!docCierreHist) {
      const actoHist = docsDirectos.filter((d) => docCasoDuplicaPdfCierre(d))
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
      if (actoHist) docCierreHist = actoHist;
    }
    if (!esNegado && !esReformaCurricularSolo && !esRcNoRenov) {
      const subNorm = normalizarSubtipoStr(proc.subtipo).toLowerCase();
      if (subNorm === 'renovación + reforma') {
        const out = [];
        if (docCierreHist) out.push(docCierreHist);
        const constancia = docsDirectos.find((d) => d.doc_type === 'constancia_reforma');
        if (constancia && constancia !== docCierreHist) out.push(constancia);
        docsParaHistorialDirectos = out.length ? out : (docCierreHist ? [docCierreHist] : []);
      } else if (docCierreHist) {
        /* Solo el PDF de cierre (resolución MEN); no otros adjuntos sueltos del proceso. */
        docsParaHistorialDirectos = [docCierreHist];
      } else {
        const fb = docsDirectos.find((d) =>
          d.doc_type === 'resolucion_cierre' || d.doc_type === 'resolucion' || d.doc_type === 'resolucion_rc_oficio');
        docsParaHistorialDirectos = fb ? [fb] : [];
      }
    }
    const docResolucionSnapshot = dedupeDocumentosParaHistorial(docsParaHistorialDirectos, mapDoc);
    /** Enlace guardado en programa/historial: preferir PDF explícito de resolución (no otro adjunto sin tipo). */
    const docConstanciaReforma = docsDirectos.find((d) => d.doc_type === 'constancia_reforma');
    const docRespuestaNoRenov = docsDirectos.find((d) => d.doc_type === 'respuesta_no_renovacion');
    const docResolucionPrincipal = docsDirectos.find((d) => d.doc_type === 'resolucion_cierre')
      || docsDirectos.find((d) => d.doc_type === 'resolucion_rc_oficio')
      || docsDirectos.find((d) => d.doc_type === 'resolucion');
    const linkPdfResolucionPrograma =
      (!esNegado && esRcNoRenov && docRespuestaNoRenov?.view_link)
        ? docRespuestaNoRenov.view_link
        : (docConstanciaReforma?.view_link
          ?? docResolucionPrincipal?.view_link
          ?? docsDirectos.find((d) => d.view_link)?.view_link
          ?? null);

    if (!esNegado && (proc.tipo_proceso === 'RC' || esAV)) {
      if (esReformaCurricularSolo) {
        const constancia = await ProcessDoc.findOne({ process_id: proc._id, doc_type: 'constancia_reforma' });
        if (!constancia) {
          return res.status(400).json({
            error: 'Debe cargar el documento de constancia o confirmación del proceso antes de cerrar con estado Aprobado.',
          });
        }
      } else if (esRcNoRenov) {
        const frResp = normFecha(bodyFechaRes);
        if (!frResp) {
          return res.status(400).json({
            error: 'Indique la fecha de la respuesta al cierre (no es una resolución MEN con código ni años de vigencia).',
          });
        }
        const docRespuesta = await ProcessDoc.findOne({ process_id: proc._id, doc_type: 'respuesta_no_renovacion' });
        if (!docRespuesta) {
          return res.status(400).json({
            error: 'Debe cargar el documento de respuesta al cierre antes de cerrar con estado Aprobado.',
          });
        }
      } else {
        const resMain = await findDocResolucionParaCierre(proc._id);
        if (!resMain) {
          return res.status(400).json({
            error: 'Debe cargar el PDF de resolución (modal de cierre o acto administrativo MEN en información del caso) antes de cerrar como Aprobado.',
          });
        }
        if (esDualCierre) {
          const rco = bodyRcOficio || {};
          const f = normFecha(rco.fecha_resolucion);
          const c = (rco.codigo_resolucion != null && String(rco.codigo_resolucion).trim() !== '')
            ? String(rco.codigo_resolucion).trim() : null;
          const dRaw = rco.duracion_resolucion;
          const d = dRaw != null && dRaw !== '' && !Number.isNaN(Number(dRaw)) ? Number(dRaw) : null;
          if (!f || !c || d == null) {
            return res.status(400).json({ error: 'Indique fecha, código y duración (años) de la resolución de Registro calificado de oficio.' });
          }
          // El RC de oficio comparte el PDF de resolución del AV; no se requiere PDF separado.
        }
      }
    }

    /* 3 — Para AE: buscar el PM activo que fue creado al iniciar el proceso */
    const pmActivoAE = esAE
      ? await Process.findOne({ tipo_proceso: 'PM', parent_process_id: proc._id })
      : null;

    /* Snapshot legado del PM (para historial; solo aplica si había un PM activo antes de cerrar) */
    const pmLigadoSnapshot = null;

    /* 4 — Crear registro en processHistory */
    let frFinal = normFecha(bodyFechaRes) || normFecha(snapFechaRes);
    let codFinal = (bodyCodigoRes != null && String(bodyCodigoRes).trim() !== '')
      ? String(bodyCodigoRes).trim()
      : (snapCodigoRes ?? null);
    const durRaw0 = bodyDuracionRes != null && bodyDuracionRes !== ''
      ? Number(bodyDuracionRes)
      : snapDuracionRes;
    let durFinal = durRaw0 != null && !Number.isNaN(Number(durRaw0)) ? Number(durRaw0) : null;
    if (!esNegado && esRcNoRenov) {
      frFinal = normFecha(bodyFechaRes) || null;
      codFinal = null;
      durFinal = null;
    }

    let rcOficioSnapshot = null;
    if (esDualCierre) {
      const rco = bodyRcOficio || {};
      const frR = normFecha(rco.fecha_resolucion);
      const codR = (rco.codigo_resolucion != null && String(rco.codigo_resolucion).trim() !== '')
        ? String(rco.codigo_resolucion).trim() : null;
      const dRawR = rco.duracion_resolucion;
      const durR = dRawR != null && !Number.isNaN(Number(dRawR)) ? Number(dRawR) : null;
      // El RC de oficio comparte el PDF de resolución principal del AV
      await promoverResolucionCierreSiExiste(proc._id);
      const docsRco = await ProcessDoc.find({ process_id: proc._id, doc_type: 'resolucion' }).lean();
      rcOficioSnapshot = {
        codigo_resolucion: codR,
        fecha_resolucion: frR,
        duracion_resolucion: durR,
        documentos: docsRco.map(mapDoc),
      };
    }

    const nombreProcesoHist = (proc.name && String(proc.name).trim())
      ? String(proc.name).trim()
      : `${proc.tipo_proceso} — ${program.nombre || program.dep_code_programa || proc.program_code}`;

    /* Recalcular fechas desde la resolución final (aplica sobre todo a AV/RC donde la resolución
       se provee al cierre y el proceso puede no tener las fechas precalculadas). */
    const defaultOffsetsForHist = (esAV || esAE)
      ? { meses_inicio_antes_venc: 33, meses_doc_par_antes_venc: 16, meses_digitacion_antes_venc: 15, meses_radicado_antes_venc: 12 }
      : { meses_inicio_antes_venc: 29, meses_doc_par_antes_venc: 17, meses_digitacion_antes_venc: 15, meses_radicado_antes_venc: 12 };
    let fechasRecalculadas = {};
    if (!esNegado && !esReformaCurricularSolo) {
      if (esRcNoRenov && proc.fecha_vencimiento) {
        const offRc = {
          meses_inicio_antes_venc: proc.meses_inicio_antes_venc ?? defaultOffsetsForHist.meses_inicio_antes_venc,
          meses_doc_par_antes_venc: proc.meses_doc_par_antes_venc ?? defaultOffsetsForHist.meses_doc_par_antes_venc,
          meses_digitacion_antes_venc: proc.meses_digitacion_antes_venc ?? defaultOffsetsForHist.meses_digitacion_antes_venc,
          meses_radicado_antes_venc: proc.meses_radicado_antes_venc ?? defaultOffsetsForHist.meses_radicado_antes_venc,
        };
        fechasRecalculadas = calcularFechas('RC', proc.fecha_vencimiento, 0, offRc) || {};
        fechasRecalculadas.fecha_vencimiento = proc.fecha_vencimiento;
      } else if (frFinal && durFinal != null) {
        fechasRecalculadas = calcularFechas(proc.tipo_proceso, frFinal, durFinal, defaultOffsetsForHist) || {};
      }
    }

    let fechaVencHistorial =
      fechasRecalculadas.fecha_vencimiento ?? proc.fecha_vencimiento ?? null;
    if (!esReformaCurricularSolo && !fechaVencHistorial && !esNegado && frFinal && durFinal != null) {
      const fvExtra = calcularFechas(proc.tipo_proceso, frFinal, durFinal, {}) || {};
      fechaVencHistorial = fvExtra.fecha_vencimiento ?? null;
    }

    const codHist = esReformaCurricularSolo || (!esNegado && esRcNoRenov) ? null : codFinal;
    const frHist = esReformaCurricularSolo ? null : frFinal;
    const durHist = esReformaCurricularSolo || (!esNegado && esRcNoRenov) ? null : durFinal;

    const esReformaCierreRc =
      !esNegado
      && proc.tipo_proceso === 'RC'
      && subtipoEsReformaCierre(proc.subtipo);

    function buildResolucionVigenteSnapshotDesdePrograma(prog, docsProc) {
      const ult = prog.ultimo_rc;
      const cod =
        (snapCodigoRes != null && String(snapCodigoRes).trim() !== '')
          ? String(snapCodigoRes).trim()
          : (ult?.codigo_resolucion != null ? String(ult.codigo_resolucion).trim() : null);
      const fr = normFecha(snapFechaRes) || normFecha(ult?.fecha_resolucion);
      const fv =
        normFecha(ult?.fecha_vencimiento)
        ?? normFecha(prog.fecha_vencimiento)
        ?? normFecha(proc.fecha_vencimiento);
      const durRaw = snapDuracionRes ?? ult?.duracion_resolucion;
      const dur =
        durRaw != null && !Number.isNaN(Number(durRaw)) ? Number(durRaw) : null;
      const docsRes = (docsProc || []).filter((d) => d.doc_type === 'resolucion');
      let documentos = dedupeDocumentosParaHistorial(docsRes, mapDoc);
      if (!documentos.length && ult?.link_documento) {
        documentos = [{
          name: 'Resolución vigente (ficha del programa)',
          drive_id: null,
          view_link: String(ult.link_documento),
          download_link: null,
          mime_type: null,
          size: null,
          subido_en: null,
        }];
      }
      if (!cod && !fr && !documentos.length) return null;
      return {
        codigo_resolucion: cod,
        fecha_resolucion: fr,
        fecha_vencimiento: fv,
        duracion_resolucion: dur,
        documentos,
      };
    }

    let resolucionVigenteSnapshot = null;
    if (!esNegado && esRcNoRenov) {
      resolucionVigenteSnapshot = buildResolucionVigenteSnapshotDesdePrograma(program, docsDirectos);
    } else if (esReformaCierreRc) {
      /* Antes de actualizar la ficha en renovación+reforma: conservar el RC vigente al gestionar el trámite. */
      resolucionVigenteSnapshot = buildResolucionVigenteSnapshotDesdePrograma(program, docsDirectos);
    }

    /* RC reforma (+ renov.+reforma) aprobado: actualizar Program antes del historial; diff en servidor por si el cliente no envía bien programa_cambios. */
    const esReformaAprobada =
      !esNegado &&
      proc.tipo_proceso === 'RC' &&
      subtipoEsReformaCierre(proc.subtipo) &&
      bodyProgramaNuevosValores &&
      typeof bodyProgramaNuevosValores === 'object';

    let programaCambiosHistorial = Array.isArray(bodyProgramaCambios) && bodyProgramaCambios.length > 0
      ? bodyProgramaCambios
      : [];

    if (esReformaAprobada) {
      const computed = computeProgramaCambiosReforma(program, bodyProgramaNuevosValores);
      if (computed.length) programaCambiosHistorial = computed;
      try {
        await aplicarNuevosValoresProgramaReforma(program, bodyProgramaNuevosValores);
      } catch (migErr) {
        if (migErr.statusCode === 409) {
          return res.status(409).json({ error: migErr.message || 'Ese código de programa ya está en uso.' });
        }
        throw migErr;
      }
    }

    const nombreProgParaHistorial =
      esReformaAprobada &&
      bodyProgramaNuevosValores.nombre != null &&
      String(bodyProgramaNuevosValores.nombre).trim() !== ''
        ? String(bodyProgramaNuevosValores.nombre).trim()
        : (program.nombre || program.dep_code_programa || 'Sin nombre');

    const casoSnapshot = await buildCasoSnapshot(proc._id, mapDoc, fasesSnapshot);

    const historyDoc = await ProcessHistory.create({
      program_code:      proc.program_code,
      dep_code_facultad: program.dep_code_facultad,
      nombre_programa:   nombreProgParaHistorial,
      process_id:        proc._id,
      tipo_proceso:      proc.tipo_proceso,
      nombre_proceso:    nombreProcesoHist,
      subtipo:           proc.subtipo ?? null,

      codigo_resolucion:   codHist,
      fecha_resolucion:    frHist,
      duracion_resolucion: durHist,

      fecha_vencimiento:      (!esNegado && esRcNoRenov)
        ? (resolucionVigenteSnapshot?.fecha_vencimiento ?? fechaVencHistorial)
        : fechaVencHistorial,
      fecha_inicio:           fechasRecalculadas.fecha_inicio            ?? proc.fecha_inicio            ?? null,
      fecha_documento_par:    fechasRecalculadas.fecha_documento_par     ?? proc.fecha_documento_par     ?? null,
      fecha_digitacion_saces: fechasRecalculadas.fecha_digitacion_saces  ?? proc.fecha_digitacion_saces  ?? null,
      fecha_radicado_men:     fechasRecalculadas.fecha_radicado_men      ?? proc.fecha_radicado_men      ?? null,

      obs_vencimiento:      proc.obs_vencimiento ?? '',
      obs_inicio:           proc.obs_inicio ?? '',
      obs_documento_par:    proc.obs_documento_par ?? '',
      obs_digitacion_saces: proc.obs_digitacion_saces ?? '',
      obs_radicado_men:     proc.obs_radicado_men ?? '',
      obs_envio_pm_vicerrectoria:     proc.obs_envio_pm_vicerrectoria ?? '',
      obs_entrega_pm_cna:             proc.obs_entrega_pm_cna ?? '',
      obs_envio_avance_vicerrectoria: proc.obs_envio_avance_vicerrectoria ?? '',
      obs_radicacion_avance_cna:      proc.obs_radicacion_avance_cna ?? '',

      caso_snapshot: casoSnapshot,

      resolucion_vigente_snapshot: resolucionVigenteSnapshot,

      fase_al_cierre:    proc.fase_actual,
      observaciones:     proc.observaciones ?? '',
      condicion:         proc.condicion ?? null,

      pm_ligado: pmLigadoSnapshot,

      fases: fasesSnapshot,
      documentos_proceso: docResolucionSnapshot,
      cerrado_por: req.body.cerrado_por ?? null,
      estado_solicitud: estadoSolicitud,
      rc_oficio:        rcOficioSnapshot,
      programa_cambios: programaCambiosHistorial,
      programa_ficha_al_cierre: esReformaAprobada ? bodyProgramaNuevosValores : null,
      ...(proc.tipo_proceso === 'AV' && !esNegado
        ? { av_rc_oficio_modo: esDualCierre ? 'incluido' : (esRcOficioPendienteCierre ? 'pendiente' : 'ninguno') }
        : {}),
    });

    /**
     * AV + RC de oficio pendiente de entrega: fila RC solo de archivo «Vigencia transitoria»
     * (snapshot del RC vigente al cerrar el AV hasta registrar RC de oficio desde la alerta). No tiene proceso gestionable.
     */
    if (!esNegado && esRcOficioPendienteCierre) {
      const ult = program.ultimo_rc;
      const codU =
        ult?.codigo_resolucion != null && String(ult.codigo_resolucion).trim() !== ''
          ? String(ult.codigo_resolucion).trim()
          : null;
      const frU = ult?.fecha_resolucion ? normFecha(ult.fecha_resolucion) : null;
      const durU =
        ult?.duracion_resolucion != null && !Number.isNaN(Number(ult.duracion_resolucion))
          ? Number(ult.duracion_resolucion)
          : null;
      let fvU =
        ult?.fecha_vencimiento && String(ult.fecha_vencimiento).length >= 10
          ? String(ult.fecha_vencimiento).slice(0, 10)
          : null;
      if (!fvU && frU && durU != null) {
        const fx = calcularFechas('RC', frU, durU, {}) || {};
        fvU =
          fx.fecha_vencimiento && String(fx.fecha_vencimiento).length >= 10
            ? String(fx.fecha_vencimiento).slice(0, 10)
            : fvU;
      }
      const docRcVigente = [];
      if (ult?.link_documento) {
        docRcVigente.push({
          name: 'Resolución RC vigente (ficha)',
          drive_id: null,
          view_link: String(ult.link_documento),
          download_link: null,
          mime_type: null,
          size: null,
          subido_en: null,
        });
      }

      const rcVigHist = await ProcessHistory.create({
        program_code: proc.program_code,
        dep_code_facultad: program.dep_code_facultad,
        nombre_programa: nombreProgParaHistorial,
        process_id: null,
        tipo_proceso: 'RC',
        nombre_proceso: `RC — Vigencia transitoria (RC anterior vigente hasta oficio MEN) — ${program.nombre ?? proc.program_code}`,
        subtipo: SUBTIPO_RC_VIGENCIA_TRANSITORIA,

        codigo_resolucion: codU,
        fecha_resolucion: frU,
        duracion_resolucion: durU,
        fecha_vencimiento: fvU,

        fecha_inicio: null,
        fecha_documento_par: null,
        fecha_digitacion_saces: null,
        fecha_radicado_men: null,

        fase_al_cierre: 0,
        observaciones:
          'Solo archivo: el RC anterior sigue tratándose como vigente en la ficha hasta crear el proceso «Registro calificado de oficio» desde la alerta del RC que vencía o ya venció. No hay trámite que gestionar bajo esta fila.',

        fases: [],
        documentos_proceso: docRcVigente,
        estado_solicitud: 'APROBADO',

        cerrado_por: req.body.cerrado_por ?? null,
        origen_av_history_id: historyDoc._id,
      });

      await ProcessHistory.findByIdAndUpdate(historyDoc._id, {
        rc_vigencia_transitoria_history_id: rcVigHist._id,
      });
    }

    const faseIds = fases.map((f) => f._id);

    const defaultOffsetsAv = { meses_inicio_antes_venc: 33, meses_doc_par_antes_venc: 16, meses_digitacion_antes_venc: 15, meses_radicado_antes_venc: 12 };
    const defaultOffsetsRc = { meses_inicio_antes_venc: 29, meses_doc_par_antes_venc: 17, meses_digitacion_antes_venc: 15, meses_radicado_antes_venc: 12 };
    const nombrePrograma = program.nombre ?? proc.program_code;

    /* 4b — ALERTA post-cierre (no si Negado; AV+RC oficio = dos alertas; AE no genera ALERTA).
       Solo «Reforma curricular» (sin renovación): no crea ALERTA. «Renovación + reforma» sí. */
    if (!esNegado && (proc.tipo_proceso === 'RC' || esAV) && !esDualCierre && !esReformaCurricularSolo && !esRcNoRenov) {
      await Process.deleteMany({
        program_code: proc.program_code,
        tipo_proceso: 'ALERTA',
        alert_para_tipo: proc.tipo_proceso,
      });
      const defaultOffsets = proc.tipo_proceso === 'AV' ? defaultOffsetsAv : defaultOffsetsRc;
      let fechasR = {};
      if (frFinal && durFinal != null) {
        fechasR = calcularFechas(proc.tipo_proceso, frFinal, durFinal, defaultOffsets) || {};
      }
      const alerta = await Process.create({
        name: `Alerta (${proc.tipo_proceso}) — ${nombrePrograma}`,
        program_code: proc.program_code,
        tipo_proceso: 'ALERTA',
        alert_para_tipo: proc.tipo_proceso,
        cerrado_process_history_id: historyDoc._id,
        snapshot_codigo_resolucion: codFinal,
        snapshot_fecha_resolucion: frFinal,
        snapshot_duracion_anos: durFinal,
        fase_actual: 0,
        fecha_vencimiento: fechasR.fecha_vencimiento ?? proc.fecha_vencimiento ?? null,
        fecha_inicio: fechasR.fecha_inicio ?? proc.fecha_inicio ?? null,
        fecha_documento_par: fechasR.fecha_documento_par ?? proc.fecha_documento_par ?? null,
        fecha_digitacion_saces: fechasR.fecha_digitacion_saces ?? proc.fecha_digitacion_saces ?? null,
        fecha_radicado_men: fechasR.fecha_radicado_men ?? proc.fecha_radicado_men ?? null,
        obs_vencimiento: proc.obs_vencimiento ?? '',
        obs_inicio: proc.obs_inicio ?? '',
        obs_documento_par: proc.obs_documento_par ?? '',
        obs_digitacion_saces: proc.obs_digitacion_saces ?? '',
        obs_radicado_men: proc.obs_radicado_men ?? '',
        ...defaultOffsets,
      });
      await ProcessDoc.deleteMany({ phase_id: { $in: faseIds } });
      await promoverResolucionCierreSiExiste(proc._id);
      await ProcessDoc.updateMany({ process_id: proc._id }, { $set: { process_id: alerta._id } });
    } else if (!esNegado && esDualCierre) {
      const rco = bodyRcOficio || {};
      const frR = normFecha(rco.fecha_resolucion);
      const codR = (rco.codigo_resolucion != null && String(rco.codigo_resolucion).trim() !== '')
        ? String(rco.codigo_resolucion).trim() : null;
      const dRawR = rco.duracion_resolucion;
      const durR = dRawR != null && !Number.isNaN(Number(dRawR)) ? Number(dRawR) : null;

      await Process.deleteMany({ program_code: proc.program_code, tipo_proceso: 'ALERTA', alert_para_tipo: 'AV' });
      await Process.deleteMany({ program_code: proc.program_code, tipo_proceso: 'ALERTA', alert_para_tipo: 'RC' });

      /* ── AV ALERTA ── */
      let fechasAv = {};
      if (frFinal && durFinal != null) {
        fechasAv = calcularFechas('AV', frFinal, durFinal, defaultOffsetsAv) || {};
      }
      const alertaAv = await Process.create({
        name: `Alerta (AV) — ${nombrePrograma}`,
        program_code: proc.program_code,
        tipo_proceso: 'ALERTA',
        alert_para_tipo: 'AV',
        cerrado_process_history_id: historyDoc._id,
        snapshot_codigo_resolucion: codFinal,
        snapshot_fecha_resolucion: frFinal,
        snapshot_duracion_anos: durFinal,
        fase_actual: 0,
        fecha_vencimiento: fechasAv.fecha_vencimiento ?? proc.fecha_vencimiento ?? null,
        fecha_inicio: fechasAv.fecha_inicio ?? proc.fecha_inicio ?? null,
        fecha_documento_par: fechasAv.fecha_documento_par ?? proc.fecha_documento_par ?? null,
        fecha_digitacion_saces: fechasAv.fecha_digitacion_saces ?? proc.fecha_digitacion_saces ?? null,
        fecha_radicado_men: fechasAv.fecha_radicado_men ?? proc.fecha_radicado_men ?? null,
        obs_vencimiento: '', obs_inicio: '', obs_documento_par: '', obs_digitacion_saces: '', obs_radicado_men: '',
        ...defaultOffsetsAv,
      });

      /* ── RC de oficio: calcular fechas ── */
      let fechasRco = {};
      if (frR && durR != null) {
        fechasRco = calcularFechas('RC', frR, durR, defaultOffsetsRc) || {};
      }

      /* ── RC de oficio: obtener snapshot del PDF de resolución (compartido con AV) ── */
      const resDocPrevio = await ProcessDoc.findOne({ process_id: proc._id, doc_type: 'resolucion' }).lean();
      const docResRcoSnapshot = resDocPrevio ? [mapDoc(resDocPrevio)] : [];

      /* ── RC de oficio: crear historial directamente (proceso "virtual" otorgado por resolución) ── */
      const rcOficioHistoryDoc = await ProcessHistory.create({
        program_code:      proc.program_code,
        dep_code_facultad: program.dep_code_facultad,
        nombre_programa:   program.nombre || proc.program_code || 'Sin nombre',
        process_id:        null,
        tipo_proceso:      'RC',
        nombre_proceso:    `Registro calificado de oficio — ${nombrePrograma}`,
        subtipo:           'Registro calificado de oficio',
        codigo_resolucion:   codR,
        fecha_resolucion:    frR,
        duracion_resolucion: durR,
        fecha_vencimiento:      fechasRco.fecha_vencimiento ?? null,
        fecha_inicio:           fechasRco.fecha_inicio ?? null,
        fecha_documento_par:    fechasRco.fecha_documento_par ?? null,
        fecha_digitacion_saces: fechasRco.fecha_digitacion_saces ?? null,
        fecha_radicado_men:     fechasRco.fecha_radicado_men ?? null,
        fase_al_cierre:    0,
        observaciones:     '',
        estado_solicitud:  'APROBADO',
        fases:             [],
        documentos_proceso: docResRcoSnapshot,
        cerrado_por:       req.body.cerrado_por ?? null,
      });

      /* Vincular el historial RC al historial AV */
      await ProcessHistory.findByIdAndUpdate(historyDoc._id, { rc_oficio_history_id: rcOficioHistoryDoc._id });

      /* ── RC de oficio: crear ALERTA referenciando su propio historial ── */
      const alertaRc = await Process.create({
        name: `Alerta (RC) — ${nombrePrograma}`,
        program_code: proc.program_code,
        tipo_proceso: 'ALERTA',
        alert_para_tipo: 'RC',
        cerrado_process_history_id: rcOficioHistoryDoc._id,
        snapshot_codigo_resolucion: codR,
        snapshot_fecha_resolucion: frR,
        snapshot_duracion_anos: durR,
        fase_actual: 0,
        fecha_vencimiento: fechasRco.fecha_vencimiento ?? null,
        fecha_inicio: fechasRco.fecha_inicio ?? null,
        fecha_documento_par: fechasRco.fecha_documento_par ?? null,
        fecha_digitacion_saces: fechasRco.fecha_digitacion_saces ?? null,
        fecha_radicado_men: fechasRco.fecha_radicado_men ?? null,
        obs_vencimiento: '', obs_inicio: '', obs_documento_par: '', obs_digitacion_saces: '', obs_radicado_men: '',
        ...defaultOffsetsRc,
      });

      /* ── Mover PDFs: resolución AV → alertaAv y copia → alertaRc ── */
      await ProcessDoc.deleteMany({ phase_id: { $in: faseIds } });
      await promoverResolucionCierreSiExiste(proc._id);
      const docsPend = await ProcessDoc.find({ process_id: proc._id });
      for (const d of docsPend) {
        const t = d.doc_type || 'proceso';
        if (t === 'resolucion') {
          await ProcessDoc.findByIdAndUpdate(d._id, { $set: { process_id: alertaAv._id } });
          // Copia del mismo PDF a la ALERTA del RC de oficio
          const docObj = d.toObject ? d.toObject() : { ...d };
          delete docObj._id;
          await ProcessDoc.create({ ...docObj, process_id: alertaRc._id });
        } else if (t !== 'resolucion_rc_oficio') {
          await ProcessDoc.findByIdAndUpdate(d._id, { $set: { process_id: alertaAv._id } });
        }
      }
    } else if (esNegado && (proc.tipo_proceso === 'RC' || esAV)) {
      await ProcessDoc.deleteMany({ phase_id: { $in: faseIds } });
    }

    /* Reforma curricular aprobada o RC no renovación aprobada: no hubo traslado a ALERTA — borrar docs de fases aquí. */
    if (!esNegado && (esReformaCurricularSolo || esRcNoRenov)) {
      await ProcessDoc.deleteMany({ phase_id: { $in: faseIds } });
    }

    /* 5 — Limpiar documentos de fases y del proceso
       Para RC y AV: los docs del proceso ya se transfirieron a la ALERTA arriba.
       Reforma curricular aprobada: igual que sin alerta (snapshot ya en historial).
       Para AE: solo borrar docs de fases (no hay ALERTA). */
    if (proc.tipo_proceso !== 'RC' && !esAV) {
      await ProcessDoc.deleteMany({ phase_id: { $in: faseIds } });
    }
    await ProcessDoc.deleteMany({ process_id: proc._id });

    /* 6 — Las filas de Phase se eliminan al final del cierre (tras actualizar Programa),
       para no dejar un proceso activo sin fases si falla un paso intermedio (p. ej. $set en Program). */

    /* 7 — Para AV (aprobado, cualquier modalidad de cierre): crear PM automático y ligarlo al historial.
            Para AE (aprobado): el PM ya existe; solo ligar su ID al historial.
            Se envuelve en try-catch para que un error en el PM no cancele el cierre del proceso. */
    if (!esNegado) {
      if (esAV) {
        try {
          const pmNuevo = await crearPMAutomatico(
            { ...proc.toObject(), _id: proc._id, tipo_proceso: 'AV' },
            { fecha_resolucion: frFinal ?? null, duracion_resolucion: durFinal ?? null }
          );
          if (pmNuevo) {
            await ProcessHistory.findByIdAndUpdate(historyDoc._id, { pm_proceso_id: pmNuevo._id });
          }
        } catch (pmErr) {
          console.error('[processHistory.close] Error al crear PM para AV:', pmErr?.message || pmErr);
          // El cierre del AV continúa aunque falle la creación del PM.
        }
      } else if (esAE && pmActivoAE) {
        try {
          await ProcessHistory.findByIdAndUpdate(historyDoc._id, { pm_proceso_id: pmActivoAE._id });
        } catch (pmErr) {
          console.error('[processHistory.close] Error al ligar PM al historial de AE:', pmErr?.message || pmErr);
        }
      }
    }

    /* 8 — Actualizar programa: limpiar legacy, poblar ultimo_rc/av, recalcular totales.
       Reforma curricular sola: no toca resolución / ultimo_rc en la ficha (no es trámite MEN). */
    if (esReformaCurricularSolo) {
      const totalRC = await countRcHistorialContable(proc.program_code);
      const totalAV = await ProcessHistory.countDocuments({ program_code: proc.program_code, tipo_proceso: 'AV' });
      await Program.findByIdAndUpdate(program._id, { $set: { total_rc: totalRC, total_av: totalAV } });
    } else {
      const linkDocHistorial = linkPdfResolucionPrograma;

      const totalRC = await countRcHistorialContable(proc.program_code);
      const totalAV = await ProcessHistory.countDocuments({ program_code: proc.program_code, tipo_proceso: 'AV' });

      const programaUpdate = {
        fecha_resolucion_av: null, codigo_resolucion_av: null, duracion_resolucion_av: null,
        fecha_resolucion_rc: null, codigo_resolucion_rc: null, duracion_resolucion_rc: null,
        total_rc: totalRC,
        total_av: totalAV,
      };

      /* RC «No renovación» cerrada como aprobada: el programa pasa a Inactivo. Negado/cancelado no cambia el estado en ficha. */
      if (!esNegado && esRcNoRenov) {
        programaUpdate.estado = 'Inactivo';
      }
      /* Reactivación RC aprobada: reabre el programa como activo en la ficha. */
      if (!esNegado && proc.tipo_proceso === 'RC' && String(proc.subtipo ?? '').trim() === 'Reactivación') {
        programaUpdate.estado = 'Activo';
      }

      if (esDualCierre) {
        programaUpdate.av_rc_oficio_pendiente = false;
        programaUpdate.ultimo_av = esNegado ? null : {
          codigo_resolucion:   codFinal,
          fecha_resolucion:    frFinal,
          duracion_resolucion: durFinal,
          fecha_vencimiento:   historyDoc.fecha_vencimiento ?? null,
          link_documento:      linkDocHistorial,
        };
        const rco = bodyRcOficio || {};
        const frR  = normFecha(rco.fecha_resolucion);
        const durR = rco.duracion_resolucion != null ? Number(rco.duracion_resolucion) : null;
        const codR = rco.codigo_resolucion ? String(rco.codigo_resolucion).trim() : null;
        const fechasRco = (frR && durR != null) ? (calcularFechas('RC', frR, durR, defaultOffsetsRc) || {}) : {};
        const fvRcOficio =
          fechasRco.fecha_vencimiento
          ?? (!(Number.isNaN(Number(durR))) && durR != null && frR
              ? (calcularFechas('RC', frR, Number(durR), {}) || {}).fecha_vencimiento
              : null);
        programaUpdate.ultimo_rc = {
          codigo_resolucion:   codR,
          fecha_resolucion:    frR,
          duracion_resolucion: durR,
          fecha_vencimiento:   fvRcOficio,
          link_documento:      linkDocHistorial,
        };
      } else if (proc.tipo_proceso === 'RC') {
        if (!esNegado && esRcNoRenov) {
          programaUpdate.ultimo_rc = {
            codigo_resolucion: null,
            fecha_resolucion: frFinal,
            duracion_resolucion: null,
            fecha_vencimiento: null,
            link_documento: linkDocHistorial,
          };
        } else {
          programaUpdate.ultimo_rc = esNegado ? null : {
            codigo_resolucion:   codFinal,
            fecha_resolucion:    frFinal,
            duracion_resolucion: durFinal,
            fecha_vencimiento:   historyDoc.fecha_vencimiento ?? null,
            link_documento:      linkDocHistorial,
          };
        }
      } else if (esAV) {
        programaUpdate.ultimo_av = esNegado ? null : {
          codigo_resolucion:   codFinal,
          fecha_resolucion:    frFinal,
          duracion_resolucion: durFinal,
          fecha_vencimiento:   historyDoc.fecha_vencimiento ?? null,
          link_documento:      linkDocHistorial,
        };
      }

      /** RC formal de oficio: sustituye el periodo de vigencia «transitoria» en ficha si existía. */
      if (
        !esNegado &&
        proc.tipo_proceso === 'RC' &&
        String(proc.subtipo ?? '').trim() === 'Registro calificado de oficio'
      ) {
        programaUpdate.av_rc_oficio_pendiente = false;
      }
      if (!esDualCierre && esAV) {
        programaUpdate.av_rc_oficio_pendiente = Boolean(!esNegado && esRcOficioPendienteCierre);
      }

      await Program.findByIdAndUpdate(program._id, { $set: programaUpdate });
      try {
        const { actualizarVigenciaPrograma } = require('../helpers/cronVigencia');
        await actualizarVigenciaPrograma(program._id);
      } catch (e) {
        console.error('[processHistory] actualizarVigenciaPrograma:', e.message);
      }
    }

    /* 9 — Caso de radicación ligado al proceso (evita huérfanos y errores de índice único al reabrir) */
    await Caso.deleteMany({ proceso_id: proc._id });

    /* 9b — Eliminar fases del proceso (después de actualizar ficha y casos; evita UI rota si algo falla antes). */
    await Phase.deleteMany({ proceso_id: proc._id });

    /* 10 — Eliminar el proceso activo (ya fue archivado en el historial) */
    await Process.findByIdAndDelete(proc._id);

    res.status(200).json({ message: 'Proceso cerrado y archivado correctamente' });
  } catch (error) {
    console.error('Error cerrando proceso:', error);
    if (error?.statusCode === 409) {
      return res.status(409).json({ error: error.message || 'Conflicto al actualizar el código del programa.' });
    }
    let msg = error?.message || 'Error interno del servidor';
    if (error?.name === 'ValidationError' && error.errors) {
      msg = Object.values(error.errors).map((e) => e.message).join('; ');
    } else if (error?.code === 11000) {
      msg = 'Ya existe un registro con esos datos únicos (índice duplicado).';
    }
    res.status(500).json({ error: 'Error al cerrar el proceso', detalle: msg });
  }
};

/* GET /process-history
   Filtros opcionales: program_code, dep_code_facultad, tipo_proceso */
processHistoryController.getAll = async (req, res) => {
  try {
    const query = {};
    if (req.query.program_code)      query.program_code      = req.query.program_code;
    if (req.query.dep_code_facultad) query.dep_code_facultad = req.query.dep_code_facultad;
    if (req.query.tipo_proceso)      query.tipo_proceso      = req.query.tipo_proceso;

    const records = await ProcessHistory.find(query).sort({ cerrado_en: -1 });
    res.status(200).json(records);
  } catch (error) {
    console.error('Error obteniendo historial:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* GET /process-history/:id — detalle de un registro histórico */
processHistoryController.getById = async (req, res) => {
  try {
    const record = await ProcessHistory.findById(req.params.id);
    if (!record) return res.status(404).json({ error: 'Registro no encontrado' });
    res.status(200).json(record);
  } catch (error) {
    console.error('Error obteniendo registro histórico:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

function hoyYmd() {
  return new Date().toISOString().slice(0, 10);
}

function vencimientoActivoYmd(fechaVenc) {
  if (!fechaVenc) return false;
  const ymd = String(fechaVenc).trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd) && ymd >= hoyYmd();
}

function pickDocResolucionHistorial(docs) {
  if (!Array.isArray(docs) || !docs.length) return null;
  const conLink = docs.filter((d) => d?.view_link && String(d.view_link).trim());
  return conLink.find((d) => d.doc_type === 'resolucion_cierre')
    ?? conLink.find((d) => d.doc_type === 'resolucion' || d.doc_type === 'resolucion_rc_oficio')
    ?? conLink.find((d) => d.caso_date_key === 'fecha_resolucion')
    ?? conLink.find((d) => {
      const t = d.doc_type || '';
      return t !== 'constancia_reforma' && t !== 'respuesta_no_renovacion';
    })
    ?? null;
}

async function historialEsResolucionVigenteEnPrograma(historyDoc, program) {
  const tipo = historyDoc.tipo_proceso;
  if (tipo !== 'RC' && tipo !== 'AV') return false;
  const estado = historyDoc.estado_solicitud || 'APROBADO';
  if (estado === 'NEGADO' || estado === 'CANCELADO') return false;

  const ult = tipo === 'RC' ? program.ultimo_rc : program.ultimo_av;
  const vencHist = historyDoc.fecha_vencimiento || ult?.fecha_vencimiento || null;
  if (!vencimientoActivoYmd(vencHist)) return false;

  const codH = historyDoc.codigo_resolucion != null ? String(historyDoc.codigo_resolucion).trim() : '';
  const codU = ult?.codigo_resolucion != null ? String(ult.codigo_resolucion).trim() : '';
  const frH = normFecha(historyDoc.fecha_resolucion);
  const frU = normFecha(ult?.fecha_resolucion);
  if (codH && codU && codH === codU && frH && frU && frH === frU) return true;

  const linkHist = pickDocResolucionHistorial(historyDoc.documentos_proceso)?.view_link;
  const linkUlt = ult?.link_documento;
  if (linkHist && linkUlt && String(linkHist).trim() === String(linkUlt).trim()) return true;

  const latest = await ProcessHistory.findOne({
    program_code: historyDoc.program_code,
    tipo_proceso: tipo,
    estado_solicitud: { $nin: ['NEGADO', 'CANCELADO'] },
  })
    .sort({ cerrado_en: -1 })
    .lean();
  return latest && String(latest._id) === String(historyDoc._id);
}

/* PATCH /process-history/:id/resolucion-pdf — reemplazar PDF de resolución archivada */
processHistoryController.updateResolucionPdf = async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: 'No se adjuntó ningún archivo' });
    }

    const historyDoc = await ProcessHistory.findById(id);
    if (!historyDoc) return res.status(404).json({ error: 'Registro de historial no encontrado' });

    const tipo = historyDoc.tipo_proceso;
    if (tipo !== 'RC' && tipo !== 'AV') {
      return res.status(400).json({ error: 'Solo aplica a procesos RC o AV archivados.' });
    }

    const { findProgramByProcessCode } = require('../helpers/programByCode');
    const program = await findProgramByProcessCode(Program, historyDoc.program_code);
    if (!program) return res.status(404).json({ error: 'Programa no encontrado' });

    const fileData = await uploadFileToGoogleDrive(
      req.file,
      'Fechas/Procesos/Resoluciones',
      req.file.originalname,
    );

    const nuevoSnapshot = {
      name: fileData.name,
      drive_id: fileData.id,
      view_link: fileData.webViewLink,
      download_link: fileData.webContentLink,
      mime_type: req.file.mimetype,
      size: req.file.size,
      subido_en: new Date(),
      doc_type: 'resolucion_cierre',
      caso_date_key: null,
    };

    const docsPrevios = Array.isArray(historyDoc.documentos_proceso) ? historyDoc.documentos_proceso : [];
    /* Mantener solo constancia / respuesta no renovación; reemplazar PDF de resolución por uno solo. */
    const otros = docsPrevios.filter((d) => {
      const t = d.doc_type || '';
      if (t === 'resolucion' || t === 'resolucion_cierre' || t === 'resolucion_rc_oficio') return false;
      if (t === 'proceso') return false;
      return t === 'constancia_reforma' || t === 'respuesta_no_renovacion';
    });

    historyDoc.documentos_proceso = [...otros, nuevoSnapshot];
    await historyDoc.save();

    const actualizaPrograma = await historialEsResolucionVigenteEnPrograma(historyDoc, program);
    if (actualizaPrograma) {
      const sufijo = tipo === 'RC' ? 'rc' : 'av';
      const link = nuevoSnapshot.view_link;
      const patchUlt = {
        [`ultimo_${sufijo}.link_documento`]: link,
      };
      if (historyDoc.codigo_resolucion) {
        patchUlt[`ultimo_${sufijo}.codigo_resolucion`] = historyDoc.codigo_resolucion;
        patchUlt[`codigo_resolucion_${sufijo}`] = historyDoc.codigo_resolucion;
      }
      if (historyDoc.fecha_resolucion) {
        patchUlt[`ultimo_${sufijo}.fecha_resolucion`] = historyDoc.fecha_resolucion;
        patchUlt[`fecha_resolucion_${sufijo}`] = historyDoc.fecha_resolucion;
      }
      if (historyDoc.duracion_resolucion != null) {
        patchUlt[`ultimo_${sufijo}.duracion_resolucion`] = historyDoc.duracion_resolucion;
        patchUlt[`duracion_resolucion_${sufijo}`] = historyDoc.duracion_resolucion;
      }
      if (historyDoc.fecha_vencimiento) {
        patchUlt[`ultimo_${sufijo}.fecha_vencimiento`] = historyDoc.fecha_vencimiento;
      }
      await Program.findByIdAndUpdate(program._id, { $set: patchUlt });
      try {
        const { actualizarVigenciaPrograma } = require('../helpers/cronVigencia');
        await actualizarVigenciaPrograma(program._id);
      } catch (e) {
        console.error('[processHistory] actualizarVigenciaPrograma (PDF):', e.message);
      }
    }

    res.status(200).json({
      historial: historyDoc,
      actualizo_resolucion_vigente_programa: actualizaPrograma,
    });
  } catch (error) {
    console.error('Error actualizando PDF de resolución en historial:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = processHistoryController;
