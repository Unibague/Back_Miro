const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const AccionEstrategica = require('../models/pdiAccionEstrategica');
const { normalizeCode } = require('../services/pdiBudgetImport');

const SPREADSHEET_ID = '1pGQkA-nu5kmy8HviHM4YzmC3AOmFrGoTS_X8U93f9YI';
const CACHE_TTL_MS = 60 * 1000;

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
  if (val === null || val === undefined || val === '') return 0;
  const str = String(val).replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(str);
  return Number.isNaN(n) ? 0 : n;
};

// ── Parser ─────────────────────────────────────────────────────────────────
// Estructura real de la hoja:
// Col 0: N° autorización | Col 1: Centro de costo (macroproyecto)
// Col 2: Proyecto        | Col 3: Acción estratégica | Col 4: Tipo (Gasto/Inversión)
// Col 10: Valor (comprometido) | Col 20: Causado gasto | Col 21: Causado inversión

const parseRows = (rows) => {
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
  const colTipo         = findCol(['tipo'], 4);
  const colValor        = findCol(['valor'], 10);
  const colCausGasto    = findCol(['causado gasto'], 20);
  const colCausInv      = findCol(['causado inversion', 'causado inversión'], 21);

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
    g.comprometido    += valor;
    g.causadoGasto    += causGasto;
    g.causadoInversion += causInv;
    g.causado         += causGasto + causInv;
    g.autorizaciones  += 1;
  }

  return Object.values(groups);
};

const codeVariants = (value) => {
  const normalized = normalizeCode(value);
  if (!normalized) return [];

  const variants = new Set([normalized]);
  variants.add(normalized.replace(/-AE(\d+)$/i, '-A$1'));
  variants.add(normalized.replace(/-A(\d+)$/i, '-AE$1'));
  return Array.from(variants);
};

const getImportedSplit = (accion, row = {}) => {
  const ejecutado = Number(accion.presupuesto_ejecutado) || 0;
  const gasto = Number(accion.gasto) || 0;
  const inversion = Number(accion.inversion) || 0;

  let causadoGasto = gasto;
  let causadoInversion = inversion;

  if (!causadoGasto && !causadoInversion && ejecutado > 0) {
    if ((row.comprometidoInversion || 0) > 0 && !(row.comprometidoGasto || 0)) {
      causadoInversion = ejecutado;
    } else {
      causadoGasto = ejecutado;
    }
  }

  return {
    ejecutado,
    causadoGasto,
    causadoInversion,
    causado: causadoGasto + causadoInversion || ejecutado,
  };
};

const macroLabel = (macro) => {
  if (!macro) return 'Sin centro de costos';
  const code = String(macro.codigo || '').replace(/^M/i, '');
  return code ? `${code}. ${macro.nombre}` : macro.nombre || 'Sin centro de costos';
};

const applyImportedExecution = async (rows) => {
  const acciones = await AccionEstrategica.find(
    {},
    'codigo nombre presupuesto presupuesto_ejecutado gasto inversion proyecto_id'
  )
    .populate({
      path: 'proyecto_id',
      select: 'codigo nombre macroproyecto_id',
      populate: { path: 'macroproyecto_id', select: 'codigo nombre' },
    })
    .lean();

  const accionesPorCodigo = new Map();
  for (const accion of acciones) {
    for (const key of codeVariants(accion.codigo)) {
      if (key && !accionesPorCodigo.has(key)) accionesPorCodigo.set(key, accion);
    }
  }

  const usadas = new Set();
  const mergedRows = rows.map((row) => {
    const accion = codeVariants(row.codificacion)
      .map((key) => accionesPorCodigo.get(key))
      .find(Boolean);
    if (!accion) return row;

    const split = getImportedSplit(accion, row);
    usadas.add(String(accion._id));

    return {
      ...row,
      presupuesto: Number(accion.presupuesto) || row.presupuesto || 0,
      causadoGasto: split.causado ? split.causadoGasto : row.causadoGasto,
      causadoInversion: split.causado ? split.causadoInversion : row.causadoInversion,
      causado: split.causado || row.causado,
      fuenteCausado: split.causado ? 'importado' : row.fuenteCausado,
    };
  });

  const extraRows = acciones
    .filter((accion) => !usadas.has(String(accion._id)))
    .map((accion) => {
      const split = getImportedSplit(accion);
      if (!split.causado && !accion.presupuesto) return null;

      const proyecto = accion.proyecto_id || {};
      const macro = proyecto.macroproyecto_id;
      const presupuesto = Number(accion.presupuesto) || 0;
      const comprometido = Number(accion.presupuesto) || 0;

      return {
        macroproyecto: macroLabel(macro),
        proyecto: proyecto.nombre || proyecto.codigo || 'Sin proyecto',
        codificacion: accion.codigo || accion.nombre || '',
        presupuesto,
        comprometidoGasto: 0,
        comprometidoInversion: 0,
        comprometido: 0,
        causadoGasto: split.causadoGasto,
        causadoInversion: split.causadoInversion,
        causado: split.causado,
        autorizaciones: 0,
        fuenteCausado: 'importado',
      };
    })
    .filter(Boolean);

  return [...mergedRows, ...extraRows];
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

    const response = await sheetsService.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'A:Z',
    });

    const rows = response.data.values || [];
    const parsed = await applyImportedExecution(parseRows(rows));

    const totals = parsed.reduce(
      (acc, r) => ({
        presupuesto:           acc.presupuesto           + (r.presupuesto || 0),
        comprometido:          acc.comprometido          + r.comprometido,
        comprometidoGasto:     acc.comprometidoGasto     + r.comprometidoGasto,
        comprometidoInversion: acc.comprometidoInversion + r.comprometidoInversion,
        causado:               acc.causado               + r.causado,
        causadoGasto:          acc.causadoGasto          + r.causadoGasto,
        causadoInversion:      acc.causadoInversion      + r.causadoInversion,
      }),
      { presupuesto: 0, comprometido: 0, comprometidoGasto: 0, comprometidoInversion: 0, causado: 0, causadoGasto: 0, causadoInversion: 0 }
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

controller.invalidateCache = () => {
  cache = { data: null, timestamp: 0 };
};

module.exports = controller;
