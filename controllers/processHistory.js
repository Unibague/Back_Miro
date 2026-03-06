const Process        = require('../models/processes');
const Phase          = require('../models/phases');
const ProcessDoc     = require('../models/processDocuments');
const Program        = require('../models/programs');
const ProcessHistory = require('../models/processHistory');
const FASES_PREDEFINIDAS = require('../helpers/fasesBase');
const { calcularFechas } = require('./processes');

const processHistoryController = {};

/* POST /processes/:id/close
   Archiva el proceso en processHistory, elimina sus fases/documentos y
   reinicia el proceso (fase 0, sin resolución, sin fechas). */
processHistoryController.close = async (req, res) => {
  try {
    const proc = await Process.findById(req.params.id);
    if (!proc) return res.status(404).json({ error: 'Proceso no encontrado' });

    const program = await Program.findOne({ dep_code_programa: proc.program_code });
    if (!program) return res.status(404).json({ error: 'Programa asociado no encontrado' });

    const sufijo = proc.tipo_proceso.toLowerCase();

    /* 1 — Obtener todas las fases del proceso con sus documentos */
    const fases = await Phase.find({ proceso_id: proc._id }).sort({ numero: 1 });
    const fasesSnapshot = await Promise.all(
      fases.map(async (f) => {
        const docs = await ProcessDoc.find({ phase_id: f._id }).lean();
        return {
          fase_numero:              f.numero,
          fase_nombre:              f.nombre,
          actividades_completadas:  f.actividades.filter(a => a.completada).length,
          actividades_total:        f.actividades.length,
          documentos: docs.map(d => ({
            _id:           d._id,
            name:          d.name,
            drive_id:      d.drive_id,
            view_link:     d.view_link,
            download_link: d.download_link,
            mime_type:     d.mime_type ?? null,
            size:          d.size ?? null,
          })),
        };
      })
    );

    /* 2 — Capturar documentos ligados directamente al proceso (PDF resolución vigente) */
    const docsDirectos = await ProcessDoc.find({ process_id: proc._id, phase_id: null }).lean();
    const docResolucionSnapshot = docsDirectos.map(d => ({
      _id:           d._id,
      name:          d.name,
      drive_id:      d.drive_id,
      view_link:     d.view_link,
      download_link: d.download_link,
      mime_type:     d.mime_type ?? null,
      size:          d.size ?? null,
    }));

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
    await ProcessHistory.create({
      program_code:      proc.program_code,
      dep_code_facultad: program.dep_code_facultad,
      nombre_programa:   program.nombre,
      process_id:        proc._id,
      tipo_proceso:      proc.tipo_proceso,
      nombre_proceso:    proc.name,
      subtipo:           proc.subtipo ?? null,

      codigo_resolucion:   program[`codigo_resolucion_${sufijo}`] ?? null,
      fecha_resolucion:    program[`fecha_resolucion_${sufijo}`]  ?? null,
      duracion_resolucion: program[`duracion_resolucion_${sufijo}`] ?? null,

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

    /* 5 — Limpiar documentos de fases y del proceso */
    const faseIds = fases.map(f => f._id);
    await ProcessDoc.deleteMany({ phase_id: { $in: faseIds } });
    await ProcessDoc.deleteMany({ process_id: proc._id });

    /* 6 — Eliminar fases actuales */
    await Phase.deleteMany({ proceso_id: proc._id });

    /* 7 — Eliminar el PM hijo si existía */
    if (pmHijo) {
      await Phase.deleteMany({ proceso_id: pmHijo._id });
      await ProcessDoc.deleteMany({ process_id: pmHijo._id });
      await Process.findByIdAndDelete(pmHijo._id);
    }

    /* 8 — Reiniciar el proceso (limpiar resolución y fechas, volver a fase 0) */
    const camposClear = {
      fase_actual:            0,
      observaciones:          '',
      condicion:              null,
      fecha_vencimiento:      null,
      fecha_inicio:           null,
      fecha_documento_par:    null,
      fecha_digitacion_saces: null,
      fecha_radicado_men:     null,
      fecha_envio_pm_vicerrectoria:     null,
      fecha_entrega_pm_cna:             null,
      fecha_envio_avance_vicerrectoria: null,
      fecha_radicacion_avance_cna:      null,
      meses_inicio_antes_venc:     null,
      meses_doc_par_antes_venc:    null,
      meses_digitacion_antes_venc: null,
      meses_radicado_antes_venc:   null,
    };
    await Process.findByIdAndUpdate(proc._id, { $set: camposClear });

    /* 9 — Limpiar los campos de resolución del programa para este tipo */
    const camposResolucion = {
      [`fecha_resolucion_${sufijo}`]:    null,
      [`codigo_resolucion_${sufijo}`]:   null,
      [`duracion_resolucion_${sufijo}`]: null,
    };
    await Program.findByIdAndUpdate(program._id, { $set: camposResolucion });

    /* 10 — Recrear las 7 fases vacías para el proceso reiniciado */
    await Phase.insertMany(
      FASES_PREDEFINIDAS.map(f => ({
        proceso_id:  proc._id,
        numero:      f.numero,
        nombre:      f.nombre,
        actividades: f.actividades.map(a => ({ ...a, completada: false })),
      }))
    );

    const procesoActualizado = await Process.findById(proc._id);
    res.status(200).json({ message: 'Proceso cerrado y archivado correctamente', proceso: procesoActualizado });
  } catch (error) {
    console.error('Error cerrando proceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
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
