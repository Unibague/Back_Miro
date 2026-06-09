const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const Macroproyecto = require('../models/pdiMacroproyecto');
const Proyecto = require('../models/pdiProyecto');
const AccionEstrategica = require('../models/pdiAccionEstrategica');

const SPREADSHEET_ID = '1pGQkA-nu5kmy8HviHM4YzmC3AOmFrGoTS_X8U93f9YI';
const SUMMARY_RANGE  = 'Proyecto 2026!A:Z';
const CACHE_TTL_MS   = 60 * 1000;

let cache = { data: null, timestamp: 0 };

const KEY_FILE = (() => {
  const root = path.join(__dirname, '..');
  try {
    const miro = fs.readdirSync(root)
      .filter((f) => f.endsWith('.json') && f.startsWith('miro-'))
      .map((f) => path.join(root, f))
      .find((p) => fs.existsSync(p));
    if (miro) return miro;
  } catch { /* ignore */ }
  const fallback = path.join(root, 'google-credentials.json');
  return fs.existsSync(fallback) ? fallback : undefined;
})();

const keyData = KEY_FILE ? JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')) : null;
const auth = keyData
  ? new google.auth.JWT({
      email: keyData.client_email,
      key: keyData.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    })
  : null;

const sheetsService = google.sheets({ version: 'v4', auth });

// ── Helpers ────────────────────────────────────────────────────────────────

const normalizeNum = (val) => {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (val === null || val === undefined || val === '') return 0;
  let str = String(val).trim().replace(/\$/g, '').replace(/\s+/g, '');
  if (!str) return 0;

  const hasComma = str.includes(',');
  const hasDot = str.includes('.');
  if (hasComma) {
    str = str.replace(/\./g, '').replace(',', '.');
  } else if (hasDot) {
    const parts = str.split('.');
    const thousandsLike = parts.length > 1 && parts.slice(1).every((part) => /^\d{3}$/.test(part));
    if (thousandsLike) str = parts.join('');
  }

  const n = Number(str);
  return Number.isFinite(n) ? n : 0;
};

const normalizeText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const findCol = (headers, labels, fallback, { exact = false } = {}) => {
  const normalizedLabels = labels.map(normalizeText);
  const idx = headers.findIndex((header) => {
    const normalizedHeader = normalizeText(header);
    return exact
      ? normalizedLabels.includes(normalizedHeader)
      : normalizedLabels.some((label) => normalizedHeader.includes(label));
  });
  return idx !== -1 ? idx : fallback;
};

const valueOrSplit = (value, ...splits) => {
  const parsed = normalizeNum(value);
  if (parsed) return parsed;
  return splits.reduce((acc, item) => acc + (Number(item) || 0), 0);
};

const normalizeSystemCode = (value) => String(value || '')
  .toUpperCase()
  .replace(/[^A-Z0-9-]/g, '')
  .trim();

const extractProjectCodeFromActionCode = (value) => {
  const match = normalizeSystemCode(value).match(/^(M\d+)-P(\d+)/);
  return match ? `${match[1]}-P${Number(match[2])}` : '';
};

const cleanCellText = (value) => String(value || '')
  .replace(/[ \t]+/g, ' ')
  .replace(/\r\n/g, '\n')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

const cleanHierarchyName = (value) => normalizeText(
  String(value || '')
    .replace(/^macroproyecto\s*\d+\s*[:.-]?\s*/i, '')
    .replace(/^proyecto\s*:\s*/i, '')
    .replace(/^\d+(?:\.\d+)*\s*/, '')
);

const extractMacroNumber = (value) => {
  const text = String(value || '');
  const match = text.match(/macroproyecto\s*(\d+)/i)
    || text.match(/^M?(\d+)\b/i)
    || text.match(/\b(\d+)\./);
  return match ? String(Number(match[1])) : '';
};

const extractProjectNumber = (value) => {
  const match = String(value || '').match(/\b(\d+)\.(\d+)\b/);
  return match ? `${Number(match[1])}.${Number(match[2])}` : '';
};

