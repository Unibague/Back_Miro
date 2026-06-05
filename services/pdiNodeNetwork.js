const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const DEFAULT_EXCEL_PATH = process.env.PDI_NODE_NETWORK_XLSX_PATH
  || path.join(__dirname, '../assets/pdi/Matriz relaciones_PDI_2026_2029.xlsx');

const OVERRIDE_PATH = process.env.PDI_NODE_NETWORK_OVERRIDE_PATH
  || path.join(__dirname, '../uploads/pdi/red-nodos.json');

const SCORE_BY_INTENSITY = {
  baja: 1,
  media: 3,
  alta: 5,
};

const INTENSITY_BY_SCORE = {
  1: 'Baja',
  3: 'Media',
  5: 'Alta',
};

function clean(value) {
  return String(value ?? '').trim();
}

function asNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(String(value).replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeIntensity(value, scoreValue) {
  const raw = clean(value);
  const score = asNumber(scoreValue, 0);
  const byScore = INTENSITY_BY_SCORE[score];
  if (!raw && byScore) return byScore;

  const normalized = raw.toLowerCase();
  if (normalized.includes('alta')) return 'Alta';
  if (normalized.includes('media')) return 'Media';
  if (normalized.includes('baja')) return 'Baja';
  return byScore || 'Media';
}

function scoreForIntensity(intensity, scoreValue) {
  const normalized = normalizeIntensity(intensity, scoreValue);
  return SCORE_BY_INTENSITY[normalized.toLowerCase()] || asNumber(scoreValue, 3) || 3;
}

function edgeId(source, target) {
  return `${source}->${target}`;
}

function sheetRows(workbook, sheetName, options = {}) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, { defval: '', ...options });
}

function buildMacroNameMap(workbook) {
  const map = new Map();
  const relationRows = sheetRows(workbook, 'Relaciones', { range: 2 });

  for (const row of relationRows) {
    const sourceId = clean(row['ID Origen']);
    const targetId = clean(row['ID Destino']);
    const sourceMacro = clean(row['Macroproyecto Origen']);
    const targetMacro = clean(row['Macroproyecto Destino']);
    if (sourceId && sourceMacro) map.set(sourceId, sourceMacro);
    if (targetId && targetMacro) map.set(targetId, targetMacro);
  }

  const metricRows = sheetRows(workbook, 'Nodos y Métricas', { range: 2 });
  for (const row of metricRows) {
    const code = clean(row.Código || row.Codigo);
    const macroName = clean(row.Macroproyecto);
    if (code && macroName && !/^m\d$/i.test(macroName)) map.set(code, macroName);
  }

  return map;
}

function parseNodes(workbook) {
  const macroNames = buildMacroNameMap(workbook);
  const rows = sheetRows(workbook, 'PBI_NODOS');

  return rows
    .filter((row) => clean(row.ID_Proyecto))
    .map((row) => {
      const id = clean(row.ID_Proyecto);
      return {
        id,
        codigo: id,
        nombre: clean(row.Proyecto),
        macro_codigo: clean(row.Macroproyecto),
        macro_nombre: macroNames.get(id) || clean(row.Macroproyecto),
        puntaje_total: asNumber(row.Puntaje_Total),
        nivel_articulacion: clean(row.Nivel_Articulacion),
        prioridad_gestion: clean(row.Prioridad_Gestion),
      };
    });
}

function parseEdgesFromRelations(workbook) {
  const rows = sheetRows(workbook, 'Relaciones', { range: 2 });

  return rows
    .filter((row) => clean(row['ID Origen']) && clean(row['ID Destino']))
    .map((row) => {
      const source = clean(row['ID Origen']);
      const target = clean(row['ID Destino']);
      const intensity = normalizeIntensity(row.Intensidad, row.Puntaje);

      return {
        id: edgeId(source, target),
        origen: source,
        destino: target,
        tipo_relacion: clean(row['Tipo de Relación']) || 'Habilitadora',
        intensidad: intensity,
        puntaje: scoreForIntensity(intensity, row.Puntaje),
        justificacion: clean(row.Justificación || row.Justificacion),
        recomendacion: clean(row.Recomendación || row.Recomendacion),
      };
    });
}

