const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const fs = require('fs');
const path = require('path');

const SPREADSHEET_ID = '1pGQkA-nu5kmy8HviHM4YzmC3AOmFrGoTS_X8U93f9YI';
const PROJECT_SHEET_NAME = 'Proyecto 2026';
const DETAIL_SHEET_NAME = 'PDI';
const CACHE_TTL_MS = 60 * 1000;

let cache = { data: null, timestamp: 0 };

const resolveCredentialsPath = () => {
  const rootDir = path.join(__dirname, '..');
  const envPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.GOOGLE_CREDENTIALS_FILE ||
    process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;

  const candidates = [
    envPath && (path.isAbsolute(envPath) ? envPath : path.join(rootDir, envPath)),
    path.join(rootDir, 'google-credentials.json'),
    ...fs
      .readdirSync(rootDir)
      .filter((fileName) => /^miro-drive-.*\.json$/i.test(fileName))
      .map((fileName) => path.join(rootDir, fileName)),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[1];
};

const getAuth = () =>
  new GoogleAuth({
    keyFile: resolveCredentialsPath(),
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

const normalizeNum = (val) => {
  if (val === null || val === undefined || val === '') return 0;
  const str = String(val).replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(str);
  return Number.isNaN(n) ? 0 : n;
};

const normalizeText = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const normalizeHeader = (value) =>
  normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim();

const cleanProjectName = (value) =>
  String(value || '')
    .replace(/^proyecto\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

const cleanActionName = (value) =>
  String(value || '').replace(/\s+/g, ' ').trim();

const sheetRange = (sheetName, range) => `'${sheetName.replace(/'/g, "''")}'!${range}`;

const findColIdx = (headers, keywords) =>
  headers.findIndex((h) => keywords.some((k) => h.includes(normalizeHeader(k))));

const getColIdx = (headers, keywords, fallback) => {
  const idx = findColIdx(headers, keywords);
  return idx !== -1 ? idx : fallback;
};

const getHeaderIdx = (rows, keywords) => {
  for (let i = 0; i < Math.min(10, rows.length); i += 1) {
    const normalized = (rows[i] || []).map(normalizeHeader);
    if (keywords.some((keyword) => normalized.some((cell) => cell.includes(normalizeHeader(keyword))))) {
      return i;
    }
  }
  return 0;
};

const parseProjectRows = (rows) => {
  if (rows.length < 2) return [];

  const headerIdx = getHeaderIdx(rows, ['total presupuesto', 'total comprometido', 'proyecto']);
  const headers = (rows[headerIdx] || []).map(normalizeHeader);

  const colCentro = getColIdx(headers, ['centro de costo', 'centro costo'], 0);
  const colMacro = getColIdx(headers, ['macroproyecto'], 1);
  const colProyecto = (() => {
    const idx = headers.findIndex((h) => h === 'proyecto' || (h.includes('proyecto') && !h.includes('macro')));
    return idx !== -1 ? idx : 2;
  })();
  const colPresupuestoGasto = getColIdx(headers, ['gasto'], 12);
  const colPresupuestoInversion = getColIdx(headers, ['inversion'], 13);
  const colPresupuestoTotal = getColIdx(headers, ['total presupuesto'], 14);
  const colComprometidoGasto = getColIdx(headers, ['comprometido gasto'], 15);
  const colComprometidoInversion = getColIdx(headers, ['comprometido inversion'], 16);
  const colComprometidoTotal = getColIdx(headers, ['total comprometido'], 17);
  const colCausadoGasto = getColIdx(headers, ['causado gasto'], 18);
  const colCausadoInversion = getColIdx(headers, ['causado inversion'], 19);
  const colCausadoTotal = getColIdx(headers, ['total causado'], 20);

  return rows
    .slice(headerIdx + 1)
    .map((row) => {
      const centroCosto = String(row[colCentro] || '').trim();
      const macroproyecto = String(row[colMacro] || '').trim();
      const proyecto = String(row[colProyecto] || '').trim();
      if (!centroCosto && !macroproyecto && !proyecto) return null;

      const presupuestoGasto = normalizeNum(row[colPresupuestoGasto]);
      const presupuestoInversion = normalizeNum(row[colPresupuestoInversion]);
      const presupuesto = normalizeNum(row[colPresupuestoTotal]) || presupuestoGasto + presupuestoInversion;
      const comprometidoGasto = normalizeNum(row[colComprometidoGasto]);
      const comprometidoInversion = normalizeNum(row[colComprometidoInversion]);
      const comprometido = normalizeNum(row[colComprometidoTotal]) || comprometidoGasto + comprometidoInversion;
      const causadoGasto = normalizeNum(row[colCausadoGasto]);
      const causadoInversion = normalizeNum(row[colCausadoInversion]);
      const causado = normalizeNum(row[colCausadoTotal]) || causadoGasto + causadoInversion;

      return {
        centroCosto,
        macroproyecto,
        proyecto,
        proyectoNombre: cleanProjectName(proyecto),
        presupuesto,
        presupuestoGasto,
        presupuestoInversion,
        comprometido,
        comprometidoGasto,
        comprometidoInversion,
        causado,
        causadoGasto,
        causadoInversion,
      };
    })
    .filter(Boolean);
};

const parseActionRows = (rows, projectBudgetMap) => {
  if (rows.length < 2) return [];

  const headerIdx = getHeaderIdx(rows, ['accion estrategica', 'valor', 'tipo']);
  const headers = (rows[headerIdx] || []).map(normalizeHeader);

  const colAutorizacion = getColIdx(headers, ['autorizacion'], 0);
  const colCentro = getColIdx(headers, ['centro de costo', 'centro costo'], 1);
  const colProyecto = getColIdx(headers, ['proyecto'], 2);
  const colAccion = getColIdx(headers, ['accion estrategica'], 3);
  const colTipo = getColIdx(headers, ['tipo'], 4);
  const colValor = getColIdx(headers, ['valor'], 10);
  const colAprobacion = getColIdx(headers, ['aprobacion'], 18);
  const colCausadoGasto = getColIdx(headers, ['causado gasto'], 20);
  const colCausadoInversion = getColIdx(headers, ['causado inversion'], 21);

  const byAction = new Map();

  rows.slice(headerIdx + 1).forEach((row) => {
    const proyecto = String(row[colProyecto] || '').trim();
    const accionEstrategica = cleanActionName(row[colAccion]);
    if (!proyecto || !accionEstrategica) return;

    const centroCosto = String(row[colCentro] || '').trim();
    const proyectoNombre = cleanProjectName(proyecto);
    const key = `${normalizeText(proyectoNombre)}::${normalizeText(accionEstrategica)}`;
    const tipo = normalizeHeader(row[colTipo]);
    const valor = normalizeNum(row[colValor]);
    const causadoGasto = normalizeNum(row[colCausadoGasto]);
    const causadoInversion = normalizeNum(row[colCausadoInversion]);

    if (!byAction.has(key)) {
      const projectBudget = projectBudgetMap.get(normalizeText(proyectoNombre));
      byAction.set(key, {
        centroCosto,
        proyecto,
        proyectoNombre,
        accionEstrategica,
        presupuestoAsignado: projectBudget?.presupuesto || 0,
        comprometidoGasto: 0,
        comprometidoInversion: 0,
        totalComprometido: 0,
        causadoGasto: 0,
        causadoInversion: 0,
        totalCausado: 0,
        autorizaciones: 0,
        aprobadas: 0,
      });
    }

    const current = byAction.get(key);
    if (tipo.includes('inversion')) {
      current.comprometidoInversion += valor;
    } else {
      current.comprometidoGasto += valor;
    }
    current.totalComprometido += valor;
    current.causadoGasto += causadoGasto;
    current.causadoInversion += causadoInversion;
    current.totalCausado += causadoGasto + causadoInversion;
    current.autorizaciones += String(row[colAutorizacion] || '').trim() ? 1 : 0;
    current.aprobadas += normalizeHeader(row[colAprobacion]).includes('aprobada') ? 1 : 0;
  });

  return Array.from(byAction.values()).sort((a, b) =>
    `${a.proyectoNombre} ${a.accionEstrategica}`.localeCompare(`${b.proyectoNombre} ${b.accionEstrategica}`)
  );
};

const controller = {};

// GET /pdi/presupuesto/data?refresh=true
controller.getData = async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  try {
    const now = Date.now();
    if (!forceRefresh && cache.data && now - cache.timestamp < CACHE_TTL_MS) {
      return res.status(200).json(cache.data);
    }

    const auth = await getAuth().getClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const response = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: SPREADSHEET_ID,
      ranges: [
        sheetRange(PROJECT_SHEET_NAME, 'A:AK'),
        sheetRange(DETAIL_SHEET_NAME, 'A:AD'),
      ],
    });

    const valueRanges = response.data.valueRanges || [];
    const projectSheetRows = valueRanges[0]?.values || [];
    const detailSheetRows = valueRanges[1]?.values || [];
    const rows = parseProjectRows(projectSheetRows);
    const projectBudgetMap = new Map(rows.map((row) => [normalizeText(row.proyectoNombre), row]));
    const actionRows = parseActionRows(detailSheetRows, projectBudgetMap);

    const totals = rows.reduce(
      (acc, row) => ({
        presupuesto: acc.presupuesto + row.presupuesto,
        comprometido: acc.comprometido + row.comprometido,
        causado: acc.causado + row.causado,
        presupuestoGasto: acc.presupuestoGasto + row.presupuestoGasto,
        presupuestoInversion: acc.presupuestoInversion + row.presupuestoInversion,
        comprometidoGasto: acc.comprometidoGasto + row.comprometidoGasto,
        comprometidoInversion: acc.comprometidoInversion + row.comprometidoInversion,
        causadoGasto: acc.causadoGasto + row.causadoGasto,
        causadoInversion: acc.causadoInversion + row.causadoInversion,
      }),
      {
        presupuesto: 0,
        comprometido: 0,
        causado: 0,
        presupuestoGasto: 0,
        presupuestoInversion: 0,
        comprometidoGasto: 0,
        comprometidoInversion: 0,
        causadoGasto: 0,
        causadoInversion: 0,
      }
    );

    const detailTotals = actionRows.reduce(
      (acc, row) => ({
        comprometidoGasto: acc.comprometidoGasto + row.comprometidoGasto,
        comprometidoInversion: acc.comprometidoInversion + row.comprometidoInversion,
        totalComprometido: acc.totalComprometido + row.totalComprometido,
        causadoGasto: acc.causadoGasto + row.causadoGasto,
        causadoInversion: acc.causadoInversion + row.causadoInversion,
        totalCausado: acc.totalCausado + row.totalCausado,
      }),
      {
        comprometidoGasto: 0,
        comprometidoInversion: 0,
        totalComprometido: 0,
        causadoGasto: 0,
        causadoInversion: 0,
        totalCausado: 0,
      }
    );

    const result = {
      rows,
      actionRows,
      totals: { ...totals, detalle: detailTotals },
      source: {
        spreadsheetId: SPREADSHEET_ID,
        projectSheet: PROJECT_SHEET_NAME,
        detailSheet: DETAIL_SHEET_NAME,
      },
      updatedAt: new Date().toISOString(),
    };
    cache = { data: result, timestamp: Date.now() };

    return res.status(200).json(result);
  } catch (error) {
    console.error('Error leyendo presupuesto PDI desde Sheets:', error);
    if (cache.data) return res.status(200).json({ ...cache.data, stale: true });
    return res.status(500).json({ message: 'Error al leer la hoja de presupuesto.', error: error.message });
  }
};

module.exports = controller;