const buildImportedCausedByProject = (acciones = []) => {
  const byProject = new Map();

  for (const accion of acciones) {
    const projectCode = normalizeSystemCode(accion.proyecto_id?.codigo);
    if (!projectCode) continue;

    const gasto = Number(accion.gasto) || 0;
    const inversion = Number(accion.inversion) || 0;
    const total = gasto + inversion || Number(accion.presupuesto_ejecutado) || 0;
    if (!total) continue;

    const current = byProject.get(projectCode) || { gasto: 0, inversion: 0, causado: 0 };
    current.gasto += gasto;
    current.inversion += inversion;
    current.causado += total;
    byProject.set(projectCode, current);
  }

  return byProject;
};

const buildImportedCausedByAction = (acciones = []) => {
  const byAction = new Map();

  for (const accion of acciones) {
    const actionCode = normalizeSystemCode(accion.codigo);
    if (!actionCode) continue;

    let gasto = Number(accion.gasto) || 0;
    let inversion = Number(accion.inversion) || 0;
    const total = gasto + inversion || Number(accion.presupuesto_ejecutado) || 0;
    if (!total) continue;

    if (!gasto && !inversion) gasto = total;
    byAction.set(actionCode, { gasto, inversion, causado: gasto + inversion });
  }

  return byAction;
};

const buildSystemIndex = (macros = [], proyectos = [], acciones = []) => {
  const macroByName = new Map();
  const macroByNumber = new Map();
  const projectByName = new Map();
  const projectByNumber = new Map();
  const projectByCode = new Map();
  const importedCausedByProject = buildImportedCausedByProject(acciones);
  const importedCausedByAction = buildImportedCausedByAction(acciones);

  for (const macro of macros) {
    const code = normalizeSystemCode(macro.codigo);
    const number = extractMacroNumber(code);
    const name = cleanHierarchyName(macro.nombre);
    if (name && !macroByName.has(name)) macroByName.set(name, macro);
    if (number && !macroByNumber.has(number)) macroByNumber.set(number, macro);
  }

  for (const proyecto of proyectos) {
    const code = normalizeSystemCode(proyecto.codigo);
    const number = extractProjectNumber(code.replace(/^M/, '').replace('-P', '.'));
    const name = cleanHierarchyName(proyecto.nombre);
    if (code && !projectByCode.has(code)) projectByCode.set(code, proyecto);
    if (name && !projectByName.has(name)) projectByName.set(name, proyecto);
    if (number && !projectByNumber.has(number)) projectByNumber.set(number, proyecto);
  }

  return { macroByName, macroByNumber, projectByName, projectByNumber, projectByCode, importedCausedByProject, importedCausedByAction };
};

const resolveByName = (map, label) => {
  const name = cleanHierarchyName(label);
  if (!name) return null;
  if (map.has(name)) return map.get(name);

  for (const [key, value] of map) {
    if (name.length > 6 && (key.includes(name) || name.includes(key))) return value;
  }
  return null;
};

const resolveMacro = (systemIndex, ...labels) => {
  for (const label of labels) {
    const number = extractMacroNumber(label);
    if (number && systemIndex.macroByNumber.has(number)) return systemIndex.macroByNumber.get(number);
    const byName = resolveByName(systemIndex.macroByName, label);
    if (byName) return byName;
  }
  return null;
};

const resolveProject = (systemIndex, ...labels) => {
  for (const label of labels) {
    const projectCode = extractProjectCodeFromActionCode(label) || normalizeSystemCode(label);
    if (projectCode && systemIndex.projectByCode?.has(projectCode)) return systemIndex.projectByCode.get(projectCode);
    const number = extractProjectNumber(label);
    if (number && systemIndex.projectByNumber.has(number)) return systemIndex.projectByNumber.get(number);
    const byName = resolveByName(systemIndex.projectByName, label);
    if (byName) return byName;
  }
  return null;
};

const macroSystemLabel = (macro, fallback) => (
  macro?.codigo ? `${macro.codigo} - ${macro.nombre || ''}`.trim() : fallback
);

const detailProjectNameKey = (value) => {
  const cleaned = cleanHierarchyName(value);
  return cleaned ? `project:${cleaned}` : '';
};

