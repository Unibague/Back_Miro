/**
 * importVigentes.js — Resoluciones en vigencia (cierre archivado + ficha programa + alerta)
 *
 * GET  /process-history/vigentes/plantilla
 * POST /process-history/vigentes/importar
 * POST /process-history/vigentes/revertir  (mismo body que historial: history_ids)
 *
 * Uso migración: primero catálogo programas → luego este Excel → después procesos en gestión en UI.
 * No crea procesos activos (tablero). Sí: historial APROBADO, ultimo_rc/ultimo_av, alerta opcional.
 */

const ExcelJS = require('exceljs');
const multer = require('multer');
const mongoose = require('mongoose');
const ProcessHistory = require('../models/processHistory');
const Program = require('../models/programs');
const Process = require('../models/processes');
const FASES_RC = require('../helpers/fasesBaseRC');
const FASES_AV = require('../helpers/fasesBaseAV');
const FASES_AE = require('../helpers/fasesBaseAE');
const { findProgramByProcessCode } = require('../helpers/programByCode');
const { buildCasoSnapshot } = require('../helpers/casoSnapshotHistorial');
const { aplicarVigenciaProgramaImport } = require('../helpers/aplicarVigenciaProgramaImport');
const {
  str, num, bool, fecha, docsDesdeLinks, calcularFechasRCAV,
  buildFasesSnapshotCompletas, indexarHojaPorProgramaTipo, extraerDriveId,
} = require('../helpers/importMenExcelUtils');

const upload = multer({ storage: multer.memoryStorage() });
const SUBTIPOS_SIN_ALERTA = ['Reforma curricular'];
const TIPOS_VIGENTES = ['RC', 'AV', 'AE'];

module.exports.uploadMiddleware = upload.single('archivo');

/* ════════════════════════════════════════════════════════════════
   GET /process-history/vigentes/plantilla
   ════════════════════════════════════════════════════════════════ */
module.exports.descargarPlantilla = async (req, res) => {
  const importHistorial = require('./importHistorial');
  return importHistorial.descargarPlantilla(req, res);
};

function filasInfoCaso(casoIdx, programId, programCodeExcel, tipo_proceso) {
  const k1 = `${programId}|${tipo_proceso}`;
  const k2 = `${programCodeExcel}|${tipo_proceso}`;
  return casoIdx[k1] || casoIdx[k2] || [];
}

async function importarInfoCaso(histDoc, casoRows, fasesSnapshot, errores, rn) {
  if (!casoRows.length) return;
  const Caso = require('../models/casos');
  const ProcessDoc = require('../models/processDocuments');
  const cr = casoRows[0];
  try {
    await Caso.create({
      proceso_id:                         histDoc._id,
      codigo_caso:                        str(cr.getCell(3)) || null,
      fecha_solicitud_radicado:           str(cr.getCell(4)) || null,
      obs_fecha_solicitud_radicado:       str(cr.getCell(5)),
      fecha_notificacion_completitud:     str(cr.getCell(7)) || null,
      obs_fecha_notificacion_completitud: str(cr.getCell(8)),
      fecha_respuesta_completitud:        str(cr.getCell(10)) || null,
      obs_fecha_respuesta_completitud:    str(cr.getCell(11)),
      fecha_resolucion:                   str(cr.getCell(13)) || null,
      obs_fecha_resolucion:               str(cr.getCell(14)),
      resolucion_aprobada:                bool(cr.getCell(16)),
      aplica_apelacion:                   bool(cr.getCell(17)),
      fecha_resolucion_apelacion:         str(cr.getCell(18)) || null,
      obs_fecha_resolucion_apelacion:     str(cr.getCell(19)),
      fecha_respuesta_men:                str(cr.getCell(21)) || null,
      obs_fecha_respuesta_men:            str(cr.getCell(22)),
    });

    const casoDocMap = [
      { key: 'fecha_solicitud_radicado', linksStr: str(cr.getCell(6)) },
      { key: 'fecha_notificacion_completitud', linksStr: str(cr.getCell(9)) },
      { key: 'fecha_respuesta_completitud', linksStr: str(cr.getCell(12)) },
      { key: 'fecha_resolucion', linksStr: str(cr.getCell(15)) },
      { key: 'fecha_resolucion_apelacion', linksStr: str(cr.getCell(20)) },
      { key: 'fecha_respuesta_men', linksStr: str(cr.getCell(23)) },
    ];
    for (const { key, linksStr } of casoDocMap) {
      if (!linksStr) continue;
      for (const link of linksStr.split(',').map(s => s.trim()).filter(Boolean)) {
        const id = extraerDriveId(link);
        if (!id) continue;
        await ProcessDoc.create({
          process_id:    histDoc._id,
          caso_date_key: key,
          name:          `Documento ${key}`,
          drive_id:      id,
          view_link:     `https://drive.google.com/file/d/${id}/view`,
          download_link: `https://drive.google.com/uc?export=download&id=${id}`,
          doc_type:      'proceso',
        });
      }
    }

    const casoSnapshot = await buildCasoSnapshot(histDoc._id, undefined, fasesSnapshot);
    if (casoSnapshot) {
      await ProcessHistory.findByIdAndUpdate(histDoc._id, { $set: { caso_snapshot: casoSnapshot } });
    }
  } catch (e) {
    errores.push({ fila: rn, advertencia: `Historial creado, INFO_CASO: ${e.message}` });
  }
}

/* ════════════════════════════════════════════════════════════════
   POST /process-history/vigentes/importar
   ════════════════════════════════════════════════════════════════ */
module.exports.importar = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Se requiere el archivo en el campo "archivo".' });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(req.file.buffer);
  const wsP = wb.getWorksheet('PROCESOS');
  if (!wsP) {
    return res.status(400).json({
      error: 'La importación de vigentes usa la plantilla completa de historial. Falta la hoja "PROCESOS".',
    });
  }

  const errores = [];
  for (let rn = 2; rn <= wsP.rowCount; rn++) {
    const row = wsP.getRow(rn);
    const program_code = str(row.getCell(1));
    if (!program_code || program_code.startsWith('──') || program_code.startsWith('▼')) continue;

    const tipo_proceso = str(row.getCell(2)).toUpperCase();
    const estadoRaw = str(row.getCell(7)).toUpperCase();
    const estado_solicitud = ['NEGADO', 'CANCELADO'].includes(estadoRaw) ? estadoRaw : 'APROBADO';

    if (!['RC', 'AV', 'AE'].includes(tipo_proceso)) {
      errores.push({
        fila: rn,
        error: `Vigentes solo admite RC, AV o AE. Se encontró "${tipo_proceso || 'vacío'}".`,
      });
      continue;
    }
    if (estado_solicitud !== 'APROBADO') {
      errores.push({
        fila: rn,
        error: 'Vigentes solo admite procesos APROBADOS, porque todos deben crear alerta y dejar vigencia.',
      });
    }
  }

  if (errores.length > 0) {
    return res.status(400).json({
      message: `No se importó el archivo de vigentes. Corrige ${errores.length} fila(s).`,
      importados: [],
      errores,
    });
  }

  const importHistorial = require('./importHistorial');
  return importHistorial.importar(req, res);
};

module.exports.revertir = async (req, res) => {
  const importHistorial = require('./importHistorial');
  return importHistorial.revertir(req, res);
};
