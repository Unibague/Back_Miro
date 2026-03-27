/**
 * crearPMAutomaticoParaAV
 * Crea automáticamente un Plan de Mejoramiento ligado a un proceso AV
 * cuando ese proceso llega a la Fase 6. Si ya existe uno ligado, no hace nada.
 * El PM no tiene fases — solo tiene fechas.
 */

const Process = require('../models/processes');
const Program = require('../models/programs');

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

async function crearPMAutomaticoParaAV(parentProcess) {
  if (!parentProcess || parentProcess.tipo_proceso !== 'AV') return null;

  // Si ya existe un PM ligado a este proceso, no hacer nada
  const pmExistente = await Process.findOne({
    tipo_proceso: 'PM',
    parent_process_id: parentProcess._id,
  });
  if (pmExistente) return pmExistente;

  // Obtener la resolución del programa para calcular fechas
  const programa = await Program.findOne({ dep_code_programa: parentProcess.program_code });
  if (!programa) return null;

  const fecha_resolucion = programa.fecha_resolucion_av;
  const duracion_res     = programa.duracion_resolucion_av;

  // Si no hay resolución configurada, crear el PM sin fechas (se calcularán después)
  let pmData = {};
  if (fecha_resolucion && duracion_res != null) {
    const duracion_meses = Number(duracion_res) * 12;
    const mitad_meses    = Math.round(duracion_meses / 2);
    const fecha_mitad    = sumarMeses(fecha_resolucion, mitad_meses);

    pmData = {
      fecha_envio_pm_vicerrectoria:     siguienteDiaHabil(sumarMeses(fecha_resolucion, 5)),
      fecha_entrega_pm_cna:             siguienteDiaHabil(sumarMeses(fecha_resolucion, 6)),
      fecha_envio_avance_vicerrectoria: siguienteDiaHabil(sumarMeses(fecha_mitad, -6)),
      fecha_radicacion_avance_cna:      siguienteDiaHabil(sumarMeses(fecha_mitad, 0)),
    };
  }

  // El PM solo se crea con fechas, sin fases ni actividades
  const pm = await Process.create({
    name:                `Plan de Mejoramiento - ${programa.nombre}`,
    program_code:        parentProcess.program_code,
    tipo_proceso:        'PM',
    parent_process_id:   parentProcess._id,
    parent_tipo_proceso: 'AV',
    subtipo:             'Autoevaluación Acreditación',
    ...pmData,
  });

  return pm;
}

module.exports = { crearPMAutomaticoParaAV };