const pushDetail = (map, key, detail) => {
  if (!key) return;
  const current = map.get(key) || [];
  current.push(detail);
  map.set(key, current);
};

const getDetailsForProject = (detailsByProject, projectCode, rawProject) => {
  if (!detailsByProject) return [];

  const keys = [
    normalizeSystemCode(projectCode),
    detailProjectNameKey(rawProject),
  ].filter(Boolean);

  const seen = new Set();
  const details = [];

  for (const key of keys) {
    for (const detail of detailsByProject.get(key) || []) {
      const detailKey = detail.rowIndex || `${detail.autorizacion}|${detail.codificacion}|${detail.valor}`;
      if (seen.has(detailKey)) continue;
      seen.add(detailKey);
      details.push(detail);
    }
  }

  return details;
};

const distributeImportedCaused = (details, amount, field) => {
  if (!details.length || !amount) return;

  const totalValue = details.reduce((acc, detail) => acc + (Number(detail.valor) || 0), 0);
  const equalAmount = amount / details.length;

  for (const detail of details) {
    const weight = totalValue > 0 ? (Number(detail.valor) || 0) / totalValue : 0;
    detail[field] += totalValue > 0 ? amount * weight : equalAmount;
    detail.causado = detail.causadoGasto + detail.causadoInversion;
  }
};

const applyImportedCausedByAction = (detailsByAction, importedCausedByAction) => {
  if (!importedCausedByAction) return;

  for (const [actionCode, details] of detailsByAction.entries()) {
    const imported = importedCausedByAction.get(actionCode);
    if (!imported?.causado) continue;
    if (details.some((detail) => detail.causado > 0 || detail.causadoGasto > 0 || detail.causadoInversion > 0)) {
      continue;
    }

    const gastoDetails = details.filter((detail) => !normalizeText(detail.tipo).includes('inversion'));
    const inversionDetails = details.filter((detail) => normalizeText(detail.tipo).includes('inversion'));
    const gasto = imported.gasto || (!imported.inversion ? imported.causado : 0);
    const inversion = imported.inversion || 0;

    distributeImportedCaused(gastoDetails.length ? gastoDetails : details, gasto, 'causadoGasto');
    distributeImportedCaused(inversionDetails.length ? inversionDetails : details, inversion, 'causadoInversion');
  }
};

// ── Parser ─────────────────────────────────────────────────────────────────
// Estructura real de la hoja:
// Col 0: N° autorización | Col 1: Centro de costo (macroproyecto)
// Col 2: Proyecto        | Col 3: Acción estratégica | Col 4: Tipo (Gasto/Inversión)
// Col 10: Valor (comprometido) | Col 20: Causado gasto | Col 21: Causado inversión

const parseAuthorizationRows = (rows) => {
  if (rows.length < 2) return [];

  const headers = rows[0] || [];

  // Detectar columnas por cabecera (con fallback a índice fijo)
  const findCol = (keywords, fallback) => {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const idx = headers.findIndex((h) => keywords.some((k) => norm(h).includes(norm(k))));
    return idx !== -1 ? idx : fallback;
  };

  const colMacro        = findCol(['centro de costo', 'macroproyecto', 'macro'], 1);
  const colProyecto     = findCol(['proyecto'], 2);
  const colCodificacion = findCol(['codificacion', 'codificación', 'codigo', 'código'], 3);
  const colTipo         = findCol(['tipo'], 5);
  const colValor        = findCol(['valor'], 11);
  const colCausGasto    = findCol(['causado gasto'], 21);
  const colCausInv      = findCol(['causado inversion', 'causado inversión'], 22);

  const groups = {};

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const macroproyecto = String(row[colMacro]        || '').trim();
    const proyecto      = String(row[colProyecto]     || '').trim();
    const codificacion  = String(row[colCodificacion] || '').trim();
    if (!macroproyecto && !proyecto && !codificacion) continue;

    const tipo  = String(row[colTipo] || '').trim().toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
    const valor       = normalizeNum(row[colValor]);
    const causGasto   = normalizeNum(row[colCausGasto]);
    const causInv     = normalizeNum(row[colCausInv]);

    const key = `${macroproyecto}||${codificacion || proyecto}`;
    if (!groups[key]) {
      groups[key] = {
        macroproyecto,
        proyecto,
        codificacion,
        presupuesto:           0,
        presupuestoGasto:      0,
        presupuestoInversion:  0,
        comprometidoGasto:     0,
        comprometidoInversion: 0,
        comprometido:          0,
        causadoGasto:          0,
        causadoInversion:      0,
        causado:               0,
        autorizaciones:        0,
      };
    }

    const g = groups[key];
    if (tipo === 'gasto') {
      g.comprometidoGasto += valor;
    } else if (tipo === 'inversion') {
      g.comprometidoInversion += valor;
    } else {
      g.comprometidoGasto += valor;
    }
    g.comprometido       += valor;
    g.causadoGasto       += causGasto;
    g.causadoInversion   += causInv;
    g.causado            += causGasto + causInv;
    g.autorizaciones     += 1;
  }

  return Object.values(groups);
};

