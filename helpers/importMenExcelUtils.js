/**
 * Utilidades compartidas para importación Excel MEN (historial, vigentes).
 */
const mongoose = require('mongoose');

function extraerDriveId(url) {
  if (!url) return null;
  const m = url.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (m) return m[1];
  const m2 = url.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
  if (m2) return m2[1];
  return null;
}

function docDesdeLink(nombre, link) {
  if (!link) return null;
  const id = extraerDriveId(link);
  return {
    _id:           new mongoose.Types.ObjectId(),
    name:          nombre || 'Documento',
    drive_id:      id,
    view_link:     id ? `https://drive.google.com/file/d/${id}/view` : link,
    download_link: id ? `https://drive.google.com/uc?export=download&id=${id}` : null,
    mime_type:     'application/pdf',
    size:          null,
    subido_en:     null,
  };
}

function docsDesdeLinks(nombresStr, linksStr) {
  if (!linksStr) return [];
  const links   = linksStr.split(',').map(s => s.trim()).filter(Boolean);
  const nombres = nombresStr ? nombresStr.split(',').map(s => s.trim()) : [];
  return links.map((link, i) => docDesdeLink(nombres[i] || `Documento ${i + 1}`, link)).filter(Boolean);
}

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

function calcularFechasRCAV(tipo, fechaRes, durAnios) {
  if (!fechaRes || durAnios == null) return {};
  const esAV = tipo === 'AV' || tipo === 'AE';
  const meses = Number(durAnios) * 12;
  const venc  = sumarMeses(fechaRes, meses);
  if (!venc) return {};
  return {
    fecha_vencimiento:      venc,
    fecha_inicio:           siguienteDiaHabil(sumarMeses(venc, esAV ? -33 : -29)),
    fecha_documento_par:    siguienteDiaHabil(sumarMeses(venc, esAV ? -16 : -17)),
    fecha_digitacion_saces: siguienteDiaHabil(sumarMeses(venc, -15)),
    fecha_radicado_men:     sumarMeses(venc, -12),
  };
}

function str(cell) {
  if (!cell || cell.value == null) return '';
  if (typeof cell.value === 'object' && cell.value.text) return String(cell.value.text).trim();
  return String(cell.value).trim();
}

function num(cell) {
  const n = parseFloat(str(cell));
  return isNaN(n) ? null : n;
}

function bool(cell) {
  const v = str(cell).toUpperCase();
  if (!v) return false;
  return v === 'SI' || v === 'SÍ' || v === 'TRUE' || v === '1';
}

function fecha(cell) {
  const v = str(cell);
  return v || null;
}

/** Fases del trámite archivadas como cierre total (fase 5). */
function buildFasesSnapshotCompletas(fasesBase) {
  return fasesBase.map(fase => {
    const actividades = fase.actividades.map(act => ({
      nombre: act.nombre,
      responsables: act.responsables || '',
      completada: true,
      no_aplica: false,
      fecha_completado: null,
      observaciones: '',
      documentos: [],
      subactividades: (act.subactividades || []).map(sub => ({
        nombre: sub.nombre,
        completada: true,
        no_aplica: false,
        fecha_completado: null,
        observaciones: '',
        documentos: [],
      })),
    }));
    return {
      fase_numero: fase.numero,
      fase_nombre: fase.nombre,
      actividades_completadas: actividades.length,
      actividades_total: actividades.length,
      documentos: [],
      actividades,
    };
  });
}

function indexarHojaPorProgramaTipo(ws) {
  const idx = {};
  if (!ws) return idx;
  ws.eachRow((row, rn) => {
    if (rn === 1) return;
    const pc   = str(row.getCell(1));
    const tipo = str(row.getCell(2)).toUpperCase();
    if (!pc || pc.startsWith('──') || pc.startsWith('▼')) return;
    const key = `${pc}|${tipo}`;
    if (!idx[key]) idx[key] = [];
    idx[key].push(row);
  });
  return idx;
}

module.exports = {
  extraerDriveId,
  docDesdeLink,
  docsDesdeLinks,
  calcularFechasRCAV,
  str,
  num,
  bool,
  fecha,
  buildFasesSnapshotCompletas,
  indexarHojaPorProgramaTipo,
};