function parseEdgesFromPowerBi(workbook) {
  const rows = sheetRows(workbook, 'PBI_CONEXIONES');

  return rows
    .filter((row) => clean(row.Proyecto_Origen) && clean(row.Proyecto_Destino))
    .map((row) => {
      const source = clean(row.Proyecto_Origen);
      const target = clean(row.Proyecto_Destino);
      const intensity = normalizeIntensity(row.Intensidad, row.Puntaje);

      return {
        id: edgeId(source, target),
        origen: source,
        destino: target,
        tipo_relacion: clean(row.Tipo_Relacion) || 'Habilitadora',
        intensidad: intensity,
        puntaje: scoreForIntensity(intensity, row.Puntaje),
        justificacion: '',
        recomendacion: '',
      };
    });
}

function parseDefaultNetwork() {
  if (!fs.existsSync(DEFAULT_EXCEL_PATH)) {
    throw new Error(`No se encontró la matriz de relaciones PDI en ${DEFAULT_EXCEL_PATH}`);
  }

  const workbook = XLSX.readFile(DEFAULT_EXCEL_PATH);
  const nodes = parseNodes(workbook);
  const edges = parseEdgesFromRelations(workbook);

  return {
    nodes,
    edges: edges.length ? edges : parseEdgesFromPowerBi(workbook),
    source: {
      type: 'excel',
      name: path.basename(DEFAULT_EXCEL_PATH),
      path: DEFAULT_EXCEL_PATH,
    },
  };
}

function normalizeNode(raw) {
  const id = clean(raw.id || raw.codigo || raw.ID_Proyecto);
  if (!id) return null;

  const node = {
    id,
    codigo: clean(raw.codigo || raw.ID_Proyecto || id),
    nombre: clean(raw.nombre || raw.Proyecto),
    macro_codigo: clean(raw.macro_codigo || raw.Macroproyecto),
    macro_nombre: clean(raw.macro_nombre || raw.macroproyecto || raw.Macroproyecto),
    puntaje_total: asNumber(raw.puntaje_total ?? raw.Puntaje_Total),
    nivel_articulacion: clean(raw.nivel_articulacion || raw.Nivel_Articulacion),
    prioridad_gestion: clean(raw.prioridad_gestion || raw.Prioridad_Gestion),
  };

  if (Number.isFinite(Number(raw.x))) node.x = Number(raw.x);
  if (Number.isFinite(Number(raw.y))) node.y = Number(raw.y);

  return node;
}

function normalizeEdge(raw) {
  const source = clean(raw.origen || raw.source || raw.Proyecto_Origen);
  const target = clean(raw.destino || raw.target || raw.Proyecto_Destino);
  if (!source || !target || source === target) return null;

  const intensity = normalizeIntensity(raw.intensidad || raw.Intensidad, raw.puntaje ?? raw.Puntaje);

  return {
    id: clean(raw.id) || edgeId(source, target),
    origen: source,
    destino: target,
    tipo_relacion: clean(raw.tipo_relacion || raw.relationType || raw.Tipo_Relacion) || 'Habilitadora',
    intensidad: intensity,
    puntaje: scoreForIntensity(intensity, raw.puntaje ?? raw.Puntaje),
    justificacion: clean(raw.justificacion || raw.Justificacion),
    recomendacion: clean(raw.recomendacion || raw.Recomendacion),
  };
}

function normalizeNetworkPayload(payload) {
  const nodes = Array.isArray(payload?.nodes)
    ? payload.nodes.map(normalizeNode).filter(Boolean)
    : [];

  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = Array.isArray(payload?.edges)
    ? payload.edges.map(normalizeEdge).filter(Boolean)
    : [];

  const validEdges = [];
  const seenEdges = new Set();
  for (const edge of edges) {
    if (!nodeIds.has(edge.origen) || !nodeIds.has(edge.destino)) continue;
    const id = edgeId(edge.origen, edge.destino);
    if (seenEdges.has(id)) continue;
    seenEdges.add(id);
    validEdges.push({ ...edge, id });
  }

  if (!nodes.length) {
    throw new Error('La red debe tener al menos un nodo.');
  }

  return { nodes, edges: validEdges };
}