const parseBudgetDetailsRows = (rows, systemIndex) => {
  if (rows.length < 2) return new Map();

  const headers = rows[0] || [];
  const colAutorizacion = findCol(headers, ['n autorizacion', 'numero autorizacion'], 0);
  const colMacro        = findCol(headers, ['centro de costo', 'macroproyecto', 'macro'], 1);
  const colProyecto     = findCol(headers, ['proyecto'], 2, { exact: true });
  const colCodificacion = findCol(headers, ['codificacion', 'codigo'], 3);
  const colAccion       = findCol(headers, ['accion estrategica'], 4);
  const colTipo         = findCol(headers, ['tipo'], 5, { exact: true });
  const colTercero      = findCol(headers, ['tercero proveedor', 'contratista'], 7);
  const colDescripcion  = findCol(headers, ['descripcion'], 8);
  const colResponsable  = findCol(headers, ['responsable del activo'], 9);
  const colAutorizacionFirmas = findCol(
    headers,
    ['autorizacion 4 firmas', 'autorizaciones 4 firmas', 'autorizacion cuatro firmas', 'autorizaciones cuatro firmas', '4 firmas'],
    20
  );
  const colValor        = findCol(headers, ['valor'], 11, { exact: true });
  const colCausGasto    = findCol(headers, ['causado gasto'], 21);
  const colCausInv      = findCol(headers, ['causado inversion'], 22);

  const detailsByProject = new Map();
  const detailsByAction = new Map();

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    const rawProject = cleanCellText(row[colProyecto]);
    const codificacion = cleanCellText(row[colCodificacion]);
    const descripcion = cleanCellText(row[colDescripcion]);
    const accionEstrategica = cleanCellText(row[colAccion]);
    const valor = normalizeNum(row[colValor]);
    const causadoGasto = normalizeNum(row[colCausGasto]);
    const causadoInversion = normalizeNum(row[colCausInv]);

    if (!rawProject && !codificacion && !descripcion && !valor && !causadoGasto && !causadoInversion) {
      continue;
    }

    const proyecto = resolveProject(systemIndex, rawProject, codificacion);
    const projectCode = normalizeSystemCode(proyecto?.codigo || extractProjectCodeFromActionCode(codificacion));
    const detail = {
      rowIndex: index + 1,
      autorizacion: cleanCellText(row[colAutorizacion]),
      macroproyecto: cleanCellText(row[colMacro]),
      proyecto: proyecto?.nombre || rawProject,
      proyectoCodigo: projectCode,
      codificacion,
      accionEstrategica,
      tipo: cleanCellText(row[colTipo]),
      tercero: cleanCellText(row[colTercero]),
      descripcion,
      responsableActivo: cleanCellText(row[colResponsable]),
      autorizacionFirmas: cleanCellText(row[colAutorizacionFirmas]),
      documentos: cleanCellText(row[colAutorizacionFirmas]),
      valor,
      causadoGasto,
      causadoInversion,
      causado: causadoGasto + causadoInversion,
    };

    pushDetail(detailsByProject, projectCode, detail);
    pushDetail(detailsByProject, detailProjectNameKey(rawProject), detail);
    pushDetail(detailsByAction, normalizeSystemCode(codificacion), detail);
  }

  return detailsByProject;
};

