const Process          = require('../models/processes');
const mongoose         = require('mongoose');
const Phase            = require('../models/phases');
const FASES_BASE_RC    = require('../helpers/fasesBaseRC');
const FASES_BASE_AV    = require('../helpers/fasesBaseAV');
const FASES_BASE_AE    = require('../helpers/fasesBaseAE');
const FASES_BASE_PM    = require('../helpers/fasesBasePM');
const { crearPMAutomatico } = require('../helpers/pmAutoCreate');
const { siguienteDiaHabil } = require('../helpers/diasHabilesColombia');
const { findProgramByProcessCode } = require('../helpers/programByCode');

function getFasesParaTipo(tipo_proceso) {
  if (tipo_proceso === 'RC') return FASES_BASE_RC;
  if (tipo_proceso === 'AV') return FASES_BASE_AV;
  if (tipo_proceso === 'AE') return FASES_BASE_AE;
  if (tipo_proceso === 'PM') return FASES_BASE_PM;
  return [];
}

/* Suma N meses a una fecha YYYY-MM-DD y devuelve YYYY-MM-DD */
function sumarMeses(fechaStr, meses) {
  if (!fechaStr || meses == null) return null;
  const d = new Date(fechaStr + 'T12:00:00');
  if (isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + meses);
  return d.toISOString().split('T')[0];
}

