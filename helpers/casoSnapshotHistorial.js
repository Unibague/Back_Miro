/**
 * Arma caso_snapshot para ProcessHistory (importaciones y cierres archivados).
 */
const Caso = require('../models/casos');
const ProcessDoc = require('../models/processDocuments');
const {
  findActividadByCasoKey,
  findSubactividadByCasoKey,
  dedupeDocs,
} = require('./casoActividadMap');

const CASO_DATE_KEYS_SNAPSHOT = [
  'fecha_solicitud_radicado',
  'fecha_notificacion_completitud',
  'fecha_respuesta_completitud',
  'fecha_resolucion',
  'fecha_resolucion_apelacion',
  'fecha_respuesta_men',
];

function obsConFallback(casoObs, actObs) {
  const t = String(casoObs ?? '').trim();
  if (t) return t;
  return String(actObs ?? '').trim();
}

function mapDocLean(d) {
  return {
    _id:           d._id,
    name:          d.name,
    drive_id:      d.drive_id,
    view_link:     d.view_link,
    download_link: d.download_link,
    mime_type:     d.mime_type ?? null,
    size:          d.size ?? null,
    subido_en:     d.createdAt ?? null,
  };
}

/** @param {import('mongoose').Types.ObjectId|string} processId historial o proceso activo */
async function buildCasoSnapshot(processId, mapDoc = mapDocLean, fasesSnapshot = []) {
  const caso = await Caso.findOne({ proceso_id: processId }).lean();
  if (!caso) return null;

  const casoDocs = await ProcessDoc.find({
    process_id: processId,
    caso_date_key: { $in: CASO_DATE_KEYS_SNAPSHOT },
  }).lean();

  const documentos_por_fecha = {};
  for (const d of casoDocs) {
    const k = String(d.caso_date_key ?? '');
    if (!k) continue;
    if (!documentos_por_fecha[k]) documentos_por_fecha[k] = [];
    documentos_por_fecha[k].push(mapDoc(d));
  }

  for (const key of CASO_DATE_KEYS_SNAPSHOT) {
    const hitA = findActividadByCasoKey(fasesSnapshot, key);
    const hitS = !hitA ? findSubactividadByCasoKey(fasesSnapshot, key) : null;
    const docsAct = hitA
      ? (hitA.act.documentos ?? [])
      : hitS
        ? (hitS.sub.documentos ?? [])
        : [];
    if (docsAct.length > 0) {
      documentos_por_fecha[key] = dedupeDocs([
        ...(documentos_por_fecha[key] ?? []),
        ...docsAct,
      ]);
    }
  }

  const obsAct = (key) => {
    const hitA = findActividadByCasoKey(fasesSnapshot, key);
    if (hitA) return hitA.act.observaciones ?? '';
    const hitS = findSubactividadByCasoKey(fasesSnapshot, key);
    if (hitS) return hitS.sub.observaciones ?? '';
    return '';
  };

  return {
    codigo_caso:                    caso.codigo_caso ?? null,
    fecha_solicitud_radicado:       caso.fecha_solicitud_radicado ?? null,
    fecha_notificacion_completitud: caso.fecha_notificacion_completitud ?? null,
    fecha_respuesta_completitud:    caso.fecha_respuesta_completitud ?? null,
    fecha_resolucion:               caso.fecha_resolucion ?? null,
    resolucion_aprobada:            caso.resolucion_aprobada ?? null,
    aplica_apelacion:               caso.aplica_apelacion ?? false,
    fecha_resolucion_apelacion:     caso.fecha_resolucion_apelacion ?? null,
    fecha_respuesta_men:            caso.fecha_respuesta_men ?? null,
    obs_fecha_solicitud_radicado: obsConFallback(caso.obs_fecha_solicitud_radicado, obsAct('fecha_solicitud_radicado')),
    obs_fecha_notificacion_completitud: obsConFallback(caso.obs_fecha_notificacion_completitud, obsAct('fecha_notificacion_completitud')),
    obs_fecha_respuesta_completitud: obsConFallback(caso.obs_fecha_respuesta_completitud, obsAct('fecha_respuesta_completitud')),
    obs_fecha_resolucion: obsConFallback(caso.obs_fecha_resolucion, obsAct('fecha_resolucion')),
    obs_fecha_resolucion_apelacion: obsConFallback(caso.obs_fecha_resolucion_apelacion, obsAct('fecha_resolucion_apelacion')),
    obs_fecha_respuesta_men: obsConFallback(caso.obs_fecha_respuesta_men, obsAct('fecha_respuesta_men')),
    documentos_por_fecha,
  };
}

module.exports = {
  CASO_DATE_KEYS_SNAPSHOT,
  buildCasoSnapshot,
  mapDocLean,
};