const parseProjectSummaryRows = (rows, headers, systemIndex, detailsByProject) => {
  const colCentro        = findCol(headers, ['centro de costo'], 0);
  const colMacro         = findCol(headers, ['macroproyecto'], 1, { exact: true });
  const colProyecto      = findCol(headers, ['proyecto'], 2, { exact: true });
  const colAccion        = findCol(headers, ['accion estrategica', 'acción estratégica', 'accion', 'acción'], 3);
  const colAutorizacion  = findCol(headers, ['n autorizaciones', 'numero autorizaciones'], 11);
  const colPresGasto     = findCol(headers, ['gasto'], 12, { exact: true });
  const colPresInv       = findCol(headers, ['inversion'], 13, { exact: true });
  const colPresTotal     = findCol(headers, ['total presupuesto'], 14);
  const colCompGasto     = findCol(headers, ['comprometido gasto'], 15);
  const colCompInv       = findCol(headers, ['comprometido inversion'], 16);
  const colCompTotal     = findCol(headers, ['total comprometido'], 17);
  const colCausGasto     = findCol(headers, ['causado gasto'], 18);
  const colCausInv       = findCol(headers, ['causado inversion'], 19);
  const colCausTotal     = findCol(headers, ['total causado'], 20);

  return rows.slice(1).map((row = [], index) => {
    const rawMacro = String(row[colCentro] || '').trim();
    const rawMacroName = String(row[colMacro] || '').trim();
    const rawProject = String(row[colProyecto] || '').trim();
    const rawAccion = String(row[colAccion] || '').trim();
    const normalizedMacro = normalizeText(rawMacro);
    const normalizedProject = normalizeText(rawProject);
    if ((!rawMacro && !rawProject) || normalizedMacro === 'total' || normalizedProject === 'total') {
      return null;
    }

    const macro = resolveMacro(systemIndex, rawMacroName, rawMacro);
    const proyecto = resolveProject(systemIndex, rawProject);
    const presupuestoGasto = normalizeNum(row[colPresGasto]);
    const presupuestoInversion = normalizeNum(row[colPresInv]);
    const comprometidoGasto = normalizeNum(row[colCompGasto]);
    const comprometidoInversion = normalizeNum(row[colCompInv]);
    const causadoGasto = normalizeNum(row[colCausGasto]);
    const causadoInversion = normalizeNum(row[colCausInv]);
    const causado = valueOrSplit(row[colCausTotal], causadoGasto, causadoInversion);

    const codificacion = proyecto?.codigo || '';

    return {
      macroproyecto: macroSystemLabel(macro, rawMacro),
      proyecto: proyecto?.nombre || rawProject,
      codificacion,
      accionEstrategica: rawAccion,
      presupuesto: valueOrSplit(row[colPresTotal], presupuestoGasto, presupuestoInversion),
      presupuestoGasto,
      presupuestoInversion,
      comprometidoGasto,
      comprometidoInversion,
      comprometido: valueOrSplit(row[colCompTotal], comprometidoGasto, comprometidoInversion),
      causadoGasto,
      causadoInversion,
      causado,
      autorizaciones: normalizeNum(row[colAutorizacion]),
      rowIndex: index + 2,
      detalles: getDetailsForProject(detailsByProject, codificacion, rawProject),
    };
  }).filter(Boolean);
};

const parseRows = (rows, systemIndex = buildSystemIndex(), detailsByProject = new Map()) => {
  if (rows.length < 2) return [];
  const headers = rows[0] || [];
  const hasProjectSummary = findCol(headers, ['total presupuesto'], -1) !== -1
    && findCol(headers, ['total comprometido'], -1) !== -1;

  return hasProjectSummary
    ? parseProjectSummaryRows(rows, headers, systemIndex, detailsByProject)
    : parseAuthorizationRows(rows);
};

// ── Controller ─────────────────────────────────────────────────────────────

const controller = {};

