/**
 * Actualiza ultimo_rc / ultimo_av y totales tras importar un cierre en vigencia (APROBADO).
 */
const ProcessHistory = require('../models/processHistory');
const Program = require('../models/programs');

const SUBTIPO_RC_VIGENCIA_TRANSITORIA = 'Vigencia transitoria';

function programCodeStr(program) {
  return String(program._id ?? program);
}

async function countRcHistorialContable(programCode) {
  const pc = programCodeStr({ _id: programCode });
  return ProcessHistory.countDocuments({
    program_code: pc,
    tipo_proceso: 'RC',
    subtipo: { $ne: SUBTIPO_RC_VIGENCIA_TRANSITORIA },
  });
}

/**
 * @param {object} program documento Program
 * @param {object} histDoc ProcessHistory recién creado
 * @param {string} tipo_proceso RC | AV | AE
 * @param {string|null} subtipo
 * @param {string|null} linkDocHistorial view_link del PDF de resolución
 */
async function aplicarVigenciaProgramaImport(program, histDoc, tipo_proceso, subtipo, linkDocHistorial) {
  const sub = String(subtipo ?? '').trim();
  const esRcNoRenov = tipo_proceso === 'RC' && sub === 'No renovación';
  const esReformaCurricularSolo = tipo_proceso === 'RC' && sub === 'Reforma curricular';

  const pc = programCodeStr(program);

  if (esReformaCurricularSolo) {
    const totalRC = await countRcHistorialContable(pc);
    const totalAV = await ProcessHistory.countDocuments({
      program_code: pc,
      tipo_proceso: 'AV',
    });
    await Program.findByIdAndUpdate(program._id, {
      $set: { total_rc: totalRC, total_av: totalAV },
    });
    const refreshedRef = await Program.findById(program._id)
      .select('total_rc total_av tiene_rc_vigente tiene_av_vigente')
      .lean();
    return {
      vigencia_actualizada: false,
      motivo: 'Reforma curricular no actualiza resolución vigente en ficha.',
      total_rc: refreshedRef?.total_rc ?? totalRC,
      total_av: refreshedRef?.total_av ?? totalAV,
      tiene_rc_vigente: refreshedRef?.tiene_rc_vigente ?? null,
      tiene_av_vigente: refreshedRef?.tiene_av_vigente ?? null,
    };
  }

  const codFinal = histDoc.codigo_resolucion ?? null;
  const frFinal = histDoc.fecha_resolucion ?? null;
  const durFinal = histDoc.duracion_resolucion ?? null;
  const fvHist = histDoc.fecha_vencimiento ?? null;

  const totalRC = await countRcHistorialContable(pc);
  const totalAV = await ProcessHistory.countDocuments({
    program_code: pc,
    tipo_proceso: 'AV',
  });

  const programaUpdate = {
    fecha_resolucion_av: null,
    codigo_resolucion_av: null,
    duracion_resolucion_av: null,
    fecha_resolucion_rc: null,
    codigo_resolucion_rc: null,
    duracion_resolucion_rc: null,
    total_rc: totalRC,
    total_av: totalAV,
  };

  if (tipo_proceso === 'RC' && sub === 'Reactivación') {
    programaUpdate.estado = 'Activo';
  }
  if (esRcNoRenov) {
    programaUpdate.estado = 'Inactivo';
    programaUpdate.activo_universidad = false;
  }

  if (tipo_proceso === 'RC') {
    if (esRcNoRenov) {
      programaUpdate.ultimo_rc = {
        codigo_resolucion: null,
        fecha_resolucion: frFinal,
        duracion_resolucion: null,
        fecha_vencimiento: null,
        link_documento: linkDocHistorial,
      };
    } else {
      programaUpdate.ultimo_rc = {
        codigo_resolucion: codFinal,
        fecha_resolucion: frFinal,
        duracion_resolucion: durFinal,
        fecha_vencimiento: fvHist,
        link_documento: linkDocHistorial,
      };
    }
    if (sub === 'Registro calificado de oficio') {
      programaUpdate.av_rc_oficio_pendiente = false;
    }
  } else if (tipo_proceso === 'AV' || tipo_proceso === 'AE') {
    programaUpdate.ultimo_av = {
      codigo_resolucion: codFinal,
      fecha_resolucion: frFinal,
      duracion_resolucion: durFinal,
      fecha_vencimiento: fvHist,
      link_documento: linkDocHistorial,
    };
    if (tipo_proceso === 'AV') {
      programaUpdate.av_rc_oficio_pendiente = false;
    }
  } else {
    return { vigencia_actualizada: false, motivo: 'Tipo no actualiza vigencia en ficha.' };
  }

  await Program.findByIdAndUpdate(program._id, { $set: programaUpdate });

  try {
    const { actualizarVigenciaPrograma } = require('./cronVigencia');
    await actualizarVigenciaPrograma(program._id);
  } catch (e) {
    console.error('[aplicarVigenciaProgramaImport] actualizarVigenciaPrograma:', e.message);
  }

  const refreshed = await Program.findById(program._id)
    .select('total_rc total_av tiene_rc_vigente tiene_av_vigente ultimo_rc ultimo_av')
    .lean();

  return {
    vigencia_actualizada: true,
    total_rc: refreshed?.total_rc ?? totalRC,
    total_av: refreshed?.total_av ?? totalAV,
    tiene_rc_vigente: refreshed?.tiene_rc_vigente ?? null,
    tiene_av_vigente: refreshed?.tiene_av_vigente ?? null,
  };
}

module.exports = {
  aplicarVigenciaProgramaImport,
  countRcHistorialContable,
  SUBTIPO_RC_VIGENCIA_TRANSITORIA,
};
