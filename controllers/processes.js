const Process          = require('../models/processes');
const Phase            = require('../models/phases');
const FASES_BASE_RC    = require('../helpers/fasesBaseRC');
const FASES_BASE_AV    = require('../helpers/fasesBaseAV');
const { crearPMAutomaticoParaAV } = require('../helpers/pmAutoCreate');

function getFasesParaTipo(tipo_proceso) {
  if (tipo_proceso === 'RC') return FASES_BASE_RC;
  if (tipo_proceso === 'AV') return FASES_BASE_AV;
  return []; // PM no tiene fases
}

/* Suma N meses a una fecha YYYY-MM-DD y devuelve YYYY-MM-DD */
function sumarMeses(fechaStr, meses) {
  if (!fechaStr || meses == null) return null;
  const d = new Date(fechaStr + 'T12:00:00');
  if (isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + meses);
  return d.toISOString().split('T')[0];
}

/* Si cae sábado o domingo, corre al lunes siguiente */
function siguienteDiaHabil(fechaStr) {
  if (!fechaStr) return null;
  const d = new Date(fechaStr + 'T12:00:00');
  const dow = d.getDay(); // 0=dom, 6=sab
  if (dow === 6) d.setDate(d.getDate() + 2); // sábado → lunes
  if (dow === 0) d.setDate(d.getDate() + 1); // domingo → lunes
  return d.toISOString().split('T')[0];
}

/* Calcula las fechas del proceso a partir de la resolución vigente.
   - Para RC, AV y PM: la duración viene en AÑOS (se convierte a meses internamente).
   - Para fecha_vencimiento y fecha_radicado_men NO se ajustan fines de semana.
   - Para las otras fechas SÍ se ajusta a siguiente día hábil.

   Plazos por tipo (valores por defecto, relativos al vencimiento, en meses):
   - RC / PM:
       -29 → Inicio proceso
       -17 → Documento para lectura del par
       -15 → Digitación en SACES
       -12 → Radicado en el MEN
   - AV  (aprox):
       -33 → Inicio proceso
       -16 → Documento para lectura del par
       -15 → Digitación en SACES-CNA
       -12 → Radicación solicitud AV
*/
function getDefaultOffsets(tipo_proceso) {
  if (tipo_proceso === 'AV') {
    return {
      meses_inicio_antes_venc:    33,
      meses_doc_par_antes_venc:   16,
      meses_digitacion_antes_venc:15,
      meses_radicado_antes_venc:  12,
    };
  }
  // RC y PM
  return {
    meses_inicio_antes_venc:    29,
    meses_doc_par_antes_venc:   17,
    meses_digitacion_antes_venc:15,
    meses_radicado_antes_venc:  12,
  };
}

function calcularFechas(tipo_proceso, fecha_resolucion, duracion_unidad, offsets) {
  if (!fecha_resolucion || duracion_unidad == null) return {};

  // Duración: siempre en años → convertir a meses
  const duracion_meses = Number(duracion_unidad) * 12;

  const vencimiento = sumarMeses(fecha_resolucion, duracion_meses);
  if (!vencimiento) return {};

  const base = getDefaultOffsets(tipo_proceso);
  const cfg = {
    meses_inicio_antes_venc:     offsets?.meses_inicio_antes_venc     ?? base.meses_inicio_antes_venc,
    meses_doc_par_antes_venc:    offsets?.meses_doc_par_antes_venc    ?? base.meses_doc_par_antes_venc,
    meses_digitacion_antes_venc: offsets?.meses_digitacion_antes_venc ?? base.meses_digitacion_antes_venc,
    meses_radicado_antes_venc:   offsets?.meses_radicado_antes_venc   ?? base.meses_radicado_antes_venc,
  };

  return {
    fecha_vencimiento:      vencimiento,
    fecha_inicio:           siguienteDiaHabil(sumarMeses(vencimiento, -cfg.meses_inicio_antes_venc)),
    fecha_documento_par:    siguienteDiaHabil(sumarMeses(vencimiento, -cfg.meses_doc_par_antes_venc)),
    fecha_digitacion_saces: siguienteDiaHabil(sumarMeses(vencimiento, -cfg.meses_digitacion_antes_venc)),
    fecha_radicado_men:     sumarMeses(vencimiento, -cfg.meses_radicado_antes_venc),
  };
}