controller.getData = async (req, res) => {
  if (!auth) {
    return res.status(500).json({ message: 'Credenciales de Google no encontradas en el servidor.' });
  }

  const forceRefresh = req.query.refresh === 'true';

  try {
    const now = Date.now();
    if (!forceRefresh && cache.data && now - cache.timestamp < CACHE_TTL_MS) {
      return res.status(200).json(cache.data);
    }

    const [summaryResponse, detailResponse, macros, proyectos, accionesConCausado] = await Promise.all([
      sheetsService.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: SUMMARY_RANGE,
      }),
      sheetsService.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'PDI!A:W',
      }).catch((error) => {
        console.warn('No se pudo leer el detalle PDI:', error.message);
        return { data: { values: [] } };
      }),
      Macroproyecto.find({}, 'codigo nombre').lean(),
      Proyecto.find({}, 'codigo nombre').lean(),
    ]);

    const rows = summaryResponse.data.values || [];
    const detailRows = detailResponse.data.values || [];
    const systemIndex = buildSystemIndex(macros, proyectos);
    const detailsByProject = parseBudgetDetailsRows(detailRows, systemIndex);
    const parsed = parseRows(rows, systemIndex, detailsByProject);

    const totals = parsed.reduce(
      (acc, r) => ({
        presupuesto:            acc.presupuesto            + (r.presupuesto || 0),
        presupuestoGasto:       acc.presupuestoGasto       + (r.presupuestoGasto || 0),
        presupuestoInversion:   acc.presupuestoInversion   + (r.presupuestoInversion || 0),
        comprometido:           acc.comprometido           + r.comprometido,
        comprometidoGasto:      acc.comprometidoGasto      + r.comprometidoGasto,
        comprometidoInversion:  acc.comprometidoInversion  + r.comprometidoInversion,
        causado:                acc.causado                + r.causado,
        causadoGasto:           acc.causadoGasto           + r.causadoGasto,
        causadoInversion:       acc.causadoInversion       + r.causadoInversion,
      }),
      { presupuesto: 0, presupuestoGasto: 0, presupuestoInversion: 0, comprometido: 0, comprometidoGasto: 0, comprometidoInversion: 0, causado: 0, causadoGasto: 0, causadoInversion: 0 }
    );

    const result = { rows: parsed, totals, updatedAt: new Date().toISOString() };
    cache = { data: result, timestamp: Date.now() };
    return res.status(200).json(result);
  } catch (error) {
    console.error('Error leyendo presupuesto PDI:', error.message);
    if (cache.data) return res.status(200).json({ ...cache.data, stale: true });
    return res.status(500).json({
      message: 'Error al leer la hoja de presupuesto.',
      error: error.message,
    });
  }
};

// Retorna los códigos de macroproyecto ligados al usuario y si es líder de alguno
controller.getUserMacros = async (req, res) => {
  const email = String(req.query.email || '').toLowerCase().trim();
  if (!email) return res.json({ codes: [], isLider: false });

  try {
    const codes = new Set();
    let isLider = false;

    // Líder de macroproyecto
    const macrosLider = await Macroproyecto.find(
      { lider_email: email }, 'codigo'
    ).lean();
    if (macrosLider.length > 0) {
      isLider = true;
      macrosLider.forEach((m) => { if (m.codigo) codes.add(m.codigo.trim()); });
    }

    // Responsable de proyecto → obtener el macroproyecto del proyecto
    const proyectos = await Proyecto.find(
      { responsable_email: email }, 'macroproyecto_id'
    ).lean();
    if (proyectos.length > 0) {
      const macroIds = proyectos.map((p) => p.macroproyecto_id).filter(Boolean);
      if (macroIds.length > 0) {
        const macros = await Macroproyecto.find(
          { _id: { $in: macroIds } }, 'codigo'
        ).lean();
        macros.forEach((m) => { if (m.codigo) codes.add(m.codigo.trim()); });
      }
    }

    return res.json({ codes: [...codes], isLider });
  } catch (err) {
    return res.status(500).json({ codes: [], isLider: false, error: err.message });
  }
};

controller.invalidateCache = () => {
  cache = { data: null, timestamp: 0 };
};

module.exports = controller;
