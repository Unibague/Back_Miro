// Cifras fijas de un archivo de Consulta de Información, calculadas UNA sola
// vez al guardarlo (subida manual o envío final a SNIES) y guardadas en el
// campo "resumen" del registro. El Tablero solo las lee.

const normalizeKey = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '');

const isMatriculadosFile = (fileName) => normalizeKey(fileName).includes('MATRICULADO');

// Hoja de matriculados: "MATRICULADO" (plantilla SNIES Matriculados). Si no
// hay una con ese nombre se usa la primera hoja que no sea de listas.
const findMatriculadosSheet = (sheets = []) =>
  sheets.find((s) => normalizeKey(s.name).startsWith('MATRICULADO'))
  || sheets.find((s) => !normalizeKey(s.name).includes('LISTA'));

// Total de matriculados = estudiantes distintos (por código de estudiante o
// documento; si la fila no trae ninguno, cuenta como uno más), con el
// desglose por periodo AÑO-SEMESTRE.
const buildMatriculadosResumen = (sheets) => {
  const sheet = findMatriculadosSheet(sheets);
  if (!sheet || !Array.isArray(sheet.rows) || sheet.rows.length === 0) return null;

  const headers = (sheet.headers || []).map(normalizeKey);
  const col = (...names) => names.map((n) => headers.indexOf(n)).find((i) => i >= 0) ?? -1;
  const idxAno = col('ANO');
  const idxSemestre = col('SEMESTRE');
  const idxId = col('CODIGOESTUDIANTE', 'NUMDOCUMENTO', 'CODALUMNO');

  const vistos = new Set();
  const porPeriodo = new Map();
  let total = 0;
  sheet.rows.forEach((row, index) => {
    const id = idxId >= 0 ? String(row?.[idxId] ?? '').trim() : '';
    const ano = idxAno >= 0 ? String(row?.[idxAno] ?? '').trim() : '';
    const semestre = idxSemestre >= 0 ? String(Number(row?.[idxSemestre]) || row?.[idxSemestre] || '').trim() : '';
    const periodo = ano ? (semestre ? `${ano}-${semestre}` : ano) : 'Sin periodo';
    const clave = `${periodo}|${id || `fila-${index}`}`;
    if (vistos.has(clave)) return;
    vistos.add(clave);
    total += 1;
    porPeriodo.set(periodo, (porPeriodo.get(periodo) || 0) + 1);
  });

  return {
    tipo: 'matriculados',
    totalMatriculados: total,
    porPeriodo: Array.from(porPeriodo.entries())
      .map(([periodo, value]) => ({ periodo, total: value }))
      .sort((a, b) => a.periodo.localeCompare(b.periodo)),
    calculadoEn: new Date(),
  };
};

// Devuelve el resumen del archivo, o null si no es un tipo de archivo que
// tenga cifras fijas.
const buildResumenArchivo = (fileName, sheets) => {
  try {
    if (isMatriculadosFile(fileName)) return buildMatriculadosResumen(sheets);
  } catch (error) {
    console.error('[historicoResumen] Error calculando resumen de', fileName, error.message);
  }
  return null;
};

module.exports = { buildResumenArchivo, isMatriculadosFile };
