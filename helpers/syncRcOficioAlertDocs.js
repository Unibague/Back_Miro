const Process = require('../models/processes');
const ProcessDocument = require('../models/processDocuments');
const Program = require('../models/programs');
const { findProgramByProcessCode } = require('./programByCode');
const { actualizarVigenciaPrograma } = require('./cronVigencia');

/**
 * Copia documentos `resolucion` del proceso RC «Registro calificado de oficio» activo
 * a la fila ALERTA (RC) del mismo programa y actualiza `ultimo_rc.link_documento` si hay enlace.
 */
async function syncRcOficioResolucionDocsToAlert(programCode) {
  const pc = String(programCode ?? '').trim();
  if (!pc) return;

  const procPrincipal = await Process.findOne({
    program_code: pc,
    tipo_proceso: 'RC',
    subtipo: 'Registro calificado de oficio',
  })
    .sort({ createdAt: -1 })
    .select('_id')
    .lean();

  const alertRow = await Process.findOne({
    program_code: pc,
    tipo_proceso: 'ALERTA',
    alert_para_tipo: 'RC',
  })
    .sort({ createdAt: -1 })
    .select('_id')
    .lean();

  if (!procPrincipal || !alertRow) return;

  await ProcessDocument.deleteMany({ process_id: alertRow._id, doc_type: 'resolucion' });
  const docs = await ProcessDocument.find({
    process_id: procPrincipal._id,
    doc_type: 'resolucion',
  }).lean();

  let firstLink = null;
  for (const o of docs) {
    if ((o.view_link || o.download_link) && !firstLink) {
      firstLink = o.view_link || o.download_link;
    }
    await ProcessDocument.create({
      phase_id: null,
      process_id: alertRow._id,
      doc_type: 'resolucion',
      name: o.name || 'Resolución',
      drive_id: o.drive_id ?? null,
      view_link: o.view_link ?? null,
      download_link: o.download_link ?? null,
      mime_type: o.mime_type || 'application/pdf',
      size: o.size ?? null,
    });
  }

  if (!firstLink) return;

  const program = await findProgramByProcessCode(Program, pc);
  if (!program) return;

  const ur = program.ultimo_rc && typeof program.ultimo_rc === 'object' ? { ...program.ultimo_rc } : {};
  ur.link_documento = String(firstLink);

  await Program.findByIdAndUpdate(program._id, { $set: { ultimo_rc: ur } });
  try {
    await actualizarVigenciaPrograma(program._id);
  } catch (e) {
    console.warn('[syncRcOficioResolucionDocsToAlert] actualizarVigenciaPrograma:', e?.message || e);
  }
}

module.exports = { syncRcOficioResolucionDocsToAlert };