function countBy(items, getter) {
  return items.reduce((acc, item) => {
    const key = getter(item) || 'Sin definir';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function decorateNetwork(rawNetwork, source) {
  const nodes = rawNetwork.nodes.map((node) => ({ ...node }));
  const edges = rawNetwork.edges.map((edge) => ({
    ...edge,
    id: edge.id || edgeId(edge.origen, edge.destino),
  }));

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    node.relaciones_salientes = 0;
    node.relaciones_entrantes = 0;
    node.puntaje_saliente = 0;
    node.puntaje_entrante = 0;
  }

  for (const edge of edges) {
    const sourceNode = nodeMap.get(edge.origen);
    const targetNode = nodeMap.get(edge.destino);
    if (sourceNode) {
      sourceNode.relaciones_salientes += 1;
      sourceNode.puntaje_saliente += edge.puntaje;
    }
    if (targetNode) {
      targetNode.relaciones_entrantes += 1;
      targetNode.puntaje_entrante += edge.puntaje;
    }
  }

  for (const node of nodes) {
    node.total_relaciones = node.relaciones_salientes + node.relaciones_entrantes;
  }

  const macroMap = new Map();
  for (const node of nodes) {
    const code = node.macro_codigo || 'Sin macro';
    if (!macroMap.has(code)) {
      macroMap.set(code, {
        codigo: code,
        nombre: node.macro_nombre || code,
        nodos: 0,
        conexiones: 0,
      });
    }
    macroMap.get(code).nodos += 1;
  }

  for (const edge of edges) {
    const sourceNode = nodeMap.get(edge.origen);
    if (sourceNode?.macro_codigo && macroMap.has(sourceNode.macro_codigo)) {
      macroMap.get(sourceNode.macro_codigo).conexiones += 1;
    }
  }

  return {
    nodes: nodes.sort((a, b) => a.codigo.localeCompare(b.codigo, 'es')),
    edges: edges.sort((a, b) => a.origen.localeCompare(b.origen, 'es') || a.destino.localeCompare(b.destino, 'es')),
    summary: {
      total_nodos: nodes.length,
      total_conexiones: edges.length,
      por_intensidad: countBy(edges, (edge) => edge.intensidad),
      por_tipo: countBy(edges, (edge) => edge.tipo_relacion),
      macroproyectos: [...macroMap.values()].sort((a, b) => a.codigo.localeCompare(b.codigo, 'es')),
    },
    catalogos: {
      intensidades: ['Baja', 'Media', 'Alta'],
      puntajes: [1, 3, 5],
      tipos_relacion: Object.keys(countBy(edges, (edge) => edge.tipo_relacion)).sort((a, b) => a.localeCompare(b, 'es')),
    },
    source,
  };
}

function readOverrideNetwork() {
  if (!fs.existsSync(OVERRIDE_PATH)) return null;
  const saved = JSON.parse(fs.readFileSync(OVERRIDE_PATH, 'utf8'));
  const normalized = normalizeNetworkPayload(saved);
  return {
    ...normalized,
    source: {
      type: 'override',
      name: path.basename(OVERRIDE_PATH),
      saved_at: saved.saved_at || null,
      path: OVERRIDE_PATH,
    },
  };
}

async function getNetwork() {
  const override = readOverrideNetwork();
  if (override) return decorateNetwork(override, override.source);

  const base = parseDefaultNetwork();
  return decorateNetwork(base, base.source);
}

async function saveNetwork(payload) {
  const normalized = normalizeNetworkPayload(payload);
  const saved = {
    version: 1,
    saved_at: new Date().toISOString(),
    nodes: normalized.nodes,
    edges: normalized.edges,
  };

  fs.mkdirSync(path.dirname(OVERRIDE_PATH), { recursive: true });
  fs.writeFileSync(OVERRIDE_PATH, JSON.stringify(saved, null, 2), 'utf8');

  return decorateNetwork(saved, {
    type: 'override',
    name: path.basename(OVERRIDE_PATH),
    saved_at: saved.saved_at,
    path: OVERRIDE_PATH,
  });
}

async function resetNetwork() {
  if (fs.existsSync(OVERRIDE_PATH)) {
    fs.unlinkSync(OVERRIDE_PATH);
  }
  const base = parseDefaultNetwork();
  return decorateNetwork(base, base.source);
}

module.exports = {
  getNetwork,
  saveNetwork,
  resetNetwork,
};
