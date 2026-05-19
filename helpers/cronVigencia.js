/**
 * cronVigencia.js
 *
 * Actualiza tiene_rc_vigente / tiene_av_vigente comparando la fecha de vencimiento
 * (ultimo_rc / ultimo_av o legado + cálculo) con el día calendario local.
 * Si Program.av_rc_oficio_pendiente es true, fuerza tiene_rc_vigente hasta registrar el RC de oficio.
 */

const cron = require('node-cron');
const Program = require('../models/programs');

function hoyYMDLocal() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function sumarMeses(fechaStr, meses) {
  if (!fechaStr || meses == null || Number.isNaN(Number(meses))) return null;
  const d = new Date(String(fechaStr).slice(0, 10) + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + Number(meses));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Igual que la ficha Miró: vencimiento en ultimo_*; si no, resolución + vigencia (años → meses).
 * Usa ultimo_*.fecha_resolucion / duracion, no solo campos planos legacy.
 */
function fechaVencimientoDesdeUltimo(ultimo, fechaResolucionFallback, duracionFallback) {
  const guardada = ultimo?.fecha_vencimiento;
  if (guardada && String(guardada).slice(0, 10).length >= 10) {
    return String(guardada).slice(0, 10);
  }
  const fr =
    (ultimo?.fecha_resolucion ? String(ultimo.fecha_resolucion).slice(0, 10) : null)
    ?? (fechaResolucionFallback ? String(fechaResolucionFallback).slice(0, 10) : null);
  const dur =
    ultimo?.duracion_resolucion != null ? ultimo.duracion_resolucion : duracionFallback;
  if (!fr || dur == null || Number.isNaN(Number(dur))) return null;
  return sumarMeses(fr, Number(dur) * 12);
}

function fechaVencimientoPrograma(p, tipo) {
  const ult = tipo === 'RC' ? p.ultimo_rc : p.ultimo_av;
  const fechaFallback = tipo === 'RC' ? p.fecha_resolucion_rc : p.fecha_resolucion_av;
  const durFallback = tipo === 'RC' ? p.duracion_resolucion_rc : p.duracion_resolucion_av;
  return fechaVencimientoDesdeUltimo(ult, fechaFallback, durFallback);
}

function vigenciaActivaDesdeVencimiento(vencYMD) {
  if (!vencYMD) return false;
  return vencYMD >= hoyYMDLocal();
}

/** Recalcula flags de vigencia de un solo programa (p. ej. tras cerrar un proceso). */
async function actualizarVigenciaPrograma(programId) {
  const p = await Program.findById(programId).lean();
  if (!p) return;
  const rcVenc = fechaVencimientoPrograma(p, 'RC');
  const avVenc = fechaVencimientoPrograma(p, 'AV');
  let rcVig = vigenciaActivaDesdeVencimiento(rcVenc);
  if (p.av_rc_oficio_pendiente) rcVig = true;
  const avVig = vigenciaActivaDesdeVencimiento(avVenc);

  await Program.findByIdAndUpdate(programId, {
    $set: {
      tiene_rc_vigente: rcVig,
      tiene_av_vigente: avVig,
    },
  });
}

async function actualizarVigencias() {
  const hoyStr = hoyYMDLocal();
  const programas = await Program.find({}).lean();
  const ops = programas.map((p) => {
    const rcVenc = fechaVencimientoPrograma(p, 'RC');
    const avVenc = fechaVencimientoPrograma(p, 'AV');
    let rcVig = Boolean(rcVenc && rcVenc >= hoyStr);
    if (p.av_rc_oficio_pendiente) rcVig = true;
    const avVig = Boolean(avVenc && avVenc >= hoyStr);

    return {
      updateOne: {
        filter: { _id: p._id },
        update: { $set: { tiene_rc_vigente: rcVig, tiene_av_vigente: avVig } },
      },
    };
  });

  if (ops.length > 0) {
    await Program.bulkWrite(ops);
    console.log(`[cronVigencia] ${new Date().toISOString()} — ${ops.length} programa(s) actualizados.`);
  }
}

function iniciarCronVigencia() {
  cron.schedule('0 0 * * *', async () => {
    try {
      await actualizarVigencias();
    } catch (e) {
      console.error('[cronVigencia] Error:', e.message);
    }
  });
  console.log('[cronVigencia] Programado — corre diariamente a medianoche (hora local del servidor).');
}

module.exports = {
  iniciarCronVigencia,
  actualizarVigencias,
  actualizarVigenciaPrograma,
  fechaVencimientoPrograma,
  hoyYMDLocal,
};
