/**
 * importHistorial.js
 *
 * GET  /process-history/plantilla  → descarga plantilla Excel
 * POST /process-history/importar   → importa el Excel lleno → historial + alertas (salvo RC Reforma curricular: sin ALERTA)
 * POST /process-history/revertir   → borra lo importado
 *
 * Tipos soportados: RC, AV, AE, PM
 *
 * VINCULACIÓN ENTRE HOJAS:
 *   INFO_CASO, ACTIVIDADES y SUBACTIVIDADES usan program_code + tipo_proceso
 *   para identificar a qué proceso de PROCESOS pertenecen (mismo código exacto).
 *
 * FECHAS DEL PROCESO:
 *   Si se dejan en blanco, se autocalculan desde fecha_resolucion + duracion_resolucion.
 *   Si se llenan, el valor explícito tiene prioridad.
 *
 * PM:
 *   - subtipo: opcional ("Plan de Mejoramiento AV" / "Plan de Mejoramiento AE" / en blanco)
 *   - fechas propias: envio_pm_vicerrectoria, entrega_pm_cna, envio_avance_vicerrectoria, radicacion_avance_cna
 *   - columna codigo_historia_padre: código de resolución del AV/AE padre para vincular
 *
 * RC — Reforma curricular / Renovación + reforma (APROBADO):
 *   - Columnas AB–AK (28–37): solo el valor NUEVO por campo del programa (opcional por columna).
 *   - En blanco en una columna = ese atributo no cambia. Si el valor difiere del programa actual,
 *     se guarda en programa_cambios (antes/después) y se actualiza Program.
 *
 * DOCUMENTOS:
 *   Pega el link de Drive. Varios links separados por coma.
 */

const ExcelJS        = require('exceljs');
const multer         = require('multer');
const mongoose       = require('mongoose');
const ProcessHistory = require('../models/processHistory');
const Program        = require('../models/programs');
const Process        = require('../models/processes');
const FASES_RC       = require('../helpers/fasesBaseRC');
const FASES_AV       = require('../helpers/fasesBaseAV');
const FASES_PM       = require('../helpers/fasesBasePM');
const {
  aplicarVigenciaProgramaImport,
  countRcHistorialContable,
} = require('../helpers/aplicarVigenciaProgramaImport');

function filasInfoCaso(casoIdx, programId, programCodeExcel, tipo_proceso) {
  const k1 = `${programId}|${tipo_proceso}`;
  const k2 = `${programCodeExcel}|${tipo_proceso}`;
  return casoIdx[k1] || casoIdx[k2] || [];
}

const upload = multer({ storage: multer.memoryStorage() });
/** Columnas AB–AK (28–37): nuevos valores del programa (solo RC reforma / renovación+reforma, APROBADO). */
const SUBTIPOS_REFORMA_IMPORT = ['Reforma curricular', 'Renovación + reforma'];

function normalizarAliasSubtipoRC(subtipo) {
  const t = String(subtipo ?? '').trim().toLowerCase();
  if (t === 'modificacion' || t === 'modificación') return 'Reforma curricular';
  if (t === 'renovacion + modificacion' || t === 'renovación + modificación') return 'Renovación + reforma';
  return subtipo;
}

const LABELS_PROGRAMA_REFORMA = {
  nombre: 'Nombre del programa',
  codigo_snies: 'Código SNIES',
  modalidad: 'Modalidad',
  nivel_academico: 'Nivel académico',
  nivel_formacion: 'Nivel de formación',
  num_creditos: 'N° de créditos',
  periodos_duracion: 'Periodos de duración',
  num_semestres: 'N° de semestres',
  admision_estudiantes: 'Admisión de estudiantes',
  num_estudiantes_saces: 'N° estudiantes SACES',
};

/**
 * Lee columnas 28–37 de PROCESOS; si hay valores, arma diff y update $set para programs.
 */
function programaCambiosDesdeFilaProcesos(row, programa) {
  /** @type {{ campo: string; label: string; antes: unknown; despues: unknown }[]} */
  const cambios = [];
  const updateProg = {};
  const spec = [
    { key: 'nombre', col: 28, tipo: 'str' },
    { key: 'codigo_snies', col: 29, tipo: 'str' },
    { key: 'modalidad', col: 30, tipo: 'str' },
    { key: 'nivel_academico', col: 31, tipo: 'str' },
    { key: 'nivel_formacion', col: 32, tipo: 'str' },
    { key: 'num_creditos', col: 33, tipo: 'num' },
    { key: 'periodos_duracion', col: 34, tipo: 'str' },
    { key: 'num_semestres', col: 35, tipo: 'num' },
    { key: 'admision_estudiantes', col: 36, tipo: 'str' },
    { key: 'num_estudiantes_saces', col: 37, tipo: 'num' },
  ];
  for (const { key, col, tipo } of spec) {
    const raw = str(row.getCell(col));
    if (raw === '') continue;
    /** @type {string|number|null} */
    let despues = tipo === 'num' ? num(row.getCell(col)) : raw;
    if (tipo === 'num' && despues == null) continue;
    const antes = programa[key];
    const aNorm = antes == null ? '' : String(antes);
    const dNorm = despues == null ? '' : String(despues);
    if (aNorm === dNorm) continue;
    cambios.push({
      campo: key,
      label: LABELS_PROGRAMA_REFORMA[key] ?? key,
      antes: antes ?? null,
      despues: despues ?? null,
    });
    updateProg[key] = despues;
  }
  return { cambios, updateProg };
}

module.exports.uploadMiddleware = upload.single('archivo');

/* ════════════════════════════════════════════════════════════════
   UTILIDADES
   ════════════════════════════════════════════════════════════════ */

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

function calcularFechasPM(fechaRes, durAnios) {
  if (!fechaRes || durAnios == null) return {};
  const meses    = Number(durAnios) * 12;
  const mitad    = Math.round(meses / 2);
  const fechaMit = sumarMeses(fechaRes, mitad);
  return {
    fecha_envio_pm_vicerrectoria:     siguienteDiaHabil(sumarMeses(fechaRes, 5)),
    fecha_entrega_pm_cna:             siguienteDiaHabil(sumarMeses(fechaRes, 6)),
    fecha_envio_avance_vicerrectoria: siguienteDiaHabil(sumarMeses(fechaMit, -6)),
    fecha_radicacion_avance_cna:      siguienteDiaHabil(sumarMeses(fechaMit, 0)),
  };
}

function str(cell) {
  if (!cell || cell.value == null) return '';
  if (typeof cell.value === 'object' && cell.value.text) return String(cell.value.text).trim();
  return String(cell.value).trim();
}
function num(cell) { const n = parseFloat(str(cell)); return isNaN(n) ? null : n; }
function bool(cell) { return str(cell).toUpperCase() === 'SI'; }
function fecha(cell) { const v = str(cell); return v || null; }

