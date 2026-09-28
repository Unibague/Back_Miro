const axios = require('axios');
const Student = require('../models/students');

// Resuelve el programa académico de los estudiantes a partir de su número de
// documento, para dejarlo FIJO como columna PROGRAMA_ESTUDIANTE al guardar un
// archivo en Consulta de Información (ej. Trabajo de Grado). Así el Tablero
// solo lee esa columna y no vuelve a consultar a nadie en cada carga.

const PROGRAMA_ESTUDIANTE_HEADER = 'PROGRAMA_ESTUDIANTE';

const normalizeId = (value) => String(value ?? '').trim().replace(/\.0+$/, '').replace(/[^\dA-Za-z]/g, '');
const normalizeHeader = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '');

// Columna con el documento del estudiante (ej. "NUM_DOCUMENTO_Estudiante"),
// sin confundirla con el tipo de documento ("ID_TIPO_DOCUMENTO_Estudiante").
const isStudentIdHeader = (header) => {
  const normalized = normalizeHeader(header);
  if (!normalized.includes('ESTUDIANTE') || normalized.includes('TIPO')) return false;
  return normalized.includes('DOCUMENTO') || normalized.includes('IDENTIFICACION') || normalized.includes('CEDULA');
};

const fetchApiStudents = async () => {
  if (!process.env.STUDENTS_ENDPOINT) return [];
  try {
    const response = await axios.get(process.env.STUDENTS_ENDPOINT, { timeout: 60000 });
    return Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    console.warn(`[studentsDirectory] No fue posible consultar estudiantes: ${error.message}`);
    return [];
  }
};

// Map documento -> programa, solo para los documentos pedidos. La API externa
// (SIGA) tiene el dato más reciente; la colección local se usa de respaldo.
const getStudentProgramsByIds = async (identifications) => {
  const ids = [...new Set((identifications || []).map(normalizeId).filter(Boolean))];
  const programs = new Map();
  if (ids.length === 0) return programs;

  const [studentsDb, studentsApi] = await Promise.all([
    Student.find({ identification: { $in: ids } }, 'identification program').lean(),
    fetchApiStudents(),
  ]);

  const wanted = new Set(ids);
  const put = (student) => {
    const id = normalizeId(student.identification);
    const program = String(student.program || '').trim();
    if (wanted.has(id) && program) programs.set(id, program);
  };
  studentsDb.forEach(put);
  studentsApi.forEach(put);
  return programs;
};

// Agrega (o recalcula) la columna PROGRAMA_ESTUDIANTE en cada hoja que tenga
// una columna de documento del estudiante. Recibe y devuelve hojas con la
// forma { name, headers, rows } (rows = arreglos alineados con headers).
// Si la consulta falla, devuelve las hojas sin cambios: el archivo se debe
// guardar igual.
const addStudentProgramColumn = async (sheets = []) => {
  const targets = sheets
    .map((sheet) => ({ sheet, idIndex: (sheet.headers || []).findIndex(isStudentIdHeader) }))
    .filter(({ idIndex }) => idIndex >= 0);
  if (targets.length === 0) return sheets;

  try {
    const allIds = targets.flatMap(({ sheet, idIndex }) => (sheet.rows || []).map((row) => row?.[idIndex]));
    const programs = await getStudentProgramsByIds(allIds);
    console.log(`[studentsDirectory] ${PROGRAMA_ESTUDIANTE_HEADER}: programa resuelto para ${programs.size} estudiante(s).`);

    return sheets.map((sheet) => {
      const target = targets.find((t) => t.sheet === sheet);
      if (!target) return sheet;
      const headers = [...(sheet.headers || [])];
      let programIndex = headers.findIndex((h) => normalizeHeader(h) === normalizeHeader(PROGRAMA_ESTUDIANTE_HEADER));
      if (programIndex < 0) {
        headers.push(PROGRAMA_ESTUDIANTE_HEADER);
        programIndex = headers.length - 1;
      }
      const rows = (sheet.rows || []).map((row) => {
        const next = [...(row || [])];
        while (next.length < headers.length) next.push('');
        next[programIndex] = programs.get(normalizeId(next[target.idIndex])) || '';
        return next;
      });
      return { ...sheet, headers, rows };
    });
  } catch (error) {
    console.error(`[studentsDirectory] Error calculando ${PROGRAMA_ESTUDIANTE_HEADER}, se guarda sin esa columna:`, error.message);
    return sheets;
  }
};

module.exports = { addStudentProgramColumn, getStudentProgramsByIds };