const processController = {};

/* GET /processes — todos, opcionalmente filtrados por program_code o tipo_proceso */
processController.getAll = async (req, res) => {
  try {
    const query = {};
    if (req.query.program_code)  query.program_code  = req.query.program_code;
    if (req.query.tipo_proceso)  query.tipo_proceso  = req.query.tipo_proceso;
    const processes = await Process.find(query).sort({ createdAt: -1 });
    res.status(200).json(processes);
  } catch (error) {
    console.error('Error obteniendo procesos:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* GET /processes/:id — un proceso con sus fases y actividades */
processController.getById = async (req, res) => {
  try {
    const process = await Process.findById(req.params.id);
    if (!process) return res.status(404).json({ error: 'Proceso no encontrado' });
    const phases = await Phase.find({ proceso_id: req.params.id }).sort({ numero: 1 });
    res.status(200).json({ ...process.toObject(), fases: phases });
  } catch (error) {
    console.error('Error obteniendo proceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* POST /processes — crear proceso según tipo y subtipo
   Body esperado:
   - tipo_proceso:      'RC' | 'AV'
   - subtipo:           'Nuevo'|'Renovación'|'No renovación'|'Renovación + reforma'|'Reforma curricular'  (RC)
                        'Primera vez'|'Renovación'                                                         (AV)
   - program_code:      código del programa existente (todos excepto RC Nuevo)
   - program_data:      datos del programa a crear  (solo RC Nuevo)
   - fecha_resolucion:  YYYY-MM-DD  (subtipos con resolución)
   - codigo_resolucion: string      (subtipos con resolución)
   - duracion_resolucion: number en años (subtipos con resolución)
*/
processController.create = async (req, res) => {
  try {
    const {
      tipo_proceso,
      subtipo,
      program_code: existingProgramCode,
      program_data,
      fecha_resolucion,
      codigo_resolucion,
      duracion_resolucion,
    } = req.body;

    const Program = require('../models/programs');
    let program;
    let program_code = existingProgramCode;

    /* ── 1. Obtener o crear el programa ── */
    if (subtipo === 'Nuevo' && program_data) {
      // RC Nuevo: crear el programa nuevo sin resolución
      program = await Program.create({
        ...program_data,
        dep_code_programa: program_data.dep_code_programa || `PROG_${Date.now()}`,
      });
      program_code = program.dep_code_programa;
    } else if (program_code) {
      program = await Program.findOne({ dep_code_programa: program_code });
    }

    if (!program_code) {
      return res.status(400).json({ error: 'Se requiere program_code o program_data (para RC Nuevo)' });
    }

    /* ── 2. Guardar resolución en el programa si se proporcionó ── */
    const tieneResolucion = !!(fecha_resolucion && codigo_resolucion && duracion_resolucion);
    if (tieneResolucion && program) {
      const sufijo = tipo_proceso.toLowerCase(); // 'rc' | 'av'
      program = await Program.findByIdAndUpdate(
        program._id,
        {
          [`fecha_resolucion_${sufijo}`]:    fecha_resolucion,
          [`codigo_resolucion_${sufijo}`]:   codigo_resolucion,
          [`duracion_resolucion_${sufijo}`]: Number(duracion_resolucion),
        },
        { new: true }
      );
    }

    /* ── 3. Calcular fechas según subtipo ── */
    const defaultOffsets = tipo_proceso === 'AV'
      ? { meses_inicio_antes_venc: 33, meses_doc_par_antes_venc: 16, meses_digitacion_antes_venc: 15, meses_radicado_antes_venc: 12 }
      : { meses_inicio_antes_venc: 29, meses_doc_par_antes_venc: 17, meses_digitacion_antes_venc: 15, meses_radicado_antes_venc: 12 };

    let fechasCalculadas = {};
    let fase_actual_inicial = 0;

    if ((subtipo === 'Renovación' || subtipo === 'Renovación + reforma') && tieneResolucion) {
      // Auto-calcula todas las fechas
      fechasCalculadas = {
        ...calcularFechas(tipo_proceso, fecha_resolucion, duracion_resolucion, defaultOffsets),
        ...defaultOffsets,
      };
    } else if (subtipo === 'No renovación' && tieneResolucion) {
      // Solo fecha_vencimiento; proceso en Fase 7 permanente
      const vencimiento = sumarMeses(fecha_resolucion, Number(duracion_resolucion) * 12);
      fechasCalculadas = { fecha_vencimiento: vencimiento };
      fase_actual_inicial = 7;
    } else if (subtipo === 'Reforma curricular' && tieneResolucion) {
      // Solo fecha_vencimiento; el resto de fechas vacías y editables
      const vencimiento = sumarMeses(fecha_resolucion, Number(duracion_resolucion) * 12);
      fechasCalculadas = { fecha_vencimiento: vencimiento };
      // fase_actual queda en 0
    }
    // Para 'Nuevo', 'Primera vez': sin resolución ni fechas

    /* ── 4. Nombre del proceso ── */
    if (!program) program = await Program.findOne({ dep_code_programa: program_code });
    const nombrePrograma = program?.nombre ?? program_code;
    const subtipoBracket = subtipo ? ` (${subtipo})` : '';
    const labelTipo = tipo_proceso === 'RC' ? 'Registro Calificado'
                    : tipo_proceso === 'AV' ? 'Acreditación Voluntaria' : 'PM';
    const name = `${labelTipo}${subtipoBracket} - ${nombrePrograma}`;

    /* ── 5. Crear el proceso ── */
    const newProcess = await Process.create({
      name,
      program_code,
      tipo_proceso,
      subtipo: subtipo || null,
      fase_actual: fase_actual_inicial,
      ...fechasCalculadas,
    });

    /* ── 6. Crear fases (excepto Fase 7 — No renovación) ── */
    if (fase_actual_inicial !== 7) {
      const fases = getFasesParaTipo(tipo_proceso);
      if (fases.length > 0) {
        await Phase.insertMany(
          fases.map(f => ({
            proceso_id:  newProcess._id,
            numero:      f.numero,
            nombre:      f.nombre,
            actividades: f.actividades.map(a => ({ ...a, completada: false })),
          }))
        );
      }
    }

    res.status(201).json({ process: newProcess, program });
  } catch (error) {
    console.error('Error creando proceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /processes/:id — actualizar proceso (fechas, fase_actual, offsets, etc.) */
processController.update = async (req, res) => {
  try {
    const process = await Process.findById(req.params.id);
    if (!process) return res.status(404).json({ error: 'Proceso no encontrado' });

    const {
      meses_inicio_antes_venc,
      meses_doc_par_antes_venc,
      meses_digitacion_antes_venc,
      meses_radicado_antes_venc,
    } = req.body;

    const cambiaOffsets =
      meses_inicio_antes_venc     !== undefined ||
      meses_doc_par_antes_venc    !== undefined ||
      meses_digitacion_antes_venc !== undefined ||
      meses_radicado_antes_venc   !== undefined;

    let updateData = { ...req.body };

    if (cambiaOffsets) {
      // Recalcular fechas a partir de la resolución vigente del programa
      const Program = require('../models/programs');
      const programa = await Program.findOne({ dep_code_programa: process.program_code });
      if (programa) {
        const sufijo = process.tipo_proceso.toLowerCase(); // 'rc' | 'av' | 'pm'
        const fecha_resolucion = programa[`fecha_resolucion_${sufijo}`];
        const duracion_res     = programa[`duracion_resolucion_${sufijo}`];
        const offsets = {
          meses_inicio_antes_venc:     meses_inicio_antes_venc     ?? process.meses_inicio_antes_venc,
          meses_doc_par_antes_venc:    meses_doc_par_antes_venc    ?? process.meses_doc_par_antes_venc,
          meses_digitacion_antes_venc: meses_digitacion_antes_venc ?? process.meses_digitacion_antes_venc,
          meses_radicado_antes_venc:   meses_radicado_antes_venc   ?? process.meses_radicado_antes_venc,
        };
        const fechas = calcularFechas(process.tipo_proceso, fecha_resolucion, duracion_res, offsets);
        updateData = { ...updateData, ...offsets, ...fechas };
      }
    }

    const updated = await Process.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ error: 'Proceso no encontrado' });

    // Auto-crear PM para AV al llegar a Fase 6 (cuando se avanza manualmente actividad a actividad)
    if (updateData.fase_actual === 6 && process.tipo_proceso === 'AV') {
      await crearPMAutomaticoParaAV(updated);
    }

    res.status(200).json(updated);
  } catch (error) {
    console.error('Error actualizando proceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* DELETE /processes/:id — eliminar proceso y sus fases */
processController.remove = async (req, res) => {
  try {
    const process = await Process.findByIdAndDelete(req.params.id);
    if (!process) return res.status(404).json({ error: 'Proceso no encontrado' });
    await Phase.deleteMany({ proceso_id: req.params.id });
    res.status(200).json({ message: 'Proceso y sus fases eliminados correctamente' });
  } catch (error) {
    console.error('Error eliminando proceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* POST /processes/:id/activate-pm — crea o recalcula un Plan de Mejoramiento ligado a RC/AV */
processController.activatePM = async (req, res) => {
  try {
    const parent = await Process.findById(req.params.id);
    if (!parent) return res.status(404).json({ error: 'Proceso padre no encontrado' });
    if (parent.tipo_proceso !== 'RC' && parent.tipo_proceso !== 'AV') {
      return res.status(400).json({ error: 'El Plan de Mejoramiento solo puede activarse desde procesos RC o AV' });
    }

    const Program = require('../models/programs');
    const programa = await Program.findOne({ dep_code_programa: parent.program_code });
    if (!programa) return res.status(404).json({ error: 'Programa asociado no encontrado' });

    const sufijo = parent.tipo_proceso.toLowerCase(); // 'rc' | 'av'
    const fecha_resolucion = programa[`fecha_resolucion_${sufijo}`];
    const duracion_res     = programa[`duracion_resolucion_${sufijo}`];
    if (!fecha_resolucion || duracion_res == null) {
      return res.status(400).json({ error: 'El proceso padre no tiene resolución vigente con duración configurada' });
    }

    // Buscar si ya existe un PM hijo ligado a ESTE proceso específico
    let pm = await Process.findOne({
      program_code: parent.program_code,
      tipo_proceso: 'PM',
      parent_process_id: parent._id,
    });

    // Meses configurables para el plan (si no se envían, usar defaults 5/6/6/0)
    const {
      meses_envio_plan,
      meses_entrega_cna,
      meses_envio_avance,
      meses_radicacion_avance,
      // Etiquetas editables para los nombres de las fechas del PM (RC)
      label_envio_pm_vicerrectoria,
      label_entrega_pm_cna,
      label_envio_avance_vicerrectoria,
      label_radicacion_avance_cna,
    } = req.body;

    const duracion_meses = Number(duracion_res) * 12;
    const mEnvioPlan    = Number.isFinite(Number(meses_envio_plan))    ? Number(meses_envio_plan)    : 5;
    const mEntregaCNA   = Number.isFinite(Number(meses_entrega_cna))   ? Number(meses_entrega_cna)   : 6;
    const mEnvioAvance  = Number.isFinite(Number(meses_envio_avance))  ? Number(meses_envio_avance)  : 6;
    const mRadicAvance  = Number.isFinite(Number(meses_radicacion_avance)) ? Number(meses_radicacion_avance) : 0;

    const fecha_envio_pm_vicerrectoria =
      siguienteDiaHabil(sumarMeses(fecha_resolucion, mEnvioPlan));
    const fecha_entrega_pm_cna =
      siguienteDiaHabil(sumarMeses(fecha_resolucion, mEntregaCNA));

    const mitad_meses = Math.round(duracion_meses / 2);
    const fecha_mitad = sumarMeses(fecha_resolucion, mitad_meses);
    const fecha_envio_avance_vicerrectoria =
      siguienteDiaHabil(sumarMeses(fecha_mitad, -mEnvioAvance));
    const fecha_radicacion_avance_cna =
      siguienteDiaHabil(sumarMeses(fecha_mitad, mRadicAvance));

    // Subtipo automático según el tipo del proceso padre
    const subtipoAutomatico = parent.tipo_proceso === 'RC'
      ? 'Autoevaluación Registro calificado'
      : 'Autoevaluación Acreditación';

    const pmData = {
      fecha_envio_pm_vicerrectoria,
      fecha_entrega_pm_cna,
      fecha_envio_avance_vicerrectoria,
      fecha_radicacion_avance_cna,
      // Guardar los meses de cálculo usados
      meses_envio_pm:          mEnvioPlan,
      meses_entrega_pm_cna:    mEntregaCNA,
      meses_envio_avance:      mEnvioAvance,
      meses_radicacion_avance: mRadicAvance,
      // Etiquetas personalizadas (null = usa el default del frontend)
      ...(label_envio_pm_vicerrectoria    !== undefined && { label_envio_pm_vicerrectoria }),
      ...(label_entrega_pm_cna            !== undefined && { label_entrega_pm_cna }),
      ...(label_envio_avance_vicerrectoria !== undefined && { label_envio_avance_vicerrectoria }),
      ...(label_radicacion_avance_cna     !== undefined && { label_radicacion_avance_cna }),
    };

    if (!pm) {
      // Crear nuevo proceso PM hijo con subtipo automático
      pm = await Process.create({
        name: `Plan de Mejoramiento - ${programa.nombre}`,
        program_code: parent.program_code,
        tipo_proceso: 'PM',
        parent_process_id: parent._id,
        parent_tipo_proceso: parent.tipo_proceso,
        subtipo: subtipoAutomatico,
        ...pmData,
      });

      // El PM no tiene fases — solo fechas
    } else {
      // Actualizar fechas, meses y etiquetas si ya existía
      pm = await Process.findByIdAndUpdate(
        pm._id,
        { $set: { ...pmData, subtipo: subtipoAutomatico } },
        { new: true, runValidators: true }
      );
    }

    res.status(200).json(pm);
  } catch (error) {
    console.error('Error activando Plan de Mejoramiento:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PATCH /processes/bulk-fases — actualiza fase_actual de varios procesos de una vez
   Body: [{ program_code, tipo_proceso, fase_actual, estado? }] */
processController.bulkFases = async (req, res) => {
  try {
    const items = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Se esperaba un array' });
    const resultados = [];
    for (const item of items) {
      const { program_code, tipo_proceso, fase_actual, estado } = item;
      const set = {};
      if (fase_actual !== undefined) set.fase_actual = fase_actual;
      if (estado     !== undefined) set.estado       = estado;
      const updated = await Process.findOneAndUpdate(
        { program_code, tipo_proceso },
        { $set: set },
        { new: true }
      );
      resultados.push({ program_code, tipo_proceso, ok: !!updated, fase_actual: updated?.fase_actual });
    }
    res.status(200).json(resultados);
  } catch (error) {
    console.error('Error en bulk-fases:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = processController;
module.exports.calcularFechas = calcularFechas;