/* Calcula las fechas del proceso a partir de la resolución vigente.
   - Para RC, AV y PM: la duración viene en AÑOS (se convierte a meses internamente).
   - Para fecha_vencimiento y fecha_radicado_men NO se ajustan fines de semana ni festivos.
   - Para inicio, documento par y digitación SACES: siguiente día hábil en Colombia (sin sáb/dom/festivos).

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
  if (tipo_proceso === 'AV' || tipo_proceso === 'AE') {
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
   - tipo_proceso:      'RC' | 'AV' | 'AE'
   - subtipo:           'Nuevo'|'Renovación'|'No renovación'|'Renovación + reforma'|'Reforma curricular'|'Reactivación'|'Registro calificado de oficio'  (RC)
                        'Nuevo'|'Renovación'|'No renovación'|'Reactivación'                                                   (AV)
                        'Autoevaluación'                                                                   (AE)
   - Registro calificado de oficio (RC): fecha_resolucion, codigo_resolucion obligatorios; duracion_resolucion forzada a 7 años;
     autocalcula fechas del proceso; crea ALERTA RC (recordatorio + resolución vigente) y actualiza ultimo_rc en el programa.
   - program_code:      id Mongo del programa (`_id` en string), o legado: dep_code_programa (solo resolución)
   - program_data:      datos del programa a crear  (solo RC Nuevo)
   - fecha_resolucion:  YYYY-MM-DD  (subtipos con resolución)
   - codigo_resolucion: string      (subtipos con resolución)
   - duracion_resolucion: number en años (subtipos con resolución)
   - linked_process_id:  ID de proceso RC/AV al que se vincula (solo AE, opcional)
   - linked_process_tipo: 'RC'|'AV' (solo AE, opcional)
   - copiar_resolucion_desde_process_id: ObjectId del proceso ALERTA; copia PDF(s) de resolución a la creación sin re-subir archivo
   - consumir_alerta_process_id: ObjectId de la fila ALERTA a cerrar al crear (obligatorio si ya existe alerta del mismo tipo para el programa; p. ej. renovación desde recordatorio)

   Regla RC: como máximo un proceso RC activo por program_code (cualquier subtipo, incluye reforma curricular).
*/
processController.create = async (req, res) => {
  try {
    const {
      tipo_proceso,
      subtipo: subtipoBody,
      program_code: existingProgramCode,
      program_data,
      fecha_resolucion,
      codigo_resolucion,
      duracion_resolucion,
      av_espera_rc_oficio,
      linked_process_id,
      linked_process_tipo,
      copiar_resolucion_desde_process_id,
      consumir_alerta_process_id,
    } = req.body;

    /* Normalizar subtipo (espacios en el cliente rompen comparaciones estrictas con «Reforma curricular», etc.) */
    let subtipo = subtipoBody;
    if (subtipo != null) {
      const t = String(subtipo).trim();
      subtipo = t === '' ? undefined : t;
    }
    /* Compatibilidad: acreditación antigua «Primera vez» → mismo criterio que RC «Nuevo» */
    if (tipo_proceso === 'AV' && subtipo === 'Primera vez') {
      subtipo = 'Nuevo';
    }
    if (tipo_proceso === 'RC' && String(subtipo ?? '').trim() === 'Vigencia transitoria') {
      return res.status(400).json({
        error:
          'El subtipo «Vigencia transitoria» no se crea como proceso: lo genera el sistema al cerrar una acreditación cuando el RC de oficio aún no ha sido entregado.',
      });
    }
    /* AE sin subtipo → «Autoevaluación» */
    if (tipo_proceso === 'AE' && !subtipo) {
      subtipo = 'Autoevaluación';
    }

    const Program = require('../models/programs');
    let program = null;

    /* ── 1. Obtener o crear el programa ── */
    const creaProgramaDesdeCuerpo =
      program_data &&
      subtipo === 'Nuevo' &&
      (tipo_proceso === 'RC' || tipo_proceso === 'AV' || tipo_proceso === 'AE');

    if (creaProgramaDesdeCuerpo) {
      let pd = { ...program_data };
      if (pd.dep_code_programa != null) {
        const trimmed = String(pd.dep_code_programa).trim();
        pd.dep_code_programa = trimmed || null;
      }
      program = await Program.create(pd);
    } else if (existingProgramCode) {
      program = await findProgramByProcessCode(Program, existingProgramCode);
      if (!program) {
        return res.status(404).json({
          error: 'Programa no encontrado para el id o código indicado.',
        });
      }
    }

    if (!program) {
      return res.status(400).json({
        error: 'Se requiere program_code (id Mongo del programa) o program_data (RC/AV/AE Nuevo creando programa)',
      });
    }

    /** Todos los procesos usan `program_code` = `_id` del programa (dato de enlace; no código institucional). */
    const program_code = String(program._id);

    const consumirAlertaId =
      consumir_alerta_process_id != null
      && mongoose.isValidObjectId(String(consumir_alerta_process_id).trim())
        ? String(consumir_alerta_process_id).trim()
        : null;

    const esRcReformaCurricularSolo =
      tipo_proceso === 'RC' && subtipo === 'Reforma curricular';
    const esRcNoRenovCreacion = tipo_proceso === 'RC' && subtipo === 'No renovación';
    const esAvNoRenovCreacion = tipo_proceso === 'AV' && subtipo === 'No renovación';
    const skipAlertaConsumir = esRcReformaCurricularSolo || esRcNoRenovCreacion || esAvNoRenovCreacion;

    const subtiposRcExigenConsumoSiHayAlerta = new Set([
      'Renovación', 'Renovación + reforma', 'Registro calificado de oficio', 'Reactivación',
    ]);
    const exigeConsumoRc = tipo_proceso === 'RC' && subtipo && subtiposRcExigenConsumoSiHayAlerta.has(subtipo);
    if (exigeConsumoRc && !skipAlertaConsumir) {
      const hayAlertaRc = await Process.exists({
        program_code,
        tipo_proceso: 'ALERTA',
        alert_para_tipo: 'RC',
      });
      if (hayAlertaRc && !consumirAlertaId) {
        return res.status(409).json({
          error:
            'Hay una alerta de Registro Calificado pendiente en este programa. Crea el proceso desde el recordatorio o la alerta; no uses «Agregar proceso» en la barra sin enlazarla.',
        });
      }
    }
    if (
      !skipAlertaConsumir
      && tipo_proceso === 'AV'
      && await Process.exists({ program_code, tipo_proceso: 'ALERTA', alert_para_tipo: 'AV' })
      && !consumirAlertaId
    ) {
      return res.status(409).json({
        error:
          'Hay una alerta de Acreditación Voluntaria pendiente. Crea el proceso desde el recordatorio o la alerta correspondiente.',
      });
    }

    if (consumirAlertaId && skipAlertaConsumir) {
      return res.status(400).json({
        error:
          'Este subtipo no debe enviar consumir_alerta_process_id (no consume alertas en este flujo).',
      });
    }

    /* ── 2. Resolver resolución (body, alerta implícita o vigente en programa) ── */
    function resolucionDesdeProgramaRc(prog) {
      if (!prog) return null;
      const ult = prog.ultimo_rc;
      const fr = ult?.fecha_resolucion ?? prog.fecha_resolucion_rc;
      const cod = ult?.codigo_resolucion ?? prog.codigo_resolucion_rc;
      const durRaw = ult?.duracion_resolucion ?? prog.duracion_resolucion_rc;
      const dur = durRaw != null && !Number.isNaN(Number(durRaw)) ? Number(durRaw) : null;
      if (fr && cod != null && String(cod).trim() !== '' && dur != null) {
        return {
          fecha_resolucion: fr,
          codigo_resolucion: String(cod).trim(),
          duracion_resolucion: dur,
        };
      }
      return null;
    }

    let fechaResolucionUse = fecha_resolucion;
    let codigoResolucionUse = codigo_resolucion;
    let duracionResolucionUse = duracion_resolucion;
    if (
      (subtipo === 'Renovación' || subtipo === 'Renovación + reforma')
      && (!fechaResolucionUse || !codigoResolucionUse || duracionResolucionUse == null)
      && program
    ) {
      const rp = resolucionDesdeProgramaRc(program);
      if (rp) {
        fechaResolucionUse = rp.fecha_resolucion;
        codigoResolucionUse = rp.codigo_resolucion;
        duracionResolucionUse = rp.duracion_resolucion;
      }
    }

    if (tipo_proceso === 'RC' && subtipo === 'Registro calificado de oficio') {
      duracionResolucionUse = 7;
      if (!fechaResolucionUse || !codigoResolucionUse || String(codigoResolucionUse).trim() === '') {
        return res.status(400).json({
          error:
            'Registro calificado de oficio requiere fecha_resolucion y codigo_resolucion. La vigencia es siempre 7 años.',
        });
      }
      codigoResolucionUse = String(codigoResolucionUse).trim();
    }

    const tieneResolucion = !!(fechaResolucionUse && codigoResolucionUse && duracionResolucionUse != null);

    if (subtipo === 'Renovación + reforma' && !tieneResolucion) {
      return res.status(400).json({
        error:
          'Renovación + reforma requiere resolución vigente en el programa o crear el proceso desde una alerta (con fecha, código y años de vigencia).',
      });
    }
    if (tieneResolucion && program && subtipo !== 'Reforma curricular') {
      const sufijo = tipo_proceso === 'AE' ? 'ae' : tipo_proceso.toLowerCase(); // 'rc' | 'av' | 'ae'
      program = await Program.findByIdAndUpdate(
        program._id,
        {
          [`fecha_resolucion_${sufijo}`]:    fechaResolucionUse,
          [`codigo_resolucion_${sufijo}`]:   codigoResolucionUse,
          [`duracion_resolucion_${sufijo}`]: Number(duracionResolucionUse),
        },
        { new: true }
      );
    }

    let eraPostAvGraciaRcOficio = false;
    let rcGraciaVigenteSnapshot = null;
    if (tipo_proceso === 'RC' && subtipo === 'Registro calificado de oficio' && tieneResolucion && program) {
      eraPostAvGraciaRcOficio = !!program.av_rc_oficio_pendiente;
      if (eraPostAvGraciaRcOficio && program.ultimo_rc) {
        const ur = program.ultimo_rc;
        rcGraciaVigenteSnapshot = {
          codigo_resolucion:   ur.codigo_resolucion ?? null,
          fecha_resolucion:    ur.fecha_resolucion ?? null,
          fecha_vencimiento:   ur.fecha_vencimiento ?? null,
          duracion_resolucion: ur.duracion_resolucion ?? null,
          link_documento:      ur.link_documento ?? null,
        };
      }
    }

    /* ── 3. Calcular fechas según subtipo ── */
    const defaultOffsets = (tipo_proceso === 'AV' || tipo_proceso === 'AE')
      ? { meses_inicio_antes_venc: 33, meses_doc_par_antes_venc: 16, meses_digitacion_antes_venc: 15, meses_radicado_antes_venc: 12 }
      : { meses_inicio_antes_venc: 29, meses_doc_par_antes_venc: 17, meses_digitacion_antes_venc: 15, meses_radicado_antes_venc: 12 };

    let fechasCalculadas = {};
    let fase_actual_inicial = 0;

    if ((subtipo === 'Renovación' || subtipo === 'Renovación + reforma') && tieneResolucion) {
      // Auto-calcula todas las fechas desde la resolución vigente
      fechasCalculadas = {
        ...calcularFechas(tipo_proceso, fechaResolucionUse, duracionResolucionUse, defaultOffsets),
        ...defaultOffsets,
      };
    } else if (subtipo === 'No renovación' && tieneResolucion) {
      // RC: vencimiento + fechas del trámite (inicio, doc. par, digitación, radicado); fase 7 permanente.
      // AV no renovación: solo vencimiento (sin esas fechas de trámite).
      if (tipo_proceso === 'RC') {
        fechasCalculadas = {
          ...calcularFechas(tipo_proceso, fechaResolucionUse, duracionResolucionUse, defaultOffsets),
          ...defaultOffsets,
        };
      } else {
        const vencimiento = sumarMeses(fechaResolucionUse, Number(duracionResolucionUse) * 12);
        fechasCalculadas = { fecha_vencimiento: vencimiento };
      }
      fase_actual_inicial = 7;
    } else if (subtipo === 'Reforma curricular') {
      // Reforma interna: fechas en blanco; se completan manualmente en la gestión del proceso
      fechasCalculadas = { ...defaultOffsets };
    } else if (tipo_proceso === 'RC' && subtipo === 'Registro calificado de oficio' && tieneResolucion) {
      if (eraPostAvGraciaRcOficio) {
        /* Sin calendario de trámite en el proceso: solo confirmación al crear y cierre liviano. */
        fechasCalculadas = {};
      } else {
        fechasCalculadas = {
          ...calcularFechas(tipo_proceso, fechaResolucionUse, duracionResolucionUse, defaultOffsets),
          ...defaultOffsets,
        };
      }
    } else if (subtipo === 'Reactivación') {
      // Igual que Nuevo: sin resolución al crear; fases 0–5 y fechas se completan en gestión / al cierre.
      fechasCalculadas = {};
      fase_actual_inicial = 0;
    }
    // RC/AV 'Nuevo': sin resolución ni fechas

    if (tipo_proceso === 'RC' && subtipo === 'Registro calificado de oficio' && tieneResolucion) {
      const fv = eraPostAvGraciaRcOficio
        ? (sumarMeses(fechaResolucionUse, Number(duracionResolucionUse) * 12) ?? null)
        : (fechasCalculadas.fecha_vencimiento ?? null);
      await Program.findByIdAndUpdate(program._id, {
        $set: {
          ultimo_rc: {
            codigo_resolucion: String(codigoResolucionUse).trim(),
            fecha_resolucion: fechaResolucionUse,
            duracion_resolucion: Number(duracionResolucionUse),
            fecha_vencimiento: fv,
            link_documento: null,
          },
          av_rc_oficio_pendiente: false,
        },
      });
      try {
        const { actualizarVigenciaPrograma } = require('../helpers/cronVigencia');
        await actualizarVigenciaPrograma(program._id);
      } catch (e) {
        console.warn('[processes.create] RC oficio actualizarVigenciaPrograma:', e?.message || e);
      }
    }

    /* ── 4. Nombre del proceso ── */
    if (tipo_proceso === 'RC' && subtipo === 'Reactivación') {
      if (!program) {
        return res.status(404).json({ error: 'Programa no encontrado para el código indicado.' });
      }
      if (program.estado !== 'Inactivo') {
        return res.status(400).json({
          error: 'La reactivación de registro calificado solo aplica a programas en estado Inactivo (p. ej. tras una no renovación).',
        });
      }
    }

    const nombrePrograma = program?.nombre ?? program_code;
    const subtipoBracket = subtipo ? ` (${subtipo})` : '';
    const labelTipo = tipo_proceso === 'RC' ? 'Registro Calificado'
                    : tipo_proceso === 'AV' ? 'Acreditación Voluntaria'
                    : tipo_proceso === 'AE' ? 'Autoevaluación'
                    : 'PM';
    const name = `${labelTipo}${subtipoBracket} - ${nombrePrograma}`;

    /* Un solo RC activo por programa (incluye reforma curricular, renovación, etc.) */
    if (tipo_proceso === 'RC') {
      const rcExistente = await Process.findOne({ program_code, tipo_proceso: 'RC' }).select('_id').lean();
      if (rcExistente) {
        return res.status(409).json({
          error:
            'Este programa ya tiene un proceso de Registro Calificado activo. Ciérralo antes de crear otro (incluye reforma curricular u otro subtipo).',
        });
      }
    }

    /* ── 5. Crear el proceso ── */
    const newProcess = await Process.create({
      name,
      program_code,
      tipo_proceso,
      subtipo: subtipo || null,
      fase_actual: fase_actual_inicial,
      av_espera_rc_oficio: tipo_proceso === 'AV' ? !!av_espera_rc_oficio : false,
      ...(eraPostAvGraciaRcOficio ? {
        rc_oficio_contexto: 'post_av_gracia',
        rc_gracia_vigente_snapshot: rcGraciaVigenteSnapshot,
      } : {}),
      // Solo AE: vinculación informativa a un proceso RC/AV existente
      ...(tipo_proceso === 'AE' && linked_process_id ? {
        linked_process_id,
        linked_process_tipo: linked_process_tipo || null,
      } : {}),
      ...fechasCalculadas,
    });

    /* ── 5b — Opcional: reutilizar PDF de resolución desde la alerta (o desde el historial del cierre)
        Debe ejecutarse ANTES de borrar la fila ALERTA. */
    if (
      copiar_resolucion_desde_process_id
      && mongoose.isValidObjectId(String(copiar_resolucion_desde_process_id))
      && ['RC', 'AV', 'AE'].includes(tipo_proceso)
    ) {
      const ProcessDocument = require('../models/processDocuments');
      const ProcessHistory = require('../models/processHistory');

      const crearDesdePlantilla = (orig) =>
        ProcessDocument.create({
          phase_id: null,
          process_id: newProcess._id,
          doc_type: 'resolucion',
          name: orig.name || 'Resolución',
          drive_id: orig.drive_id ?? null,
          view_link: orig.view_link ?? null,
          download_link: orig.download_link ?? null,
          mime_type: orig.mime_type || 'application/pdf',
          size: orig.size ?? null,
        });

      const desdeProcId = String(copiar_resolucion_desde_process_id).trim();
      const docsAlerta = await ProcessDocument.find({
        process_id: desdeProcId,
        doc_type: { $in: ['resolucion', 'resolucion_rc_oficio'] },
      }).lean();

      try {
        if (docsAlerta.length > 0) {
          for (const o of docsAlerta) {
            if (o.view_link || o.drive_id) await crearDesdePlantilla(o);
          }
        } else {
          const procAlerta = await Process.findById(desdeProcId).select('cerrado_process_history_id').lean();
          const histId = procAlerta?.cerrado_process_history_id;
          if (histId) {
            const hist = await ProcessHistory.findById(histId).select('documentos_proceso').lean();
            const snaps = Array.isArray(hist?.documentos_proceso) ? hist.documentos_proceso : [];
            const primeroConLink = snaps.find((s) => s.view_link || s.drive_id);
            if (primeroConLink) await crearDesdePlantilla(primeroConLink);
          }
        }
      } catch (copiaErr) {
        console.error('[processes.create] No se pudo copiar PDF de resolución desde alerta:', copiaErr?.message || copiaErr);
      }
    }

    if (consumirAlertaId) {
      const ap = await Process.findOne({
        _id: consumirAlertaId,
        program_code,
        tipo_proceso: 'ALERTA',
      }).lean();
      if (!ap || String(ap.alert_para_tipo || '') !== String(tipo_proceso)) {
        return res.status(400).json({
          error:
            'consumir_alerta_process_id debe ser el _id de una alerta de este programa y del mismo tipo de proceso (RC, AV o AE) que estás creando.',
        });
      }
      await Process.deleteOne({ _id: consumirAlertaId, program_code, tipo_proceso: 'ALERTA' });
    }

    const esRcDeOficio = subtipo === 'Registro calificado de oficio' && tipo_proceso === 'RC';
    /* ── 6. Crear fases (excepto Fase 7; RC de oficio: una fase 0 vacía para la UI) ── */
    if (fase_actual_inicial !== 7) {
      if (esRcDeOficio) {
        await Phase.insertMany([{
          proceso_id: newProcess._id,
          numero: 0,
          nombre: 'Registro calificado de oficio',
          actividades: [],
        }]);
      } else {
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
    }

    if (esRcDeOficio && tieneResolucion) {
      const nombreProgramaAlert = program.nombre ?? program_code;
      const fechasR = calcularFechas('RC', fechaResolucionUse, duracionResolucionUse, defaultOffsets) || {};
      await Process.create({
        name: `Alerta (RC) — ${nombreProgramaAlert}`,
        program_code,
        tipo_proceso: 'ALERTA',
        alert_para_tipo: 'RC',
        cerrado_process_history_id: null,
        subtipo: 'Registro calificado de oficio',
        snapshot_codigo_resolucion: String(codigoResolucionUse).trim(),
        snapshot_fecha_resolucion: fechaResolucionUse,
        snapshot_duracion_anos: Number(duracionResolucionUse),
        fase_actual: 0,
        fecha_vencimiento: fechasR.fecha_vencimiento ?? fechasCalculadas.fecha_vencimiento ?? null,
        fecha_inicio: fechasR.fecha_inicio ?? fechasCalculadas.fecha_inicio ?? null,
        fecha_documento_par: fechasR.fecha_documento_par ?? fechasCalculadas.fecha_documento_par ?? null,
        fecha_digitacion_saces: fechasR.fecha_digitacion_saces ?? fechasCalculadas.fecha_digitacion_saces ?? null,
        fecha_radicado_men: fechasR.fecha_radicado_men ?? fechasCalculadas.fecha_radicado_men ?? null,
        obs_vencimiento: '',
        obs_inicio: '',
        obs_documento_par: '',
        obs_digitacion_saces: '',
        obs_radicado_men: '',
        meses_inicio_antes_venc: fechasCalculadas.meses_inicio_antes_venc ?? defaultOffsets.meses_inicio_antes_venc,
        meses_doc_par_antes_venc: fechasCalculadas.meses_doc_par_antes_venc ?? defaultOffsets.meses_doc_par_antes_venc,
        meses_digitacion_antes_venc:
          fechasCalculadas.meses_digitacion_antes_venc ?? defaultOffsets.meses_digitacion_antes_venc,
        meses_radicado_antes_venc:
          fechasCalculadas.meses_radicado_antes_venc ?? defaultOffsets.meses_radicado_antes_venc,
      });
      const { syncRcOficioResolucionDocsToAlert } = require('../helpers/syncRcOficioAlertDocs');
      await syncRcOficioResolucionDocsToAlert(program_code);
    }

    /* ── 7. Si es AE, crear automáticamente el PM ligado ── */
    let pmCreado = null;
    if (tipo_proceso === 'AE') {
      pmCreado = await crearPMAutomatico(newProcess);
    }

    res.status(201).json({ process: newProcess, program, pm: pmCreado ?? undefined });
  } catch (error) {
    console.error('Error creando proceso:', error);
    if (error?.code === 11000) {
      return res.status(409).json({ error: 'Ese código de programa ya existe. Usa otro código o deja vacío para generar uno nuevo.' });
    }
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
      const programa = await findProgramByProcessCode(Program, process.program_code);
      if (programa) {
        const sufijo = process.tipo_proceso === 'AE' ? 'ae' : process.tipo_proceso.toLowerCase();
        const fecha_resolucion = programa[`fecha_resolucion_${sufijo}`];
        const duracion_res     = programa[`duracion_resolucion_${sufijo}`];
        const offsets = {
          meses_inicio_antes_venc:     meses_inicio_antes_venc     ?? process.meses_inicio_antes_venc,
          meses_doc_par_antes_venc:    meses_doc_par_antes_venc    ?? process.meses_doc_par_antes_venc,
          meses_digitacion_antes_venc: meses_digitacion_antes_venc ?? process.meses_digitacion_antes_venc,
          meses_radicado_antes_venc:   meses_radicado_antes_venc   ?? process.meses_radicado_antes_venc,
        };
        if (process.tipo_proceso === 'RC' && String(process.subtipo ?? '').trim() === 'Reforma curricular') {
          let vencimiento = process.fecha_vencimiento;
          if (fecha_resolucion != null && duracion_res != null) {
            const computed = sumarMeses(fecha_resolucion, Number(duracion_res) * 12);
            if (computed) vencimiento = computed;
          }
          const mr =
            offsets.meses_radicado_antes_venc
            ?? getDefaultOffsets(process.tipo_proceso).meses_radicado_antes_venc;
          const fecha_radicado_men = vencimiento ? sumarMeses(vencimiento, -mr) : null;
          updateData = {
            ...updateData,
            ...offsets,
            fecha_vencimiento: vencimiento ?? process.fecha_vencimiento,
            ...(fecha_radicado_men ? { fecha_radicado_men } : {}),
          };
        } else {
          const fechas = calcularFechas(process.tipo_proceso, fecha_resolucion, duracion_res, offsets);
          updateData = { ...updateData, ...offsets, ...fechas };
        }
      }
    }

    const updated = await Process.findByIdAndUpdate(req.params.id, updateData, { new: true, runValidators: true });
    if (!updated) return res.status(404).json({ error: 'Proceso no encontrado' });

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

/* POST /processes/:id/activate-pm — crea o recalcula un Plan de Mejoramiento ligado a AV/AE */
processController.activatePM = async (req, res) => {
  try {
    const parent = await Process.findById(req.params.id);
    if (!parent) return res.status(404).json({ error: 'Proceso padre no encontrado' });
    if (!['AV', 'AE'].includes(parent.tipo_proceso)) {
      return res.status(400).json({ error: 'El Plan de Mejoramiento solo puede activarse desde procesos AV o AE' });
    }

    const Program = require('../models/programs');
    const programa = await findProgramByProcessCode(Program, parent.program_code);
    if (!programa) return res.status(404).json({ error: 'Programa asociado no encontrado' });

    const sufijo = parent.tipo_proceso.toLowerCase(); // 'rc' | 'av'
    const fecha_resolucion = programa[`fecha_resolucion_${sufijo}`];
    const duracion_res     = programa[`duracion_resolucion_${sufijo}`];
    const tieneResolucion  = !!(fecha_resolucion && duracion_res != null);

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

    const mEnvioPlan    = Number.isFinite(Number(meses_envio_plan))    ? Number(meses_envio_plan)    : 5;
    const mEntregaCNA   = Number.isFinite(Number(meses_entrega_cna))   ? Number(meses_entrega_cna)   : 6;
    const mEnvioAvance  = Number.isFinite(Number(meses_envio_avance))  ? Number(meses_envio_avance)  : 6;
    const mRadicAvance  = Number.isFinite(Number(meses_radicacion_avance)) ? Number(meses_radicacion_avance) : 0;

    /** Sin resolución en el programa (p. ej. RC Nuevo): PM con fechas en blanco; se recalculan al registrar resolución y guardar de nuevo. */
    let fecha_envio_pm_vicerrectoria = null;
    let fecha_entrega_pm_cna = null;
    let fecha_envio_avance_vicerrectoria = null;
    let fecha_radicacion_avance_cna = null;

    if (tieneResolucion) {
      const duracion_meses = Number(duracion_res) * 12;
      fecha_envio_pm_vicerrectoria =
        siguienteDiaHabil(sumarMeses(fecha_resolucion, mEnvioPlan));
      fecha_entrega_pm_cna =
        siguienteDiaHabil(sumarMeses(fecha_resolucion, mEntregaCNA));

      const mitad_meses = Math.round(duracion_meses / 2);
      const fecha_mitad = sumarMeses(fecha_resolucion, mitad_meses);
      fecha_envio_avance_vicerrectoria =
        siguienteDiaHabil(sumarMeses(fecha_mitad, -mEnvioAvance));
      fecha_radicacion_avance_cna =
        siguienteDiaHabil(sumarMeses(fecha_mitad, mRadicAvance));
    }

    // Subtipo automático según el tipo del proceso padre
    const subtipoAutomatico = parent.tipo_proceso === 'AE'
      ? 'Plan de Mejoramiento AE'
      : 'Plan de Mejoramiento AV';

    const fechasPm = tieneResolucion || !pm
      ? {
          fecha_envio_pm_vicerrectoria,
          fecha_entrega_pm_cna,
          fecha_envio_avance_vicerrectoria,
          fecha_radicacion_avance_cna,
        }
      : {};

    const pmData = {
      ...fechasPm,
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
        fase_actual: 1,
        ...pmData,
      });

      // Crear la fase "Plan de Mejoramiento" con sus actividades
      await Phase.insertMany(
        FASES_BASE_PM.map(f => ({
          proceso_id:  pm._id,
          numero:      f.numero,
          nombre:      f.nombre,
          actividades: f.actividades.map(a => ({ ...a, completada: false })),
        }))
      );
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

/* POST /processes/:id/repair-pm-alert
   Crea (o recrea) la ALERTA ligada a un proceso PM si no existe, recalculando sus fechas.
   Útil para PMs creados antes de que se implementara la ALERTA automática. */
processController.repairPMAlert = async (req, res) => {
  try {
    const pm = await Process.findById(req.params.id);
    if (!pm) return res.status(404).json({ error: 'Proceso PM no encontrado' });
    if (pm.tipo_proceso !== 'PM') return res.status(400).json({ error: 'Solo aplica a procesos PM' });

    const Program = require('../models/programs');
    const programa = await findProgramByProcessCode(Program, pm.program_code);
    if (!programa) return res.status(404).json({ error: 'Programa no encontrado' });

    // Eliminar ALERTA existente del PM (si la hay) y recrearla
    await Process.deleteMany({ tipo_proceso: 'ALERTA', alert_para_tipo: 'PM', parent_process_id: pm._id });

    const nombrePrograma = programa.nombre || pm.program_code;

    // Recalcular fechas desde la resolución del padre (AV: av, AE: rc)
    const sufijo = pm.parent_tipo_proceso === 'AV' ? 'av' : 'rc';
    const fecha_resolucion = programa[`fecha_resolucion_${sufijo}`] ?? programa.fecha_resolucion_av ?? null;
    const duracion_res = programa[`duracion_resolucion_${sufijo}`] ?? programa.duracion_resolucion_av ?? null;

    let pmData = {
      fecha_envio_pm_vicerrectoria:     pm.fecha_envio_pm_vicerrectoria ?? null,
      fecha_entrega_pm_cna:             pm.fecha_entrega_pm_cna ?? null,
      fecha_envio_avance_vicerrectoria: pm.fecha_envio_avance_vicerrectoria ?? null,
      fecha_radicacion_avance_cna:      pm.fecha_radicacion_avance_cna ?? null,
    };

    // Si el PM no tiene fechas pero el programa sí tiene resolución, recalcular
    const sinFechas = !pm.fecha_envio_pm_vicerrectoria && !pm.fecha_entrega_pm_cna;
    if (sinFechas && fecha_resolucion && duracion_res != null) {
      const duracion_meses = Number(duracion_res) * 12;
      const mitad_meses = Math.round(duracion_meses / 2);
      const fecha_mitad = siguienteDiaHabil(sumarMeses(fecha_resolucion, mitad_meses));
      pmData = {
        fecha_envio_pm_vicerrectoria:     siguienteDiaHabil(sumarMeses(fecha_resolucion, 5)),
        fecha_entrega_pm_cna:             siguienteDiaHabil(sumarMeses(fecha_resolucion, 6)),
        fecha_envio_avance_vicerrectoria: siguienteDiaHabil(sumarMeses(fecha_mitad, -6)),
        fecha_radicacion_avance_cna:      siguienteDiaHabil(sumarMeses(fecha_mitad, 0)),
      };
      // También actualizar el PM con las fechas recalculadas
      await Process.findByIdAndUpdate(pm._id, { $set: pmData });
    }

    const alerta = await Process.create({
      name:              `Alerta (PM) — ${nombrePrograma}`,
      program_code:      pm.program_code,
      tipo_proceso:      'ALERTA',
      alert_para_tipo:   'PM',
      parent_process_id: pm._id,
      subtipo:           pm.subtipo ?? null,
      fase_actual:       0,
      ...pmData,
    });

    res.status(200).json({ message: 'ALERTA del PM reparada', alerta });
  } catch (error) {
    console.error('Error en repair-pm-alert:', error);
    res.status(500).json({ error: 'Error al reparar la ALERTA del PM', detalle: error?.message });
  }
};

module.exports = processController;
module.exports.calcularFechas = calcularFechas;
