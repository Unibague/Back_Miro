const Process        = require('../models/processes');
const Phase          = require('../models/phases');
const ProcessDoc     = require('../models/processDocuments');
const Program        = require('../models/programs');
const ProcessHistory = require('../models/processHistory');
const Caso           = require('../models/casos');
const { calcularFechas } = require('./processes');

const processHistoryController = {};

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

    const program = await Program.findOne({ dep_code_programa: proc.program_code });
    if (!program) return res.status(404).json({ error: 'Programa asociado no encontrado' });

    const sufijo = proc.tipo_proceso.toLowerCase();
    const snapFechaRes = program[`fecha_resolucion_${sufijo}`];
    const snapCodigoRes = program[`codigo_resolucion_${sufijo}`];
    const snapDuracionRes = program[`duracion_resolucion_${sufijo}`];

    const {
      fecha_resolucion: bodyFechaRes,
      codigo_resolucion: bodyCodigoRes,
      duracion_resolucion: bodyDuracionRes,
    } = req.body || {};

    const normFecha = (v) => {
      if (!v) return null;
      if (v instanceof Date) return v.toISOString().split('T')[0];
      const s = String(v);
      return s.length >= 10 ? s.slice(0, 10) : s;
    };

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

    /* 2 — Capturar documentos ligados directamente al proceso (PDF resolución vigente) */
    const docsDirectos = await ProcessDoc.find({ process_id: proc._id, phase_id: null }).lean();
    const docResolucionSnapshot = docsDirectos.map(mapDoc);

    /* 3 — Capturar snapshot del PM hijo si existe (antes de eliminarlo) */
    const pmHijo = await Process.findOne({
      program_code: proc.program_code,
      tipo_proceso: 'PM',
      parent_process_id: proc._id,
    });
    const pmLigadoSnapshot = pmHijo ? {
      subtipo:                          pmHijo.subtipo ?? null,
      fecha_envio_pm_vicerrectoria:     pmHijo.fecha_envio_pm_vicerrectoria     ?? null,
      fecha_entrega_pm_cna:             pmHijo.fecha_entrega_pm_cna             ?? null,
      fecha_envio_avance_vicerrectoria: pmHijo.fecha_envio_avance_vicerrectoria ?? null,
      fecha_radicacion_avance_cna:      pmHijo.fecha_radicacion_avance_cna      ?? null,
      observaciones:                    pmHijo.observaciones ?? '',
    } : null;

    /* 4 — Crear registro en processHistory */
    const frFinal = normFecha(bodyFechaRes) || normFecha(snapFechaRes);
    const codFinal = (bodyCodigoRes != null && String(bodyCodigoRes).trim() !== '')
      ? String(bodyCodigoRes).trim()
      : (snapCodigoRes ?? null);
    const durRaw = bodyDuracionRes != null && bodyDuracionRes !== ''
      ? Number(bodyDuracionRes)
      : snapDuracionRes;
    const durFinal = durRaw != null && !Number.isNaN(Number(durRaw)) ? Number(durRaw) : null;

    const nombreProcesoHist = (proc.name && String(proc.name).trim())
      ? String(proc.name).trim()
      : `${proc.tipo_proceso} — ${program.nombre || program.dep_code_programa || proc.program_code}`;

    const historyDoc = await ProcessHistory.create({
      program_code:      proc.program_code,
      dep_code_facultad: program.dep_code_facultad,
      nombre_programa:   program.nombre || program.dep_code_programa || 'Sin nombre',
      process_id:        proc._id,
      tipo_proceso:      proc.tipo_proceso,
      nombre_proceso:    nombreProcesoHist,
      subtipo:           proc.subtipo ?? null,

      codigo_resolucion:   codFinal,
      fecha_resolucion:    frFinal,
      duracion_resolucion: durFinal,

      fecha_vencimiento:      proc.fecha_vencimiento,
      fecha_inicio:           proc.fecha_inicio,
      fecha_documento_par:    proc.fecha_documento_par,
      fecha_digitacion_saces: proc.fecha_digitacion_saces,
      fecha_radicado_men:     proc.fecha_radicado_men,

      fase_al_cierre:    proc.fase_actual,
      observaciones:     proc.observaciones ?? '',
      condicion:         proc.condicion ?? null,

      pm_ligado: pmLigadoSnapshot,

      fases: fasesSnapshot,
      documentos_proceso: docResolucionSnapshot,
      cerrado_por: req.body.cerrado_por ?? null,
    });

    const faseIds = fases.map((f) => f._id);

    /* 4b — Proceso tipo ALERTA (fechas congeladas al cierre; no es una fase) */
    if (proc.tipo_proceso === 'RC' || proc.tipo_proceso === 'AV') {
      await Process.deleteMany({
        program_code: proc.program_code,
        tipo_proceso: 'ALERTA',
        alert_para_tipo: proc.tipo_proceso,
      });
      const defaultOffsets = proc.tipo_proceso === 'AV'
        ? { meses_inicio_antes_venc: 33, meses_doc_par_antes_venc: 16, meses_digitacion_antes_venc: 15, meses_radicado_antes_venc: 12 }
        : { meses_inicio_antes_venc: 29, meses_doc_par_antes_venc: 17, meses_digitacion_antes_venc: 15, meses_radicado_antes_venc: 12 };
      let fechasR = {};
      if (frFinal && durFinal != null) {
        fechasR = calcularFechas(proc.tipo_proceso, frFinal, durFinal, defaultOffsets) || {};
      }
      const nombrePrograma = program.nombre ?? proc.program_code;
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
      /* Documentos de actividad/fase: eliminar antes de reasignar el proceso,
         para no borrar después los archivos ya movidos a la ALERTA. */
      await ProcessDoc.deleteMany({ phase_id: { $in: faseIds } });
      await ProcessDoc.updateMany({ process_id: proc._id }, { $set: { process_id: alerta._id } });
    }

    /* 5 — Limpiar documentos de fases y del proceso */
    if (proc.tipo_proceso !== 'RC' && proc.tipo_proceso !== 'AV') {
      await ProcessDoc.deleteMany({ phase_id: { $in: faseIds } });
    }
    await ProcessDoc.deleteMany({ process_id: proc._id });

    /* 6 — Eliminar fases actuales */
    await Phase.deleteMany({ proceso_id: proc._id });

    /* 7 — Eliminar el PM hijo si existía */
    if (pmHijo) {
      await Phase.deleteMany({ proceso_id: pmHijo._id });
      await ProcessDoc.deleteMany({ process_id: pmHijo._id });
      await Process.findByIdAndDelete(pmHijo._id);
    }

    /* 8 — Limpiar los campos de resolución del programa para este tipo */
    const camposResolucion = {
      [`fecha_resolucion_${sufijo}`]:    null,
      [`codigo_resolucion_${sufijo}`]:   null,
      [`duracion_resolucion_${sufijo}`]: null,
    };
    await Program.findByIdAndUpdate(program._id, { $set: camposResolucion });

    /* 9 — Caso de radicación ligado al proceso (evita huérfanos y errores de índice único al reabrir) */
    await Caso.deleteMany({ proceso_id: proc._id });

    /* 10 — Eliminar el proceso activo (ya fue archivado en el historial) */
    await Process.findByIdAndDelete(proc._id);

    res.status(200).json({ message: 'Proceso cerrado y archivado correctamente' });
  } catch (error) {
    console.error('Error cerrando proceso:', error);
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

module.exports = processHistoryController;