/* ════════════════════════════════════════════════════════════════
   GET /process-history/plantilla
   ════════════════════════════════════════════════════════════════ */
module.exports.descargarPlantilla = async (req, res) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Miro';

  /* ── Estilos ── */
  const hdrFill   = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF2D5BA3' } };
  const hdrFont   = { bold:true, color:{ argb:'FFFFFFFF' }, size:11 };
  const infoFill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFFE0B2' } };
  const grayFill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFD9D9D9' } };
  const greenFill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFE6F4EA' } };
  const blueFill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFB3C6E7' } };
  const purpFill  = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFD5B3E7' } };
  const datFill   = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFFF9E6' } };
  const sepFill   = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF333333' } };
  const thin      = { top:{style:'thin'}, bottom:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'} };
  const hairBot   = { bottom:{ style:'hair', color:{ argb:'FFCCCCCC' } } };

  function addHeader(ws, cols, widths) {
    const row = ws.addRow(cols);
    row.height = 38;
    cols.forEach((_, i) => {
      const c = row.getCell(i + 1);
      c.font = hdrFont; c.fill = hdrFill; c.border = thin;
      c.alignment = { vertical:'middle', wrapText:true };
    });
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    return row;
  }
  function ejRow(ws, vals) {
    const row = ws.addRow(vals);
    row.eachCell(c => { c.fill = greenFill; c.border = thin; });
    return row;
  }
  function refRow(ws, vals, fill) {
    const row = ws.addRow(vals);
    row.eachCell(c => { c.fill = fill ?? grayFill; c.font = { italic:true, size:10 }; });
    return row;
  }
  function blankRow(ws, cols = 9) {
    const row = ws.addRow(Array(cols).fill(''));
    row.eachCell(c => { c.fill = datFill; });
    return row;
  }
  function sepRow(ws, label, col = 1) {
    const row = ws.addRow([]);
    row.getCell(col).value = label;
    row.height = 22;
    row.eachCell(c => { c.fill = sepFill; c.font = { bold:true, color:{ argb:'FFFFFFFF' }, size:11 }; });
    return row;
  }
  function sectionRow(ws, label, fill, col = 1) {
    const row = ws.addRow([]);
    row.getCell(col).value = label;
    row.eachCell(c => { c.fill = fill; c.font = { bold:true, color:{ argb:'FFFFFFFF' }, size:10 }; });
    return row;
  }

  /* ──────────────────────────────────────────────────────────────
     INSTRUCCIONES
     ────────────────────────────────────────────────────────────── */
  const wsI = wb.addWorksheet('INSTRUCCIONES');
  wsI.getColumn(1).width = 130;
  [
    ['📋 PLANTILLA DE IMPORTACIÓN DE HISTORIAL DE PROCESOS', true],
    ['', false],
    ['TIPOS SOPORTADOS', true],
    ['  RC (Registro Calificado) | AV (Acreditación Voluntaria) | AE (Autoevaluación) | PM (Plan de Mejoramiento)', false],
    ['', false],
    ['VINCULACIÓN ENTRE HOJAS', true],
    ['  Las hojas INFO_CASO, ACTIVIDADES y SUBACTIVIDADES usan "program_code" + "tipo_proceso"', false],
    ['  para saber a qué proceso de PROCESOS pertenecen.', false],
    ['  Mismo program_code en todas las hojas: _id Mongo del programa (recomendado) o dep_code_programa (ID_PROGRAMA).', false],
    ['  Cierres APROBADO RC/AV/AE: actualizan ultimo_rc/ultimo_av, total_rc/total_av y flags de vigencia en la ficha.', false],
    ['', false],
    ['FECHAS DEL PROCESO', true],
    ['  PROCESOS tiene dos bloques de fechas. Cada fecha puede llevar observaciones en su columna contigua, excepto fecha_vencimiento.', false],
    ['  • Fechas RC/AV/AE: fecha_vencimiento, fecha_inicio, fecha_documento_par, fecha_digitacion_saces, fecha_radicado_men', false],
    ['  • Fechas PM: envio_pm_vicerrectoria, entrega_pm_cna, envio_avance_vicerrectoria, radicacion_avance_cna', false],
    ['  • RC «Modificación» importada sin resolución: no se genera ALERTA; el historial sí se crea.', false],
    ['', false],
    ['PM (Plan de Mejoramiento)', true],
    ['  • subtipo: deja en blanco o pon "Plan de Mejoramiento AV" / "Plan de Mejoramiento AE"', false],
    ['  • codigo_res_padre: código de resolución del AV/AE padre para vincularlo (columna J)', false],
    ['  • No lleva fecha_resolucion ni duracion si es un PM puro; llena las 4 fechas PM directamente.', false],
    ['', false],
    ['RC DE OFICIO', true],
    ['  tipo_proceso = RC, subtipo = Registro calificado de oficio', false],
    ['  En codigo_res_padre (col J) pon el código de resolución del AV padre.', false],
    ['', false],
    ['RC — MODIFICACIÓN / RENOVACIÓN + MODIFICACIÓN', true],
    ['  Si subtipo es "Modificación" o "Renovación + modificación" y estado es APROBADO,', false],
    ['  usa las columnas AB–AK en PROCESOS: una celda por dato del programa = solo el VALOR NUEVO', false],
    ['  tras la modificación (no vas “antes/después”: el anterior lo tiene ya Miró; vacío = sin cambio en ese campo).', false],
    ['  Las celdas AB–AK se resaltan cuando en la misma fila tipo=RC y el subtipo es modificación.', false],
    ['  Solo se guardan campos con valor distinto al programa actual.', false],
    ['', false],
    ['DOCUMENTOS', true],
    ['  Pega el link de Drive en las columnas "link_*". Varios docs: sepáralos con coma (,).', false],
    ['  • PROCESOS → link_resolucion: documento(s) de la resolución del proceso.', false],
    ['  • INFO_CASO → link_doc_* por campo: cada fecha tiene su propia columna de documentos.', false],
    ['    Ej: link_doc_solicitud_radicado, link_doc_resolucion, link_doc_respuesta_men, etc.', false],
    ['  • ACTIVIDADES / SUBACTIVIDADES → link_documento: documentos por actividad o subactividad.', false],
    ['', false],
    ['ACTIVIDADES Y SUBACTIVIDADES', true],
    ['  Si todo quedó completado (lo habitual), no necesitas llenar esas hojas.', false],
    ['  Solo llénalas si hay actividades "no aplica", fechas específicas o documentos adjuntos.', false],
    ['  Copia los nombres exactos del bloque de referencia (zona azul/morada de cada hoja).', false],
  ].forEach(([t, b]) => {
    const row = wsI.addRow([t]);
    row.getCell(1).font = b ? { bold:true, size:13 } : { size:11 };
    if (b) row.getCell(1).fill = infoFill;
  });

  /* ──────────────────────────────────────────────────────────────
     PROCESOS
     Cols:
     A program_code     B tipo_proceso    C subtipo
     D codigo_res       E fecha_res       F duracion_res
     G estado_solicitud H fase_al_cierre
     I link_resolucion
     J codigo_res_padre  (RC de oficio: AV padre  |  PM: AV/AE padre)
     — Fechas RC/AV/AE —
     K fecha_vencimiento  L fecha_inicio  M obs_inicio
     N fecha_documento_par O obs_documento_par P fecha_digitacion_saces Q obs_digitacion_saces
     R fecha_radicado_men S obs_radicado_men
     — Fechas PM —
     T fecha_envio_pm_vicerrectoria  U obs_envio_pm_vicerrectoria
     V fecha_entrega_pm_cna          W obs_entrega_pm_cna
     X fecha_envio_avance_vicerrectoria Y obs_envio_avance_vicerrectoria
     Z fecha_radicacion_avance_cna  AA obs_radicacion_avance_cna
     — Reforma / renov.+reforma: columnas AB–AK = valor NUEVO del programa (solo lo que cambió) —
     AB nombre (nuevo)  AC SNIES  AD modalidad  AE nivel_acad
     AF nivel_formación  AG créditos  AH periodos duración  AI semestres  AJ admisión  AK estudiantes SACES
     ────────────────────────────────────────────────────────────── */
  const wsP = wb.addWorksheet('PROCESOS');
  addHeader(wsP, [
    'Código del programa',
    'Tipo de proceso\n(RC / AV / AE / PM)',
    'Subtipo',
    'Código de resolución',
    'Fecha de resolución\n(AAAA-MM-DD)',
    'Duración\n(años)',
    'Estado de la solicitud\n(APROBADO/NEGADO/CANCELADO)',
    'Fase al cierre\n(0 a 5)',
    'Link de la resolución\n(Google Drive — varios sep. por coma)',
    'Código resolución AV/AE padre\n(RC de oficio: código AV del mismo programa\nPM: código AV o AE padre)',
    '— Solo RC/AV/AE —\nFecha de vencimiento',
    'Fecha de inicio',
    'Observaciones\ninicio',
    'Fecha documento par',
    'Observaciones\ndocumento par',
    'Fecha digitación SACES',
    'Observaciones\ndigitación SACES',
    'Fecha radicado MEN',
    'Observaciones\nradicado MEN',
    '— Solo PM —\nFecha envío PM\na Vicerrectoría',
    'Observaciones\nenvío PM',
    'Fecha entrega\nPM al CNA',
    'Observaciones\nentrega PM',
    'Fecha envío avance\na Vicerrectoría',
    'Observaciones\nenvío avance',
    'Fecha radicación\navance CNA',
    'Observaciones\nradicación avance',
    'Modificación — nombre programa\n(valor nuevo post-modificación)',
    'Modificación — código SNIES',
    'Modificación — modalidad',
    'Modificación — nivel académico',
    'Modificación — nivel de formación',
    'Modificación — N° de créditos',
    'Modificación — Periodos de duración',
    'Modificación — N° semestres',
    'Modificación — admisión estudiantes\n(ej. Semestral)',
    'Modificación — N° estudiantes SACES',
  ], [20,18,30,22,18,12,22,14,45,42,22,18,24,18,24,18,24,18,24,20,22,16,22,20,22,18,22,30,16,18,18,22,14,14,13,13,24]);

  wsP.getCell('C1').note = 'RC: Nuevo | Renovación | No renovación | Renovación + modificación | Modificación | Reactivación | Registro calificado de oficio\nAV: Nuevo | Renovación | No renovación | Reactivación\nAE: Autoevaluación\nPM: dejar vacío o "Plan de Mejoramiento AV" / "Plan de Mejoramiento AE"';
  wsP.getCell('J1').note = 'RC de oficio: código de resolución del AV del mismo programa.\nPM: código de resolución del AV o AE padre.\nEl sistema busca ese historial y vincula los registros.';
  wsP.getCell('AB1').note = 'Casillas del programa (solo valor NUEVO tras la modificación). Aplica solo si tipo RC + subtipo «Modificación» o «Renovación + modificación» y estado APROBADO.\nCada columna opcional; en blanco = ese dato del programa no cambia. El sistema calcula antes/después y guarda programa_cambios.';

  const PROC_COLS = 37;
  const fechasRcAvVacias = Array(9).fill('');
  const fechasPmVacias = Array(8).fill('');
  const reformaVacios = Array(10).fill('');

  // 2 RC, 1 RC reforma de ejemplo y 1 AV (fila en blanco entre cada uno)
  ejRow(wsP, ['22','RC','Renovación','Res-1234-2022','2022-08-10',7,'APROBADO',5,'https://drive.google.com/file/d/EJEMPLO_ID_1/view','', ...fechasRcAvVacias, ...fechasPmVacias, ...reformaVacios]);
  blankRow(wsP, PROC_COLS);
  ejRow(wsP, ['23','RC','Renovación','Res-5678-2023','2023-03-20',7,'APROBADO',5,'https://drive.google.com/file/d/EJEMPLO_ID_2/view','', ...fechasRcAvVacias, ...fechasPmVacias, ...reformaVacios]);
  blankRow(wsP, PROC_COLS);
  ejRow(wsP, ['22','RC','Modificación','Res-RF-2024','2024-01-15',7,'APROBADO',5,'https://drive.google.com/file/d/EJEMPLO_ID_RF/view','', ...fechasRcAvVacias, ...fechasPmVacias,
    'Nombre programa actualizado (ejemplo)','','Presencial','Pregrado','Profesional','180','10','10','Semestral','25']);
  blankRow(wsP, PROC_COLS);
  ejRow(wsP, ['22','AV','Renovación','Res-9012-2021','2021-11-05',4,'APROBADO',5,'https://drive.google.com/file/d/EJEMPLO_ID_3/view','', ...fechasRcAvVacias, ...fechasPmVacias, ...reformaVacios]);

  for (let r = 2; r <= 200; r++) {
    wsP.getCell(`B${r}`).dataValidation = { type:'list', allowBlank:true, formulae:['"RC,AV,AE,PM"'] };
    wsP.getCell(`G${r}`).dataValidation = { type:'list', allowBlank:true, formulae:['"APROBADO,NEGADO,CANCELADO"'] };
    wsP.getCell(`AD${r}`).dataValidation = { type:'list', allowBlank:true, formulae:['"Presencial,Virtual,Híbrido"'] };
    wsP.getCell(`AE${r}`).dataValidation = { type:'list', allowBlank:true, formulae:['"Pregrado,Posgrado"'] };
    wsP.getCell(`AF${r}`).dataValidation = { type:'list', allowBlank:true, formulae:['"Profesional,Tecnológico,Técnico,Especialización,Maestría,Doctorado"'] };
  }

  wsP.views = [{ state:'frozen', xSplit:27, ySplit:1, topLeftCell:'AB2', activeCell:'A2' }];
  wsP.addConditionalFormatting({
    ref: 'AB2:AK250',
    rules: [{
      type: 'expression',
      priority: 1,
      formulae: ['AND($B2="RC",OR($C2="Reforma curricular",$C2="Modificación",$C2="Renovación + reforma",$C2="Renovación + modificación"))'],
      style: {
        fill: { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFFF4DD' } },
      },
    }],
  });

  /* ──────────────────────────────────────────────────────────────
     INFO_CASO
     Cada fecha tiene su obs y su link_doc (= documentos en ProcessDocuments con caso_date_key)
     A  program_code          B  tipo_proceso       C  codigo_caso
     D  fecha_solicitud_rad   E  obs_solicitud_rad  F  link_doc_solicitud_radicado
     G  fecha_notif_comp      H  obs_notif_comp     I  link_doc_notif_completitud
     J  fecha_resp_comp       K  obs_resp_comp      L  link_doc_respuesta_completitud
     M  fecha_resolucion      N  obs_resolucion     O  link_doc_resolucion
     P  resolucion_aprobada   Q  aplica_apelacion
     R  fecha_res_apelacion   S  obs_res_apelacion  T  link_doc_resolucion_apelacion
     U  fecha_respuesta_men   V  obs_respuesta_men  W  link_doc_respuesta_men
     ────────────────────────────────────────────────────────────── */
  const wsC = wb.addWorksheet('INFO_CASO');
  addHeader(wsC, [
    'Código del programa\n(igual que PROCESOS)', 'Tipo de proceso\n(igual que PROCESOS)',
    'Código del caso',
    'Solicitud de radicado\n(fecha AAAA-MM-DD)', 'Observaciones\nsolicitud radicado', 'Documentos solicitud radicado\n(links Drive, sep. por coma)',
    'Notificación de completitud\n(fecha AAAA-MM-DD)', 'Observaciones\nnotif. completitud', 'Documentos notif. completitud\n(links Drive, sep. por coma)',
    'Respuesta de completitud\n(fecha AAAA-MM-DD)', 'Observaciones\nrespuesta completitud', 'Documentos respuesta completitud\n(links Drive, sep. por coma)',
    'Acto administrativo MEN\n(fecha resolución AAAA-MM-DD)', 'Observaciones\nacto administrativo', 'Documentos acto administrativo\n(links Drive, sep. por coma)',
    'Resolución aprobada\n(SI / NO)', '¿Aplica apelación?\n(SI / NO)',
    'Resolución de apelación\n(fecha AAAA-MM-DD)', 'Observaciones\nresolución apelación', 'Documentos resolución apelación\n(links Drive, sep. por coma)',
    'Respuesta MEN\n(fecha AAAA-MM-DD)', 'Observaciones\nrespuesta MEN', 'Documentos respuesta MEN\n(links Drive, sep. por coma)',
  ], [22,16,18, 20,28,42, 22,28,42, 22,28,42, 24,28,42, 18,16, 22,28,42, 20,28,42]);

  // Ejemplo RC programa 22
  ejRow(wsC, ['22','RC','CASO-2022-001',
    '2021-10-05','Radicado en ventanilla MEN','',
    '2021-12-15','','',
    '2022-02-20','','',
    '2022-08-10','Resolución satisfactoria','https://drive.google.com/file/d/EJEMPLO_ID_1/view',
    'SI','NO','','','','','','',
  ]);
  blankRow(wsC, 23);
  // Ejemplo RC programa 23
  ejRow(wsC, ['23','RC','CASO-2023-008',
    '2022-06-10','','',
    '2022-08-22','','',
    '2022-10-05','','',
    '2023-03-20','','https://drive.google.com/file/d/EJEMPLO_ID_2/view',
    'SI','NO','','','','','','',
  ]);
  blankRow(wsC, 23);
  // Ejemplo AV programa 22
  ejRow(wsC, ['22','AV','CASO-2021-003',
    '2020-09-14','','',
    '2020-11-30','','',
    '2021-01-18','','',
    '2021-11-05','Resolución satisfactoria','https://drive.google.com/file/d/EJEMPLO_ID_3/view',
    'SI','NO','','','','','','',
  ]);

  for (let r = 2; r <= 200; r++) {
    wsC.getCell(`P${r}`).dataValidation = { type:'list', allowBlank:true, formulae:['"SI,NO"'] };
    wsC.getCell(`Q${r}`).dataValidation = { type:'list', allowBlank:true, formulae:['"SI,NO"'] };
  }

  /* ──────────────────────────────────────────────────────────────
     ACTIVIDADES
     ────────────────────────────────────────────────────────────── */
  const wsA = wb.addWorksheet('ACTIVIDADES');
  addHeader(wsA, [
    'Código del programa\n(igual que PROCESOS)', 'Tipo de proceso\n(igual que PROCESOS)',
    'N° de fase\n(0 a 5)', 'Nombre de la actividad\n(copia exacta del bloque de referencia de abajo)',
    'Completada\n(SI / NO)', 'No aplica\n(SI / NO)',
    'Fecha de completado\n(AAAA-MM-DD)', 'Observaciones',
    'Documentos\n(links Drive — varios sep. por coma)',
  ], [22,16,12,58,14,14,20,35,50]);

  // Ejemplos: RC prog 22 (todas completadas — los demás quedaron igual)
  const actRC = [
    [0,'Notificación de la apertura del proceso para solicitud de renovación de registro calificado'],
    [1,'Reunión inicial: capacitación sobre el sentido del proceso y uso de la plataforma Miró, lineamientos y plantillas'],
    [1,'Preparación interna del programa'],
    [1,'Definición de agenda y cronograma de trabajo'],
    [2,'Construcción del documento maestro y anexos'],
    [2,'Reuniones parciales de avance'],
    [2,'Revisión y aval de decanatura: versión final de los documentos'],
    [2,'Entrega 1: documento maestro, enlace drive y tabla de anexos'],
    [2,'Entrega 2: documento pestañas SACES, versión ajustada del documento maestro, drive y tabla de anexos'],
    [3,'Revisión general de los documentos'],
    [3,'Aprobación de los documentos'],
    [4,'Montaje en plataforma nuevo SACES'],
    [4,'Información del caso'],
    [4,'Notificación de confirmación de radicación en plataforma'],
    [5,'Completitud'],
    [5,'Visita de pares académicos (no aplica por tener acreditación)'],
    [5,'Acto administrativo'],
  ];
  actRC.forEach(([fase, nombre]) => ejRow(wsA, ['22','RC',fase,nombre,'SI','NO','','','']));
  blankRow(wsA, 9);

  // Ejemplos: RC prog 23 (igual, todas completadas)
  actRC.forEach(([fase, nombre]) => ejRow(wsA, ['23','RC',fase,nombre,'SI','NO','','','']));
  blankRow(wsA, 9);

  // Ejemplos: AV prog 22 (todas completadas)
  const actAV = [
    [0,'Notificación de la apertura del proceso para solicitud de renovación de registro calificado'],
    [1,'Reunión inicial: capacitación sobre el sentido del proceso y uso de la plataforma Miró, lineamientos y plantillas'],
    [1,'Preparación interna del programa'],
    [1,'Definición de agenda y cronograma de trabajo'],
    [2,'Construcción del documento maestro, anexos, plan de mejoramiento, plantillas y cuadros CNA'],
    [2,'Reuniones parciales de avance'],
    [2,'Revisión y aval de decanatura: versión final de los documentos'],
    [2,'Entrega 1: documento maestro, enlace drive, tabla de anexos, plan de mejoramiento, plantillas y cuadros CNA'],
    [2,'Entrega 2: documentos pestañas CNA, versión ajustada del documento maestro, drive y tabla de anexos, plan de mejoramiento, plantillas y cuadros CNA'],
    [3,'Revisión general de los documentos'],
    [3,'Aprobación de los documentos'],
    [4,'Montaje en plataforma SACES CNA'],
    [4,'Información del caso'],
    [4,'Notificación de confirmación de radicación en plataforma'],
    [5,'Completitud'],
    [5,'Visita de pares académicos'],
    [5,'Acto administrativo'],
  ];
  actAV.forEach(([fase, nombre]) => ejRow(wsA, ['22','AV',fase,nombre,'SI','NO','','','']));

  // Filas en blanco para que el usuario llene debajo de los ejemplos
  for (let i = 0; i < 20; i++) {
    const row = wsA.addRow(['','','','','SI','NO','','','']);
    row.eachCell(c => { c.fill = datFill; c.border = hairBot; });
  }
  // Referencia
  sepRow(wsA, '▼ REFERENCIA — copia el nombre exacto y pégalo arriba (no borrar) ▼', 4);
  sectionRow(wsA, '── REGISTRO CALIFICADO (RC) ──', blueFill, 4);
  FASES_RC.forEach(f => f.actividades.forEach(a => refRow(wsA, ['','',f.numero,a.nombre,'SI','NO','','',''], blueFill)));
  sectionRow(wsA, '── ACREDITACIÓN VOLUNTARIA (AV) ──', purpFill, 4);
  FASES_AV.forEach(f => f.actividades.forEach(a => refRow(wsA, ['','',f.numero,a.nombre,'SI','NO','','',''], purpFill)));
  const pmDarkFill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF7B2D8B' } };
  sectionRow(wsA, '── PLAN DE MEJORAMIENTO (PM) ──', pmDarkFill, 4);
  FASES_PM.forEach(f => f.actividades.forEach(a => refRow(wsA, ['','PM',f.numero,a.nombre,'SI','NO','','',''], pmDarkFill)));

  for (let r = 2; r <= 61; r++) {
    wsA.getCell(`E${r}`).dataValidation = { type:'list', allowBlank:true, formulae:['"SI,NO"'] };
    wsA.getCell(`F${r}`).dataValidation = { type:'list', allowBlank:true, formulae:['"SI,NO"'] };
  }

  /* ──────────────────────────────────────────────────────────────
     SUBACTIVIDADES
     ────────────────────────────────────────────────────────────── */
  const wsS = wb.addWorksheet('SUBACTIVIDADES');
  addHeader(wsS, [
    'Código del programa\n(igual que PROCESOS)', 'Tipo de proceso\n(igual que PROCESOS)',
    'N° de fase\n(0 a 5)', 'Actividad padre\n(nombre exacto de la actividad)',
    'Nombre de la subactividad\n(copia exacta del bloque de referencia de abajo)',
    'Completada\n(SI / NO)', 'No aplica\n(SI / NO)',
    'Fecha de completado\n(AAAA-MM-DD)', 'Observaciones',
    'Documentos\n(links Drive — varios sep. por coma)',
  ], [22,16,12,42,58,14,14,20,35,50]);

  // Subactividades de fase 5 (Evaluación) — las únicas que normalmente tienen subactividades
  // Ejemplo RC prog 22 — completitud aprobada sin visita de pares (acreditado)
  const subCompletitudRC = [
    'Notificación de solicitud de completitud por parte del MEN',
    'Reunión para revisión de las observaciones de la completitud',
    'Elaboración de respuesta de la completitud',
    'Revisión y aval de decanatura a la respuesta de la completitud',
    'Revisión y aval de vicerrectoría a la respuesta de la completitud',
    'Radicación de respuesta a la completitud en plataforma SACES',
    'Notificación de confirmación de radicación en plataforma SACES',
  ];
  const subActAdtRC = [
    'Notificación del acto administrativo satisfactorio por parte del MEN',
    'Notificación informando a los involucrados en el proceso para fines pertinentes',
  ];
  subCompletitudRC.forEach(s => ejRow(wsS, ['22','RC',5,'Completitud',s,'SI','NO','','','']));
  subActAdtRC.forEach(s => ejRow(wsS, ['22','RC',5,'Acto administrativo',s,'SI','NO','','','']));
  blankRow(wsS, 10);

  // RC prog 23
  subCompletitudRC.forEach(s => ejRow(wsS, ['23','RC',5,'Completitud',s,'SI','NO','','','']));
  subActAdtRC.forEach(s => ejRow(wsS, ['23','RC',5,'Acto administrativo',s,'SI','NO','','','']));
  blankRow(wsS, 10);

  // AV prog 22 — completitud + visita de pares + acto administrativo
  const subCompletitudAV = [
    'Notificación de solicitud de completitud por parte del MEN',
    'Reunión para revisión de las observaciones de la completitud',
    'Elaboración de respuesta de la completitud',
    'Revisión y aval de decanatura a la respuesta de la completitud',
    'Revisión y aval de vicerrectoría a la respuesta de la completitud',
    'Radicación de respuesta a la completitud en plataforma CNA',
    'Notificación de confirmación de radicación en plataforma CNA',
  ];
  const subVisitaAV = [
    'Notificación de la visita de pares académicos por parte del MEN',
    'Coordinar la agenda y visita de pares',
    'Evaluación de visita de pares',
    'Notificación del informe de pares para comentarios del rector MEN',
    'Elaboración de respuesta a informe de pares',
    'Revisión y aval de decanatura a la respuesta a informe de pares',
    'Revisión y aval de vicerrectoría a la respuesta a informe de pares',
    'Radicación de respuesta del informe de pares en plataforma CNA',
    'Notificación de confirmación de radicación en plataforma CNA',
  ];
  const subActAdtAV = [
    'Notificación del acto administrativo satisfactorio por parte del MEN',
    'Notificación informando a los involucrados en el proceso para fines pertinentes',
  ];
  subCompletitudAV.forEach(s => ejRow(wsS, ['22','AV',5,'Completitud',s,'SI','NO','','','']));
  subVisitaAV.forEach(s => ejRow(wsS, ['22','AV',5,'Visita de pares académicos',s,'SI','NO','','','']));
  subActAdtAV.forEach(s => ejRow(wsS, ['22','AV',5,'Acto administrativo',s,'SI','NO','','','']));

  // Filas vacías para que el usuario agregue las suyas
  for (let i = 0; i < 20; i++) {
    const row = wsS.addRow(['','','','','','SI','NO','','','']);
    row.eachCell(c => { c.fill = datFill; c.border = hairBot; });
  }
  sepRow(wsS, '▼ REFERENCIA — copia el nombre exacto y pégalo arriba (no borrar) ▼', 5);
  sectionRow(wsS, '── RC fase 5 ──', blueFill, 5);
  const f5RC = FASES_RC.find(f => f.numero === 5);
  if (f5RC) f5RC.actividades.forEach(a =>
    (a.subactividades||[]).forEach(s => refRow(wsS, ['','',5,a.nombre,s.nombre,'SI','NO','','',''], blueFill))
  );
  sectionRow(wsS, '── AV fase 5 ──', purpFill, 5);
  const f5AV = FASES_AV.find(f => f.numero === 5);
  if (f5AV) f5AV.actividades.forEach(a =>
    (a.subactividades||[]).forEach(s => refRow(wsS, ['','',5,a.nombre,s.nombre,'SI','NO','','',''], purpFill))
  );
  for (let r = 2; r <= 61; r++) {
    wsS.getCell(`F${r}`).dataValidation = { type:'list', allowBlank:true, formulae:['"SI,NO"'] };
    wsS.getCell(`G${r}`).dataValidation = { type:'list', allowBlank:true, formulae:['"SI,NO"'] };
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="plantilla_importacion_historial.xlsx"');
  await wb.xlsx.write(res);
  res.end();
};

/* ════════════════════════════════════════════════════════════════
   POST /process-history/importar
   ════════════════════════════════════════════════════════════════ */
module.exports.importar = async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Se requiere el archivo en el campo "archivo".' });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(req.file.buffer);

  const wsP = wb.getWorksheet('PROCESOS');
  const wsC = wb.getWorksheet('INFO_CASO');
  const wsA = wb.getWorksheet('ACTIVIDADES');
  const wsS = wb.getWorksheet('SUBACTIVIDADES');
  if (!wsP) return res.status(400).json({ error: 'Falta la hoja "PROCESOS".' });

  function indexar(ws) {
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

  const casoIdx = indexar(wsC);
  const actIdx  = indexar(wsA);
  const subIdx  = indexar(wsS);

  const resultados = [];
  const errores    = [];
  const histPorCodigo = {};   // { `${program_code}|${codigo_res}`: historyId }

  for (let rn = 2; rn <= wsP.rowCount; rn++) {
    const row = wsP.getRow(rn);
    const program_code = str(row.getCell(1));
    if (!program_code || program_code.startsWith('──') || program_code.startsWith('▼')) continue;

    const tipo_proceso        = str(row.getCell(2)).toUpperCase();
    const subtipoRaw          = str(row.getCell(3));
    // Para PM: si el subtipo está vacío se asume "Plan de Mejoramiento AV"
    const subtipoBase         = (tipo_proceso === 'PM' && !subtipoRaw)
                                  ? 'Plan de Mejoramiento AV'
                                  : subtipoRaw;
    const subtipo             = tipo_proceso === 'RC'
                                  ? normalizarAliasSubtipoRC(subtipoBase)
                                  : subtipoBase;
    const codigo_resolucion   = str(row.getCell(4));
    const fecha_resolucion    = str(row.getCell(5)) || null;
    const duracion_resolucion = num(row.getCell(6));
    const estadoRaw           = str(row.getCell(7)).toUpperCase();
    const estado_solicitud    = ['NEGADO','CANCELADO'].includes(estadoRaw) ? estadoRaw : 'APROBADO';
    const fase_al_cierre      = num(row.getCell(8)) ?? 5;
    const linkResolucion      = str(row.getCell(9));
    const codigoResPadre      = str(row.getCell(10));

    // Fechas RC/AV/AE (cols K–S: fecha + observación, salvo vencimiento)
    const fVenc      = fecha(row.getCell(11));
    const fInicio    = fecha(row.getCell(12));
    const obsInicio  = str(row.getCell(13));
    const fDocPar    = fecha(row.getCell(14));
    const obsDocPar  = str(row.getCell(15));
    const fDigit     = fecha(row.getCell(16));
    const obsDigit   = str(row.getCell(17));
    const fRadMEN    = fecha(row.getCell(18));
    const obsRadMEN  = str(row.getCell(19));

    // Fechas PM (cols T–AA: fecha + observación)
    const fEnvioPM    = fecha(row.getCell(20));
    const obsEnvioPM  = str(row.getCell(21));
    const fEntregaPM  = fecha(row.getCell(22));
    const obsEntregaPM= str(row.getCell(23));
    const fEnvioAv    = fecha(row.getCell(24));
    const obsEnvioAv  = str(row.getCell(25));
    const fRadAv      = fecha(row.getCell(26));
    const obsRadAv    = str(row.getCell(27));

    if (!tipo_proceso) continue;
    if (!['RC','AV','AE','PM'].includes(tipo_proceso)) {
      errores.push({ fila: rn, error: `tipo_proceso inválido: "${tipo_proceso}"` }); continue;
    }
    if (tipo_proceso !== 'PM' && !fecha_resolucion && !duracion_resolucion) {
      const exentoReforma = tipo_proceso === 'RC' && subtipo === 'Reforma curricular';
      if (!exentoReforma) {
        errores.push({ fila: rn, error: 'Falta fecha_resolucion o duracion_resolucion.' }); continue;
      }
    }

    const { findProgramByProcessCode } = require('../helpers/programByCode');
    const programa = await findProgramByProcessCode(Program, program_code);
    if (!programa) {
      errores.push({ fila: rn, error: `Programa no encontrado: "${program_code}"` }); continue;
    }
    const programId = String(programa._id);
    const nombrePrograma = programa.nombre || programId;

    /* ── Calcular / usar fechas explícitas ── */
    const esPM = tipo_proceso === 'PM';
    let fechasAuto = {};
    if (!esPM && fecha_resolucion && duracion_resolucion != null) {
      fechasAuto = calcularFechasRCAV(tipo_proceso, fecha_resolucion, duracion_resolucion);
    }
    if (esPM && fecha_resolucion && duracion_resolucion != null) {
      fechasAuto = calcularFechasPM(fecha_resolucion, duracion_resolucion);
    }

    // Las fechas explícitas del Excel tienen prioridad sobre las autocalculadas
    const fechasRCAV = {
      fecha_vencimiento:      fVenc   || fechasAuto.fecha_vencimiento      || null,
      fecha_inicio:           fInicio || fechasAuto.fecha_inicio            || null,
      fecha_documento_par:    fDocPar || fechasAuto.fecha_documento_par     || null,
      fecha_digitacion_saces: fDigit  || fechasAuto.fecha_digitacion_saces  || null,
      fecha_radicado_men:     fRadMEN || fechasAuto.fecha_radicado_men      || null,
    };
    const obsRCAV = {
      obs_inicio:           obsInicio,
      obs_documento_par:    obsDocPar,
      obs_digitacion_saces: obsDigit,
      obs_radicado_men:     obsRadMEN,
    };
    const fechasPM = {
      fecha_envio_pm_vicerrectoria:     fEnvioPM   || fechasAuto.fecha_envio_pm_vicerrectoria     || null,
      fecha_entrega_pm_cna:             fEntregaPM || fechasAuto.fecha_entrega_pm_cna             || null,
      fecha_envio_avance_vicerrectoria: fEnvioAv   || fechasAuto.fecha_envio_avance_vicerrectoria || null,
      fecha_radicacion_avance_cna:      fRadAv     || fechasAuto.fecha_radicacion_avance_cna      || null,
    };
    const obsPM = {
      obs_envio_pm_vicerrectoria:     obsEnvioPM,
      obs_entrega_pm_cna:             obsEntregaPM,
      obs_envio_avance_vicerrectoria: obsEnvioAv,
      obs_radicacion_avance_cna:      obsRadAv,
    };

    const fasesBase = esPM ? FASES_PM
                    : (tipo_proceso === 'AV' || tipo_proceso === 'AE') ? FASES_AV
                    : FASES_RC;
    const claveProc = `${programId}|${tipo_proceso}`;

    /* ── Mapa de actividades y subactividades ── */
    const actMap = {};
    (actIdx[claveProc] || []).forEach(r => {
      const fn = str(r.getCell(3)); const an = str(r.getCell(4));
      if (!an || an.startsWith('──') || an.startsWith('▼')) return;
      actMap[`${fn}-${an}`] = r;
    });
    const subMap = {};
    (subIdx[claveProc] || []).forEach(r => {
      const fn = str(r.getCell(3)); const adn = str(r.getCell(4)); const sn = str(r.getCell(5));
      if (!sn || sn.startsWith('──') || sn.startsWith('▼')) return;
      subMap[`${fn}-${adn}-${sn}`] = r;
    });

    /* ── Snapshot de fases ── */
    const fasesSnapshot = fasesBase.map(fase => {
      const actividades = fase.actividades.map(act => {
        const key  = `${fase.numero}-${act.nombre}`;
        const aRow = actMap[key];
        return {
          nombre: act.nombre, responsables: act.responsables || '',
          completada:       aRow ? bool(aRow.getCell(5)) : true,
          no_aplica:        aRow ? bool(aRow.getCell(6)) : false,
          fecha_completado: aRow ? str(aRow.getCell(7)) || null : null,
          observaciones:    aRow ? str(aRow.getCell(8)) : '',
          documentos:       docsDesdeLinks('', aRow ? str(aRow.getCell(9)) : ''),
          subactividades: (act.subactividades || []).map(sub => {
            const sk   = `${fase.numero}-${act.nombre}-${sub.nombre}`;
            const sRow = subMap[sk];
            return {
              nombre: sub.nombre,
              completada:       sRow ? bool(sRow.getCell(6)) : true,
              no_aplica:        sRow ? bool(sRow.getCell(7)) : false,
              fecha_completado: sRow ? str(sRow.getCell(8)) || null : null,
              observaciones:    sRow ? str(sRow.getCell(9)) : '',
              documentos:       docsDesdeLinks('', sRow ? str(sRow.getCell(10)) : ''),
            };
          }),
        };
      });
      return {
        fase_numero: fase.numero, fase_nombre: fase.nombre,
        actividades_completadas: actividades.filter(a => a.completada).length,
        actividades_total: actividades.length,
        documentos: [], actividades,
      };
    });

    const docsRes = docsDesdeLinks(`Resolución ${codigo_resolucion || tipo_proceso}`, linkResolucion);

    /* ── Crear historial ── */
    let histDoc;
    try {
      histDoc = await ProcessHistory.create({
        program_code:       programId,
        dep_code_facultad:  programa.dep_code_facultad || null,
        nombre_programa:    nombrePrograma,
        process_id:         null,
        tipo_proceso,
        nombre_proceso:     `${tipo_proceso}${subtipo ? ` (${subtipo})` : ''} - ${nombrePrograma}`,
        subtipo:            subtipo || null,
        codigo_resolucion:  codigo_resolucion || null,
        fecha_resolucion,
        duracion_resolucion,
        ...(esPM ? fechasPM : fechasRCAV),
        ...(esPM ? obsPM : obsRCAV),
        fase_al_cierre,
        estado_solicitud,
        fases:              fasesSnapshot,
        documentos_proceso: docsRes,
      });
    } catch (e) {
      errores.push({ fila: rn, error: `Error al crear historial: ${e.message}` }); continue;
    }

    // Registrar para linking posterior
    if (codigo_resolucion) histPorCodigo[`${programId}|${codigo_resolucion}`] = histDoc._id;

    /* ── Linking RC de oficio → AV padre  /  PM → AV/AE padre ── */
    const esRcOficio = tipo_proceso === 'RC' && subtipo === 'Registro calificado de oficio';
    if ((esRcOficio || esPM) && codigoResPadre) {
      let padreId = histPorCodigo[`${programId}|${codigoResPadre}`] ?? null;
      if (!padreId) {
        const padreHist = await ProcessHistory.findOne({
          program_code: programId,
          tipo_proceso: esPM ? { $in: ['AV','AE'] } : 'AV',
          codigo_resolucion: codigoResPadre,
        }).select('_id').lean();
        padreId = padreHist?._id ?? null;
      }
      if (padreId) {
        if (esRcOficio) {
          await ProcessHistory.findByIdAndUpdate(padreId, { rc_oficio_history_id: histDoc._id });
        } else {
          // PM: actualizar padre con pm_history_id y el PM con parent_history_id
          await ProcessHistory.findByIdAndUpdate(padreId, { pm_history_id: histDoc._id });
          await ProcessHistory.findByIdAndUpdate(histDoc._id, { parent_history_id: padreId });
        }
      } else {
        errores.push({ fila: rn, advertencia: `Historial creado, pero no se encontró el padre con código "${codigoResPadre}".` });
      }
    }

    if (tipo_proceso === 'RC' && estado_solicitud === 'APROBADO' && SUBTIPOS_REFORMA_IMPORT.includes(subtipo)) {
      const { cambios, updateProg } = programaCambiosDesdeFilaProcesos(row, programa);
      if (cambios.length > 0) {
        try {
          await ProcessHistory.findByIdAndUpdate(histDoc._id, { $set: { programa_cambios: cambios } });
          if (Object.keys(updateProg).length > 0) {
            await Program.findByIdAndUpdate(programa._id, { $set: updateProg });
          }
        } catch (e) {
          errores.push({ fila: rn, advertencia: `Historial creado, pero falló la actualización por reforma: ${e.message}` });
        }
      }
    }

    /* ── INFO_CASO ── */
    const casoRows = filasInfoCaso(casoIdx, programId, program_code, tipo_proceso);
    if (casoRows.length > 0) {
      const Caso = require('../models/casos');
      const cr = casoRows[0];
      try {
        /* Columnas INFO_CASO:
           A=1  program_code    B=2  tipo_proceso    C=3  codigo_caso
           D=4  fecha_sol_rad   E=5  obs_sol_rad     F=6  link_doc_solicitud_radicado
           G=7  fecha_notif     H=8  obs_notif       I=9  link_doc_notif_completitud
           J=10 fecha_resp_comp K=11 obs_resp_comp   L=12 link_doc_respuesta_completitud
           M=13 fecha_resol     N=14 obs_resol       O=15 link_doc_resolucion
           P=16 resol_aprobada  Q=17 aplica_apel
           R=18 fecha_res_apel  S=19 obs_res_apel    T=20 link_doc_resolucion_apelacion
           U=21 fecha_resp_men  V=22 obs_resp_men    W=23 link_doc_respuesta_men        */
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

        /* Guardar documentos por campo en ProcessDocuments con caso_date_key */
        const ProcessDoc = require('../models/processDocuments');
        const casoDocMap = [
          { key: 'fecha_solicitud_radicado',       linksStr: str(cr.getCell(6)) },
          { key: 'fecha_notificacion_completitud', linksStr: str(cr.getCell(9)) },
          { key: 'fecha_respuesta_completitud',    linksStr: str(cr.getCell(12)) },
          { key: 'fecha_resolucion',               linksStr: str(cr.getCell(15)) },
          { key: 'fecha_resolucion_apelacion',     linksStr: str(cr.getCell(20)) },
          { key: 'fecha_respuesta_men',            linksStr: str(cr.getCell(23)) },
        ];
        for (const { key, linksStr } of casoDocMap) {
          if (!linksStr) continue;
          const links = linksStr.split(',').map(s => s.trim()).filter(Boolean);
          for (const link of links) {
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

        const { buildCasoSnapshot } = require('../helpers/casoSnapshotHistorial');
        const casoSnapshot = await buildCasoSnapshot(histDoc._id, undefined, fasesSnapshot);
        if (casoSnapshot) {
          await ProcessHistory.findByIdAndUpdate(histDoc._id, { $set: { caso_snapshot: casoSnapshot } });
        }
      } catch (e) {
        errores.push({ fila: rn, advertencia: `Historial creado, pero falló INFO_CASO: ${e.message}` });
      }
    }

    /* ── Vigencia en ficha + contadores (APROBADO RC/AV/AE, como cierre en app) ── */
    let vigencia_actualizada = false;
    let total_rc = null;
    let total_av = null;
    const esNegado = ['NEGADO', 'CANCELADO'].includes(estado_solicitud);
    if (estado_solicitud === 'APROBADO' && ['RC', 'AV', 'AE'].includes(tipo_proceso)) {
      try {
        const vig = await aplicarVigenciaProgramaImport(
          programa,
          histDoc,
          tipo_proceso,
          subtipo,
          docsRes[0]?.view_link ?? null,
        );
        vigencia_actualizada = vig.vigencia_actualizada === true;
        total_rc = vig.total_rc ?? null;
        total_av = vig.total_av ?? null;
      } catch (e) {
        errores.push({ fila: rn, advertencia: `Historial OK; falló vigencia/contadores en programa: ${e.message}` });
      }
    } else if (['RC', 'AV', 'AE'].includes(tipo_proceso)) {
      const totalRC = await countRcHistorialContable(programId);
      const totalAV = await ProcessHistory.countDocuments({ program_code: programId, tipo_proceso: 'AV' });
      await Program.findByIdAndUpdate(programa._id, { $set: { total_rc: totalRC, total_av: totalAV } });
      total_rc = totalRC;
      total_av = totalAV;
    }

    /* ── ALERTA (no aplica a RC Reforma curricular: proceso interno sin alerta poscierre) ── */
    const esReformaSoloSinAlerta = tipo_proceso === 'RC' && subtipo === 'Reforma curricular';
    let alertaId = null;
    let alerta_actualizada = false;
    if (!esNegado && !esReformaSoloSinAlerta) {
      try {
        const alertaData = {
          name:                       `Alerta (${tipo_proceso}) - ${nombrePrograma}`,
          program_code:               programId,
          tipo_proceso:               'ALERTA',
          alert_para_tipo:            tipo_proceso,
          subtipo:                    subtipo || null,
          fase_actual:                0,
          snapshot_codigo_resolucion: codigo_resolucion || null,
          snapshot_fecha_resolucion:  fecha_resolucion,
          snapshot_duracion_anos:     duracion_resolucion,
          cerrado_process_history_id: histDoc._id,
          ...(esPM ? fechasPM : fechasRCAV),
        };
        const alertaExistente = await Process.findOne({
          program_code: programId,
          tipo_proceso: 'ALERTA',
          alert_para_tipo: tipo_proceso,
        }).select('_id').lean();
        if (alertaExistente) {
          await Process.findByIdAndUpdate(alertaExistente._id, { $set: alertaData });
          alertaId = alertaExistente._id;
          alerta_actualizada = true;
        } else {
          const alerta = await Process.create(alertaData);
          alertaId = alerta._id;
        }
      } catch (e) {
        errores.push({ fila: rn, advertencia: `Historial creado (id: ${histDoc._id}), falló la ALERTA: ${e.message}` });
      }
    }

    resultados.push({
      fila: rn,
      program_code: programId,
      tipo_proceso,
      subtipo,
      history_id: histDoc._id,
      alerta_creada: !!alertaId && !alerta_actualizada,
      alerta_actualizada,
      alerta_id: alertaId,
      vigencia_actualizada,
      total_rc,
      total_av,
    });
  }

  res.status(200).json({
    message: `Importación completada. ${resultados.length} proceso(s) importado(s). ${errores.length} error(es).`,
    importados: resultados,
    errores,
  });
};

/* ════════════════════════════════════════════════════════════════
   POST /process-history/revertir
   ════════════════════════════════════════════════════════════════ */
module.exports.revertir = async (req, res) => {
  const { history_ids } = req.body;
  if (!Array.isArray(history_ids) || history_ids.length === 0)
    return res.status(400).json({ error: 'Se requiere history_ids (array de IDs).' });

  const alertasDel = await Process.deleteMany({
    tipo_proceso: 'ALERTA',
    cerrado_process_history_id: { $in: history_ids },
  });
  const histDel = await ProcessHistory.deleteMany({ _id: { $in: history_ids } });

  res.json({
    message: `Revertidos: ${histDel.deletedCount} historial(es) y ${alertasDel.deletedCount} alerta(s) eliminados.`,
  });
};
