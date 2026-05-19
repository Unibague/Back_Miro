/**
 * crearPMAutomatico
 * Crea automáticamente un Plan de Mejoramiento ligado a un proceso AV o AE.
 *
 * - Para AV: se llama al CERRAR el proceso AV (desde processHistory.close).
 * - Para AE: se llama al CREAR el proceso AE (desde processes.create).
 *
 * El PM tendrá la fase "Plan de Mejoramiento" con sus actividades predefinidas,
 * además de las fechas calculadas a partir de la resolución del proceso padre.
 */

const Process      = require('../models/processes');
const Phase        = require('../models/phases');
const Program      = require('../models/programs');
const FASES_BASE_PM = require('./fasesBasePM');

function sumarMeses(fechaStr, meses) {
  if (!fechaStr || meses == null) return null;
  const d = new Date(fechaStr + 'T12:00:00');
  if (isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + meses);
  return d.toISOString().split('T')[0];
}

function siguienteDiaHabil(fechaStr) {
  if (!fechaStr) return null;
  const d = new Date(fechaStr + 'T12:00:00');
  const dow = d.getDay();
  if (dow === 6) d.setDate(d.getDate() + 2);
  if (dow === 0) d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

/**
 * Crea un proceso PM con su fase de actividades.
 * parentProcess debe ser de tipo AV o AE.
 * Si ya existe un PM activo ligado a este proceso, devuelve el existente.
 *
 * @param {Object} parentProcess - Documento Mongoose del proceso padre (AV o AE).
 * @param {Object} [options]
 * @param {string} [options.nombre_override]       - Nombre personalizado para el PM.
 * @param {string} [options.fecha_resolucion]      - Fecha de resolución del proceso (YYYY-MM-DD).
 * @param {number} [options.duracion_resolucion]   - Duración en años del proceso.
 * @returns {Promise<Object|null>} El proceso PM creado o existente.
 */
async function crearPMAutomatico(parentProcess, options = {}) {
  if (!parentProcess) return null;
  const tiposPadreValidos = ['AV', 'AE'];
  if (!tiposPadreValidos.includes(parentProcess.tipo_proceso)) return null;

  // Si ya existe un PM ligado a este proceso, devolver el existente
  const pmExistente = await Process.findOne({
    tipo_proceso: 'PM',
    parent_process_id: parentProcess._id,
  });
  if (pmExistente) return pmExistente;

  const { findProgramByProcessCode } = require('./programByCode');
  const programa = await findProgramByProcessCode(Program, parentProcess.program_code);
  if (!programa) return null;

  /* Fecha de resolución y duración del proceso padre:
     1. Dato explícito pasado al crear el PM (ej. frFinal del cierre del AV)
     2. snapshot guardado en el proceso padre
     3. Si solo hay fecha_vencimiento + duración, revertimos para obtener la fecha base */
  let fechaBase =
    options.fecha_resolucion
    ?? parentProcess.snapshot_fecha_resolucion
    ?? null;

  let durBase =
    options.duracion_resolucion != null
      ? Number(options.duracion_resolucion)
      : parentProcess.snapshot_duracion_anos != null
        ? Number(parentProcess.snapshot_duracion_anos)
        : null;

  if (!fechaBase && parentProcess.fecha_vencimiento && durBase != null) {
    const fv = new Date(parentProcess.fecha_vencimiento + 'T12:00:00');
    fv.setMonth(fv.getMonth() - Math.round(durBase * 12));
    fechaBase = fv.toISOString().split('T')[0];
  }

  let pmData = {};
  if (fechaBase && durBase != null) {
    const duracion_meses = Number(durBase) * 12;
    const mitad_meses    = Math.round(duracion_meses / 2);
    const fecha_mitad    = sumarMeses(fechaBase, mitad_meses);

    pmData = {
      fecha_envio_pm_vicerrectoria:     siguienteDiaHabil(sumarMeses(fechaBase, 5)),
      fecha_entrega_pm_cna:             siguienteDiaHabil(sumarMeses(fechaBase, 6)),
      fecha_envio_avance_vicerrectoria: siguienteDiaHabil(sumarMeses(fecha_mitad, -6)),
      fecha_radicacion_avance_cna:      siguienteDiaHabil(sumarMeses(fecha_mitad, 0)),
    };
  }

  const nombrePrograma = programa.nombre || programa.dep_code_programa;
  const nombre = options.nombre_override
    || `Plan de Mejoramiento - ${nombrePrograma}`;

  const subtipo = parentProcess.tipo_proceso === 'AV'
    ? 'Plan de Mejoramiento AV'
    : 'Plan de Mejoramiento AE';

  const pm = await Process.create({
    name:                nombre,
    program_code:        parentProcess.program_code,
    tipo_proceso:        'PM',
    parent_process_id:   parentProcess._id,
    parent_tipo_proceso: parentProcess.tipo_proceso,
    subtipo,
    fase_actual:         1,
    ...pmData,
  });

  // Crear la fase Plan de Mejoramiento con sus actividades
  await Phase.insertMany(
    FASES_BASE_PM.map(f => ({
      proceso_id:  pm._id,
      numero:      f.numero,
      nombre:      f.nombre,
      actividades: f.actividades.map(a => ({ ...a, completada: false })),
    }))
  );

  // Crear ALERTA para el PM — muestra las fechas clave del plan en la tabla de alertas
  // (fila naranja de aviso de fechas, distinta a la fila morada del proceso PM para gestión)
  try {
    await Process.create({
      name:              `Alerta (PM) — ${nombrePrograma}`,
      program_code:      pm.program_code,
      tipo_proceso:      'ALERTA',
      alert_para_tipo:   'PM',
      parent_process_id: pm._id,
      subtipo,
      fase_actual:       0,
      fecha_envio_pm_vicerrectoria:     pmData.fecha_envio_pm_vicerrectoria     ?? null,
      fecha_entrega_pm_cna:             pmData.fecha_entrega_pm_cna             ?? null,
      fecha_envio_avance_vicerrectoria: pmData.fecha_envio_avance_vicerrectoria ?? null,
      fecha_radicacion_avance_cna:      pmData.fecha_radicacion_avance_cna      ?? null,
    });
  } catch (alertErr) {
    console.error('[pmAutoCreate] No se pudo crear la ALERTA del PM:', alertErr?.message || alertErr);
    // No interrumpir: el PM ya fue creado; la alerta puede recrearse manualmente si falla.
  }

  return pm;
}

/** Alias de compatibilidad para código legado que llame crearPMAutomaticoParaAV */
async function crearPMAutomaticoParaAV(parentProcess) {
  return crearPMAutomatico(parentProcess);
}

module.exports = { crearPMAutomatico, crearPMAutomaticoParaAV };
