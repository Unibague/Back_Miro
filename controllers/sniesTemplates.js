const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const PizZip = require("pizzip");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const SniesTemplate = require("../models/sniesTemplates");
const PublishedTemplate = require("../models/publishedTemplates");
const Dependency = require("../models/dependencies");
const Period = require("../models/periods");
const Student = require("../models/students");
const UserService = require("../services/users");
const {
  uploadFileToGoogleDrive,
  updateFileInGoogleDrive,
  deleteDriveFile,
  downloadDriveFileBuffer,
} = require("../config/googleDrive");

const axios = require("axios");

const controller = {};

const normalizeFieldName = (fieldName = "") =>
  fieldName
    .toString()
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

const buildDownloadFileName = (template) => {
  const templateName = String(template?.name || "").trim();
  const extension = path.extname(String(template?.file_name || "").trim()) || ".xlsx";

  if (!templateName) {
    return `plantilla_snies${extension}`;
  }

  return `${templateName}${extension}`;
};

const normalizeComparableName = (value = "") =>
  String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

const PROGRAM_NAME_FIELDS = [
  "PROGRAMA",
  "NOMBRE_PROGRAMA",
  "PROGRAMA_ACADEMICO",
  "PROGRAMA_ACAD_MICO",
  "PROGRAMA_SNIES",
  "PROGRAMA_DEL_ESTUDIANTE",
  "PROGRAMA_DEL_FUNCIONARIO",
];

const PRO_CONSECUTIVO_FIELDS = [
  "PRO_CONSECUTIVO",
];

const PROGRAM_SNIES_CATALOG = [
  ["Administración Financiera", "20170"],
  ["Contaduría Pública", "20200"],
  ["Economía", "20168"],
  ["Mercadeo", "20198"],
  ["Administración de Negocios Internacionales", "20191"],
  ["Administración de Empresas", "105564"],
  ["Ingeniería Mecánica", "20169"],
  ["Ingeniería de Sistemas", "20171"],
  ["Ingeniería Industrial", "20172"],
  ["Ingeniería Electrónica", "20181"],
  ["Ingeniería Civil", "20185"],
  ["Ingeniería en Analítica de Datos", "117133"],
  ["Psicología", "20164"],
  ["Filosofía", "20569"],
  ["Comunicación Social y Periodismo", "51778"],
  ["Diseño", "103528"],
  ["Arquitectura", "20162"],
  ["Biología Ambiental", "106585"],
  ["Derecho", "20166"],
  ["Ciencia Política", "52541"],
  ["Tecnología en Mercadeo y ventas", "20197"],
  ["Especialización Estratégica y Negocios Internacionales", "20201"],
  ["Especialización en Gestión Empresarial", "20167"],
  ["Maestría en Administración de Negocios", "107428"],
  ["Maestría en Analítica de Datos para la Toma de Decisiones", "116648"],
  ["Administración del Medio Ambiente y de los Recursos Naturales", "20566"],
  ["Administración Ambiental", "102078"],
  ["Tecnología en Investigación Criminal y Judicial", "20581"],
  ["Especialización en Derecho Administrativo", "20202"],
  ["Especialización en Derecho Penal", "20161"],
  ["Especialización en Derecho Civil", "20178"],
  ["Maestría en Derecho", "105924"],
  ["Especialización en Intervención Psicosocial", "110089"],
  ["Maestría en Gestión Territorial, Autonomía y Sostenibilidad", "116592"],
  ["Tecnología en Entrenamiento Deportivo en Fútbol", "102901"],
  ["Especialización en Mecánica de Materiales", "20173"],
  ["Maestría en Gestión Industrial", "20964"],
  ["Maestría en Gerencia de la Calidad", "90464"],
  ["Maestría en Ingeniería de Control", "105585"],
  ["Especialización en Gestión de Operaciones y Logística", "109527"],
  ["Tecnología en Mantenimiento Industrial", "101731"],
  ["Tecnología en Redes y Comunicaciones", "101736"],
  ["Tecnología en Logística", "101730"],
  ["Tecnología en Gestión de TIC", "102150"],
  ["Tecnología en Seguridad e Higiene Industrial", "101769"],
];

const PROGRAM_SNIES_CODE_BY_NAME = PROGRAM_SNIES_CATALOG.reduce((acc, [programName, sniesCode]) => {
  acc[normalizeComparableName(programName)] = sniesCode;
  return acc;
}, {});

const getRowValueByAliases = (row, aliases = []) => {
  for (const alias of aliases) {
    const value = row?.[alias];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }

  return null;
};

const findProgramNameInRow = (row) => {
  const directValue = getRowValueByAliases(row, PROGRAM_NAME_FIELDS);
  if (directValue) {
    return directValue;
  }

  const entries = Object.entries(row || {});
  for (const [key, rawValue] of entries) {
    const normalizedKey = normalizeFieldName(key);
    const value = String(rawValue ?? "").trim();

    if (!value) {
      continue;
    }

    // Cualquier columna relacionada con programa, evitando códigos o campos ya resueltos.
    if (
      normalizedKey.includes("PROGRAMA") &&
      !normalizedKey.includes("CODIGO") &&
      !normalizedKey.includes("SNIES") &&
      !normalizedKey.includes("CONSECUTIVO")
    ) {
      return value;
    }
  }

  return null;
};

const findProgramSniesCode = (programName) => {
  if (!programName) {
    return null;
  }

  return PROGRAM_SNIES_CODE_BY_NAME[normalizeComparableName(programName)] || null;
};

const findExistingSniesCodeInRow = (row) => {
  for (const [key, rawValue] of Object.entries(row || {})) {
    const normalizedKey = normalizeFieldName(key);
    const value = String(rawValue ?? "").trim();

    if (!value) {
      continue;
    }

    if (
      normalizedKey.includes("SNIES") ||
      normalizedKey.includes("PRO_CONSECUTIVO") ||
      normalizedKey.includes("CODIGO_PROGRAMA")
    ) {
      return value.replace(/\./g, "");
    }
  }

  return null;
};

const getStudentRecordPriority = (student = {}) => {
  const status = String(student.status || "").trim().toUpperCase();
  let score = 0;

  if (student.program) score += 10;
  if (student.program_code) score += 5;
  if (status === "ACTIVO") score += 20;
  if (status === "TRASLADO") score += 15;
  if (status === "EGRESADO") score += 10;
  if (status === "GRADUADO") score += 8;

  return score;
};

let externalStudentsCache = null;

const getExternalStudents = async () => {
  if (externalStudentsCache) {
    return externalStudentsCache;
  }

  if (!process.env.STUDENTS_ENDPOINT) {
    return [];
  }

  try {
    const response = await axios.get(process.env.STUDENTS_ENDPOINT, { timeout: 20000 });
    const students = Array.isArray(response.data) ? response.data : [];
    externalStudentsCache = students;
    return students;
  } catch (error) {
    console.error("[SNIES-Students] Error consultando STUDENTS_ENDPOINT:", error.message);
    return [];
  }
};

const singularizeToken = (token = "") => {
  if (token.endsWith("ES") && token.length > 4) {
    return token.slice(0, -2);
  }

  if (token.endsWith("S") && token.length > 3) {
    return token.slice(0, -1);
  }

  return token;
};

const tokenizeComparableName = (value = "") =>
  normalizeComparableName(value)
    .split("_")
    .map(singularizeToken)
    .filter(Boolean);

const isInfoWorksheet = (worksheetName = "") =>
  normalizeComparableName(worksheetName) === "INFO";

const getNormalizedRowKeys = (rows = []) => {
  const keys = new Set();

  rows.forEach((row) => {
    Object.keys(row || {}).forEach((key) => {
      keys.add(normalizeFieldName(key));
    });
  });

  return Array.from(keys);
};

const getWorksheetTemplateMatch = (worksheetName, worksheetHeaders, sourceTemplates) => {
  const worksheetNormalized = normalizeComparableName(worksheetName);
  const worksheetTokens = tokenizeComparableName(worksheetName);
  const normalizedWorksheetHeaders = worksheetHeaders.map((header) =>
    normalizeFieldName(header)
  );

  let bestMatch = null;
  let bestScore = 0;

  sourceTemplates.forEach((sourceTemplate) => {
    const templateNormalized = normalizeComparableName(sourceTemplate.template_name);
    const templateTokens = tokenizeComparableName(sourceTemplate.template_name);
    const overlap = worksheetTokens.filter((token) => templateTokens.includes(token)).length;

    const rowKeys = sourceTemplate.normalizedKeys || [];
    const headerOverlap = normalizedWorksheetHeaders.filter((header) =>
      rowKeys.includes(header)
    ).length;

    let score = overlap * 10 + headerOverlap * 25;

    if (worksheetNormalized && templateNormalized) {
      if (worksheetNormalized === templateNormalized) {
        score += 1000;
      } else if (
        templateNormalized.includes(worksheetNormalized) ||
        worksheetNormalized.includes(templateNormalized)
      ) {
        score += 100;
      }
    }

    if (worksheetTokens[0] && worksheetTokens[0] === templateTokens[0]) {
      score += 20;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = sourceTemplate;
    }
  });

  return bestScore > 0 ? bestMatch : null;
};

const convertCellValue = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(convertCellValue).join(", ");
  if (value.hyperlink || value.text) return value.text || value.hyperlink || "";
  if (value.result !== undefined) return value.result;
  if (value.value !== undefined) return value.value;
  if (value.$numberInt !== undefined) return value.$numberInt;
  if (value.$numberDouble !== undefined) return value.$numberDouble;
  return String(value);
};

const sanitizeExcelValue = (value) => {
  const normalizedValue = convertCellValue(value);

  if (normalizedValue === null || normalizedValue === undefined) {
    return "";
  }

  if (typeof normalizedValue === "number" || typeof normalizedValue === "boolean") {
    return normalizedValue;
  }

  return String(normalizedValue)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .trim();
};

const cloneNoteValue = (note) => {
  if (note === null || note === undefined) {
    return note;
  }

  return JSON.parse(JSON.stringify(note));
};

const captureWorkbookNotes = (workbook) => {
  const notesBySheet = new Map();

  workbook.worksheets.forEach((worksheet) => {
    const sheetNotes = new Map();

    worksheet.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        if (cell.note) {
          sheetNotes.set(cell.address, cloneNoteValue(cell.note));
        }
      });
    });

    notesBySheet.set(worksheet.name, sheetNotes);
  });

  return notesBySheet;
};

const restoreWorkbookNotes = (workbook, notesBySheet) => {
  workbook.worksheets.forEach((worksheet) => {
    const sheetNotes = notesBySheet.get(worksheet.name);
    if (!sheetNotes) {
      return;
    }

    sheetNotes.forEach((note, cellAddress) => {
      worksheet.getCell(cellAddress).note = cloneNoteValue(note);
    });
  });
};

const columnNumberToName = (columnNumber) => {
  let dividend = columnNumber;
  let columnName = "";

  while (dividend > 0) {
    const modulo = (dividend - 1) % 26;
    columnName = String.fromCharCode(65 + modulo) + columnName;
    dividend = Math.floor((dividend - modulo) / 26);
  }

  return columnName || "A";
};

const getWorksheetXmlPathMap = (zip) => {
  const parser = new DOMParser();
  const workbookXml = zip.file("xl/workbook.xml")?.asText();
  const relsXml = zip.file("xl/_rels/workbook.xml.rels")?.asText();

  if (!workbookXml || !relsXml) {
    throw new Error("Workbook XML metadata could not be read");
  }

  const workbookDoc = parser.parseFromString(workbookXml, "application/xml");
  const relsDoc = parser.parseFromString(relsXml, "application/xml");
  const relationships = Array.from(relsDoc.getElementsByTagName("Relationship")).reduce(
    (acc, relationship) => {
      acc[relationship.getAttribute("Id")] = relationship.getAttribute("Target");
      return acc;
    },
    {}
  );

  return Array.from(workbookDoc.getElementsByTagName("sheet")).reduce((acc, sheet) => {
    const name = sheet.getAttribute("name");
    const relationId =
      sheet.getAttribute("r:id") || sheet.getAttribute("id") || sheet.getAttribute("R:id");
    const target = relationships[relationId];

    if (name && target) {
      acc[name] = `xl/${target.replace(/^\/+/, "").replace(/^xl\//, "")}`;
    }

    return acc;
  }, {});
};

const buildCellNode = (doc, cellRef, value) => {
  const cellNode = doc.createElement("c");
  cellNode.setAttribute("r", cellRef);

  if (typeof value === "number" && Number.isFinite(value)) {
    const valueNode = doc.createElement("v");
    valueNode.appendChild(doc.createTextNode(String(value)));
    cellNode.appendChild(valueNode);
    return cellNode;
  }

  if (typeof value === "boolean") {
    cellNode.setAttribute("t", "b");
    const valueNode = doc.createElement("v");
    valueNode.appendChild(doc.createTextNode(value ? "1" : "0"));
    cellNode.appendChild(valueNode);
    return cellNode;
  }

  cellNode.setAttribute("t", "inlineStr");
  const isNode = doc.createElement("is");
  const textNode = doc.createElement("t");
  textNode.appendChild(doc.createTextNode(String(value ?? "")));
  isNode.appendChild(textNode);
  cellNode.appendChild(isNode);
  return cellNode;
};

const rewriteWorksheetXml = (xmlContent, headers, rows, headerRowNumber) => {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const doc = parser.parseFromString(xmlContent, "application/xml");
  const worksheetNode = doc.getElementsByTagName("worksheet")[0];
  const sheetDataNode = doc.getElementsByTagName("sheetData")[0];

  if (!worksheetNode || !sheetDataNode) {
    return xmlContent;
  }

  Array.from(sheetDataNode.getElementsByTagName("row"))
    .filter((rowNode) => Number(rowNode.getAttribute("r")) > headerRowNumber)
    .forEach((rowNode) => {
      sheetDataNode.removeChild(rowNode);
    });

  rows.forEach((row, rowIndex) => {
    const excelRowNumber = headerRowNumber + 1 + rowIndex;
    const rowNode = doc.createElement("row");
    rowNode.setAttribute("r", String(excelRowNumber));

    headers.forEach((header, headerIndex) => {
      const cellRef = `${columnNumberToName(headerIndex + 1)}${excelRowNumber}`;
      const cellNode = buildCellNode(doc, cellRef, sanitizeExcelValue(row[header]));
      rowNode.appendChild(cellNode);
    });

    sheetDataNode.appendChild(rowNode);
  });

  const dimensionNode = doc.getElementsByTagName("dimension")[0];
  if (dimensionNode && headers.length > 0) {
    const lastColumn = columnNumberToName(headers.length);
    const lastRow = Math.max(headerRowNumber + rows.length, headerRowNumber);
    dimensionNode.setAttribute("ref", `A1:${lastColumn}${lastRow}`);
  }

  return serializer.serializeToString(doc);
};

const extractWorksheetHeaders = (worksheet) => {
  let bestRowNumber = 1;
  let bestHeaders = [];

  for (let rowNumber = 1; rowNumber <= Math.min(20, worksheet.rowCount || 20); rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    const headers = values
      .map((value) => String(convertCellValue(value) || "").trim())
      .filter(Boolean);

    if (headers.length > bestHeaders.length) {
      bestHeaders = headers;
      bestRowNumber = rowNumber;
    }
  }

  return {
    headerRowNumber: bestRowNumber,
    headers: bestHeaders,
  };
};

const getSourceTemplatesFromSnies = (template) => {
  if (Array.isArray(template.source_published_templates) && template.source_published_templates.length > 0) {
    return template.source_published_templates;
  }

  if (template.source_published_template_id && template.source_published_template_name) {
    return [
      {
        template_id: template.source_published_template_id,
        template_name: template.source_published_template_name,
      },
    ];
  }

  return [];
};

const getPublishedTemplateSources = async (sourcePublishedTemplateIds) => {
  const ids = Array.isArray(sourcePublishedTemplateIds)
    ? sourcePublishedTemplateIds.filter(Boolean)
    : [sourcePublishedTemplateIds].filter(Boolean);

  if (ids.length === 0) {
    return [];
  }

  const publishedTemplates = await PublishedTemplate.find({
    _id: { $in: ids },
  }).select("_id name");

  if (publishedTemplates.length !== ids.length) {
    throw new Error("One or more source published templates were not found");
  }

  const orderMap = new Map(ids.map((id, index) => [String(id), index]));
  return publishedTemplates.sort(
    (a, b) => orderMap.get(String(a._id)) - orderMap.get(String(b._id))
  );
};

const buildSearchQuery = (search) => {
  if (!search) return {};

  return {
    $or: [
      { name: { $regex: search, $options: "i" } },
      { "created_by.full_name": { $regex: search, $options: "i" } },
      { file_name: { $regex: search, $options: "i" } },
    ],
  };
};

// Campos posibles donde puede estar la cédula/identificación (normalizados con y sin tildes)
const POSSIBLE_ID_FIELDS = [
  // Sin tildes
  "NUM_DOCUMENTO", "IDENTIFICACION", "CEDULA", "NUMERO_IDENTIFICACION",
  "DOCUMENTO", "NUMERO_DOCUMENTO", "NRO_DOCUMENTO", "IDENTIFICACION_BENEFICIARIO",
  "IDENTIFICATION", "CEDULA_CIUDADANIA", "NUMERO_CEDULA", "NO_DOCUMENTO",
  "NRO_IDENTIFICACION", "CEDULA_DE_CIUDADANIA", "DOC_IDENTIDAD",
  // Con tildes convertidas a _ por normalizeFieldName
  "C_DULA",                          // Cédula
  "C_DULA_DE_CIUDADAN_A",            // Cédula de Ciudadanía
  "C_DULA_CIUDADAN_A",               // Cédula Ciudadanía
  "IDENTIFICACI_N",                  // Identificación
  "N_MERO_IDENTIFICACI_N",           // Número Identificación
  "N_MERO_DE_IDENTIFICACI_N",        // Número de Identificación
  "N_MERO_DOCUMENTO",                // Número Documento
  "N_MERO_DE_DOCUMENTO",             // Número de Documento
  "NO_IDENTIFICACI_N",               // No. Identificación
  "NRO_IDENTIFICACI_N",              // Nro. Identificación
];

const findIdentificationInRow = (row) => {
  for (const field of POSSIBLE_ID_FIELDS) {
    const val = row[field];
    if (val !== undefined && val !== null && val !== "") {
      const str = String(val).trim();
      if (str !== "") return str;
    }
  }
  // Fallback: cualquier campo con 6-12 dígitos (cédulas colombianas)
  for (const [, value] of Object.entries(row)) {
    if (value !== undefined && value !== null) {
      const str = String(value).trim();
      if (/^\d{6,12}$/.test(str)) {
        return str;
      }
    }
  }
  return null;
};

// Todos los posibles nombres normalizados de columnas para cada campo de Integra
const INTEGRA_FIELD_ALIASES = {
  full_name: [
    "NOMBRE_COMPLETO", "NOMBRE", "NOMBRES_Y_APELLIDOS", "APELLIDOS_Y_NOMBRES",
    "NOMBRE_DEL_FUNCIONARIO", "NOMBRE_DEL_DOCENTE", "NOMBRE_DEL_EMPLEADO",
    "NOMBRE_DEL_ESTUDIANTE", "NOMBRE_BENEFICIARIO", "NOMBRE_PARTICIPANTE",
    "APELLIDO_Y_NOMBRE", "NOMBRE_Y_APELLIDO", "FULL_NAME",
  ],
  position: [
    "CARGO", "POSITION", "CARGO_ACTUAL", "TIPO_DE_VINCULACION",
    "TIPO_VINCULACION", "VINCULACION", "NIVEL_JERARQUICO",
    // Con tildes → _
    "TIPO_DE_VINCULACI_N",    // Tipo de Vinculación
    "NIVEL_JER_RQUICO",       // Nivel Jerárquico
  ],
  email: [
    "EMAIL", "CORREO", "CORREO_ELECTRONICO", "CORREO_INSTITUCIONAL",
    "CORREO_ELECTR_NICO",     // Correo Electrónico
    "EMAIL_INSTITUCIONAL", "CORREO_PERSONAL", "EMAIL_PERSONAL",
  ],
  dep_code: [
    "CODIGO_DEPENDENCIA", "DEP_CODE", "COD_DEPENDENCIA", "CODIGO_DEP",
    "C_DIGO_DEPENDENCIA",     // Código Dependencia
    "C_D_DEPENDENCIA",
  ],
  birth_date: [
    "FECHA_NACIMIENTO",
    "FECHA_DE_NACIMIENTO",
    "BIRTH_DATE",
    "FECHA_NAC",
    "F_NACIMIENTO",
    "F_NAC",
    "FECHA_NACIMIENTO_BENEFICIARIO",
    "FECHA_NACIMIENTO_PARTICIPANTE",
    "FECHA_NACIMIENTO_FUNCIONARIO",
    "FECHA_NACIMIENTO_DOCENTE",
    "FECHA_NACIMIENTO_ESTUDIANTE",
    // Con tildes → _ (normalizeFieldName)
    "FECHA_DE_NACIMIENTO",   // mismo sin tilde
    "FECHA_NACIMIENTO_",     // variante con espacio al final
  ],
};

// Clasifica el cargo de Integra en una de las 4 categorías SNIES
const categorizePosition = (position) => {
  if (!position) return null;
  const pos = String(position)
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (/DIRECTIV|DIRECTOR|RECTOR|DECANO|VICERRECTOR|JEFE|COORDINADOR|GERENTE|SUBDIRECTOR|VICEDECAN/.test(pos))
    return "directivo";
  if (/PROFESIONAL|ASESOR|ANALISTA|ESPECIALISTA|INVESTIGADOR/.test(pos))
    return "profesional";
  if (/TECNIC/.test(pos))
    return "tecnico";
  if (/AUXILIAR|ASISTENTE|OPERARIO|SECRETARI|ASISTENCIAL|MENSAJERO|CONDUCTOR/.test(pos))
    return "auxiliar";
  return null;
};

const enrichWithIntegraUserData = async (rows) => {
  if (!process.env.USERS_ENDPOINT) {
    console.log("[SNIES-Integra] USERS_ENDPOINT no configurado, sin enriquecimiento.");
    return rows;
  }

  try {
    console.log(`[SNIES-Integra] Consultando Integra para enriquecer ${rows.length} filas...`);
    const [response, externalStudents] = await Promise.all([
      axios.get(process.env.USERS_ENDPOINT, { timeout: 15000 }),
      getExternalStudents(),
    ]);
    const users = Array.isArray(response.data) ? response.data : [];
    const identifications = [...new Set(rows.map(findIdentificationInRow).filter(Boolean))];
    const studentsFromDb = identifications.length
      ? await Student.find(
          { identification: { $in: identifications } },
          { identification: 1, program: 1, program_code: 1 }
        ).lean()
      : [];
    const studentsFromApi = externalStudents
      .filter((student) => identifications.includes(String(student?.identification || "").trim()))
      .map((student) => ({
        identification: String(student.identification).trim(),
        program: student.program,
        program_code: student.program_code,
        status: student.status,
      }));
    const students = [...studentsFromDb, ...studentsFromApi];
    console.log(`[SNIES-Integra] Integra devolvió ${users.length} usuarios.`);
    console.log(`[SNIES-Integra] Estudiantes encontrados para cruce: ${students.length}.`);

    // Mapa cédula → usuario
    const userMap = {};
    users.forEach((user) => {
      if (user.identification) {
        userMap[String(user.identification).trim()] = user;
      }
    });

    const studentMap = {};
    students.forEach((student) => {
      if (student.identification) {
        const identification = String(student.identification).trim();
        const currentStudent = studentMap[identification];
        if (
          !currentStudent ||
          getStudentRecordPriority(student) > getStudentRecordPriority(currentStudent)
        ) {
          studentMap[identification] = student;
        }
      }
    });

    // Conteo de personal por dep_code y categoría
    const countsByDep = {};
    users.forEach((user) => {
      if (!user.dep_code) return;
      const dep = String(user.dep_code).trim();
      if (!countsByDep[dep]) {
        countsByDep[dep] = { auxiliar: 0, tecnico: 0, profesional: 0, directivo: 0 };
      }
      const cat = categorizePosition(user.position);
      if (cat) countsByDep[dep][cat] += 1;
    });

    // Debug: mostrar dep_codes disponibles en Integra y en las filas
    const sampleDepCodesIntegra = Object.keys(countsByDep).slice(0, 5);
    const sampleDepCodesRows = [...new Set(rows.map((r) => r.__DEP_CODE).filter(Boolean))].slice(0, 5);
    console.log("[SNIES-Integra] Dep_codes en Integra (muestra):", sampleDepCodesIntegra);
    console.log("[SNIES-Integra] Dep_codes en filas (muestra):", sampleDepCodesRows);
    if (rows.length > 0) {
      console.log("[SNIES-Integra] Campos en fila 0:", Object.keys(rows[0]));
      const sampleId = findIdentificationInRow(rows[0]);
      console.log("[SNIES-Integra] Cédula fila 0:", sampleId, "→ en Integra:", !!userMap[sampleId]);
    }

    let enrichedCount = 0;
    let cantPersonalCount = 0;
    let programSniesCount = 0;
    const enrichedRows = rows.map((row) => {
      const enriched = { ...row };
      const identification = findIdentificationInRow(row);
      const student = identification ? studentMap[identification] : null;
      const existingProgramName = findProgramNameInRow(enriched);

      // 1. Enriquecer datos del individuo por cédula
      if (identification && userMap[identification]) {
        const u = userMap[identification];
        const integraFields = {
          full_name: u.full_name,
          position: u.position,
          email: u.email,
          dep_code: u.dep_code,
          birth_date: u.birth_date,
        };
        Object.entries(integraFields).forEach(([field, value]) => {
          if (!value) return;
          (INTEGRA_FIELD_ALIASES[field] || []).forEach((alias) => {
            if (!enriched[alias] || enriched[alias] === "") enriched[alias] = value;
          });
        });
        enrichedCount += 1;
      }

      // 1.1 Completar el programa y el código SNIES cuando sea posible
      const resolvedProgramName = student?.program || existingProgramName || null;
      const resolvedProgramCode =
        findExistingSniesCodeInRow(enriched) ||
        student?.program_code ||
        getRowValueByAliases(enriched, PRO_CONSECUTIVO_FIELDS) ||
        findProgramSniesCode(resolvedProgramName);

      if (resolvedProgramName) {
        PROGRAM_NAME_FIELDS.forEach((alias) => {
          if (!enriched[alias] || enriched[alias] === "") {
            enriched[alias] = resolvedProgramName;
          }
        });
      }

      const sniesCode = findProgramSniesCode(resolvedProgramName) || resolvedProgramCode;
      if (sniesCode) {
        PRO_CONSECUTIVO_FIELDS.forEach((alias) => {
          if (!enriched[alias] || enriched[alias] === "") {
            enriched[alias] = String(sniesCode).replace(/\./g, "");
          }
        });
        programSniesCount += 1;
      }

      // 2. Inyectar conteos CANT_PERSONAL_* por dep_code de la dependencia que subió los datos
      // Prioridad: dep_code interno del loaded_data (más confiable que el del usuario individual)
      const depCode = String(row.__DEP_CODE || "").trim();
      const counts = depCode ? countsByDep[depCode] : null;
      if (counts) {
        if (!enriched.CANT_PERSONAL_AUXILIAR || enriched.CANT_PERSONAL_AUXILIAR === "")
          enriched.CANT_PERSONAL_AUXILIAR = counts.auxiliar;
        if (!enriched.CANT_PERSONAL_TECNICO || enriched.CANT_PERSONAL_TECNICO === "")
          enriched.CANT_PERSONAL_TECNICO = counts.tecnico;
        if (!enriched.CANT_PERSONAL_PROFESIONAL || enriched.CANT_PERSONAL_PROFESIONAL === "")
          enriched.CANT_PERSONAL_PROFESIONAL = counts.profesional;
        if (!enriched.CANT_PERSONAL_DIRECTIVO || enriched.CANT_PERSONAL_DIRECTIVO === "")
          enriched.CANT_PERSONAL_DIRECTIVO = counts.directivo;
        cantPersonalCount += 1;
      }

      return enriched;
    });

    console.log(`[SNIES-Integra] CANT_PERSONAL inyectado en ${cantPersonalCount} filas.`);
    console.log(`[SNIES-Integra] PRO_CONSECUTIVO asignado en ${programSniesCount} filas.`);
    console.log(`[SNIES-Integra] Enriquecidas ${enrichedCount} de ${rows.length} filas.`);
    return enrichedRows;
  } catch (error) {
    console.error("[SNIES-Integra] Error al consultar Integra:", error.message);
    return rows;
  }
};

const getMergedDataForPublishedTemplate = async (publishedTemplateId) => {
  const publishedTemplate = await PublishedTemplate.findById(publishedTemplateId);
  if (!publishedTemplate) {
    throw new Error("Published template not found");
  }

  const loadedDataItems = Array.isArray(publishedTemplate.loaded_data)
    ? publishedTemplate.loaded_data
    : [];

  const dependencies = await Dependency.find({
    dep_code: { $in: loadedDataItems.map((item) => item?.dependency).filter(Boolean) },
  }).select("dep_code name");

  const depCodeToNameMap = dependencies.reduce((acc, dependency) => {
    acc[dependency.dep_code] = dependency.name;
    return acc;
  }, {});

  const rows = [];

  for (const loadedData of loadedDataItems) {
    if (!Array.isArray(loadedData.filled_data) || loadedData.filled_data.length === 0) {
      continue;
    }

    const recordMap = [];

    loadedData.filled_data.forEach((fieldData) => {
      const values = Array.isArray(fieldData?.values) ? fieldData.values : [];

      values.forEach((rawValue, index) => {
        if (!recordMap[index]) {
          recordMap[index] = {
            Dependencia: depCodeToNameMap[loadedData.dependency] || loadedData.dependency,
            __DEP_CODE: loadedData.dependency, // dep_code interno para enriquecimiento
          };
        }

        recordMap[index][normalizeFieldName(fieldData.field_name)] = convertCellValue(rawValue);
      });
    });

    rows.push(...recordMap);
  }

  return enrichWithIntegraUserData(rows);
};

// Parsea año y semestre a partir del nombre del período
// Soporta: "2024-1", "2024-2", "2024-I", "2024-II", "2024 1", "2024 II", etc.
const parsePeriodYearSemester = (period) => {
  const name = String(period?.name || "").trim();

  // Extraer año (4 dígitos)
  const yearMatch = name.match(/\b(20\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : String(new Date(period?.start_date || Date.now()).getFullYear());

  // Extraer semestre: buscar 1/2 o I/II después del año
  let semester = null;
  const semMatch = name.match(/[-\s]+(II|I|2|1)\s*$/i);
  if (semMatch) {
    const raw = semMatch[1].toUpperCase();
    if (raw === "II" || raw === "2") semester = "2";
    else if (raw === "I" || raw === "1") semester = "1";
  }

  // Fallback: usar mes del start_date (antes de julio → sem 1, julio+ → sem 2)
  if (!semester && period?.start_date) {
    const month = new Date(period.start_date).getMonth() + 1; // 1-12
    semester = month < 7 ? "1" : "2";
  }

  return { year, semester: semester || "1" };
};

// Nombres normalizados de columnas Excel que representan año, semestre o nombre del período
const PERIOD_FIELD_ALIASES = {
  year: [
    "A_O",               // Año (Ñ→_)
    "ANO",               // Ano
    "ANIO",              // Anio
    "YEAR",
    "ANUAL",
    "A_O_DEL_PERIODO",
    "A_O_DEL_PER_ODO",
    "A_O_ACADEMICO",
    "A_O_ACAD_MICO",
    "A_O_LECTIVO",
    "VIGENCIA",
  ],
  // Solo columnas que claramente son para el semestre del PERÍODO (1 o 2), no del estudiante
  semester: [
    "SEMESTRE",
    "SEM",
    "SEMESTRE_DEL_PERIODO",
    "SEMESTRE_DEL_PER_ODO",
    "SEMESTRE_PERIODO",
    "SEM_PERIODO",
    "SEMESTRE_ACAD_MICO",  // Semestre Académico
    "SEMESTRE_ACADEMICO",
  ],
  // Columnas que reciben el nombre completo del período (ej: "2024-1")
  periodName: [
    "PERIODO",
    "PER_ODO",
    "PERIODO_ACADEMICO",
    "PER_ODO_ACAD_MICO",
    "NOMBRE_PERIODO",
    "NOMBRE_DEL_PERIODO",
    "NOMBRE_PER_ODO",
    "NOMBRE_DEL_PER_ODO",
    "PERIODO_LECTIVO",
    "PER_ODO_LECTIVO",
    "NOMBRE_PERIODO_ACADEMICO",
  ],
};

const getPeriodValueForHeader = (normalizedHeader, periodValues) => {
  if (!normalizedHeader) {
    return undefined;
  }

  const { year, semester, periodName } = periodValues;

  if (
    PERIOD_FIELD_ALIASES.year.includes(normalizedHeader) ||
    normalizedHeader.includes("A_O_PERIODO") ||
    normalizedHeader.includes("ANIO_PERIODO") ||
    normalizedHeader.includes("ANO_PERIODO")
  ) {
    return year;
  }

  if (
    PERIOD_FIELD_ALIASES.semester.includes(normalizedHeader) ||
    normalizedHeader === "SEMESTRE" ||
    normalizedHeader === "SEM"
  ) {
    return semester;
  }

  if (
    PERIOD_FIELD_ALIASES.periodName.includes(normalizedHeader) ||
    normalizedHeader.includes("PERIODO")
  ) {
    return periodName;
  }

  return undefined;
};

const injectPeriodFields = (rows, year, semester, periodName) => {
  if (!rows.length) return rows;
  return rows.map((row) => {
    const enriched = { ...row };
    PERIOD_FIELD_ALIASES.year.forEach((alias) => {
      if (!enriched[alias] || enriched[alias] === "") enriched[alias] = year;
    });
    PERIOD_FIELD_ALIASES.semester.forEach((alias) => {
      if (!enriched[alias] || enriched[alias] === "") enriched[alias] = semester;
    });
    PERIOD_FIELD_ALIASES.periodName.forEach((alias) => {
      if (!enriched[alias] || enriched[alias] === "") enriched[alias] = periodName;
    });
    return enriched;
  });
};

const buildSniesDataset = async (template) => {
  // Cargar período para inyectar año y semestre en las filas
  let periodYear = null;
  let periodSemester = null;
  let periodName = null;
  if (template.period) {
    const period = await Period.findById(template.period).select("name start_date");
    if (period) {
      const parsed = parsePeriodYearSemester(period);
      periodYear = parsed.year;
      periodSemester = parsed.semester;
      periodName = period.name;
      console.log(`[SNIES-Period] Período: "${periodName}" → Año: ${periodYear}, Semestre: ${periodSemester}`);
    }
  }

  const periodValues = {
    year: periodYear,
    semester: periodSemester,
    periodName,
  };

  const sourceTemplates = getSourceTemplatesFromSnies(template);
  const sourceDatasetResults = await Promise.allSettled(
    sourceTemplates.map(async (sourceTemplate) => ({
      ...sourceTemplate,
      rows: await getMergedDataForPublishedTemplate(sourceTemplate.template_id),
    }))
  );
  const sourceDatasets = sourceDatasetResults
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);

  // Inyectar año y semestre del período en cada fila
  const enrichedSourceDatasets = sourceDatasets.map((sourceTemplate) => {
    const rows = periodYear
      ? injectPeriodFields(sourceTemplate.rows, periodYear, periodSemester, periodName)
      : sourceTemplate.rows;
    return {
      ...sourceTemplate,
      rows,
      normalizedKeys: getNormalizedRowKeys(rows),
    };
  });

  const templateBuffer = await downloadDriveFileBuffer(template.drive_file_id);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer);
  const workbookNotes = captureWorkbookNotes(workbook);
  const worksheets = workbook.worksheets;

  if (!worksheets[0]) {
    throw new Error("SNIES template workbook has no worksheets");
  }

  const useWorksheetMapping = worksheets.length > 1;
  const mergedRows = enrichedSourceDatasets.flatMap((sourceTemplate) => sourceTemplate.rows);

  const sheetDatasets = worksheets.map((worksheet) => {
    const { headerRowNumber, headers } = extractWorksheetHeaders(worksheet);

    if (isInfoWorksheet(worksheet.name)) {
      return {
        worksheet,
        worksheetName: worksheet.name,
        headerRowNumber,
        headers,
        rows: [],
        sourceTemplate: null,
        preserveOriginalContent: true,
      };
    }

    if (headers.length === 0) {
      return {
        worksheet,
        worksheetName: worksheet.name,
        headerRowNumber,
        headers: [],
        rows: [],
        sourceTemplate: null,
        preserveOriginalContent: false,
      };
    }

    const matchedSourceTemplate = useWorksheetMapping
      ? getWorksheetTemplateMatch(worksheet.name, headers, enrichedSourceDatasets)
      : null;
    const sourceRows = useWorksheetMapping
      ? matchedSourceTemplate?.rows || mergedRows
      : mergedRows;

    const normalizedHeaders = headers.map((header) => normalizeFieldName(header));
    const finalRows = sourceRows.map((row) => {
      const normalizedRow = Object.entries(row).reduce((acc, [key, value]) => {
        acc[normalizeFieldName(key)] = value;
        return acc;
      }, {});

      return headers.reduce((acc, header, index) => {
        const normalizedHeader = normalizedHeaders[index];
        const directValue = normalizedRow[normalizedHeader];
        const periodFallback = periodYear
          ? getPeriodValueForHeader(normalizedHeader, periodValues)
          : undefined;

        acc[header] = directValue ?? periodFallback ?? "";
        return acc;
      }, {});
    });

    return {
      worksheet,
      worksheetName: worksheet.name,
      headerRowNumber,
      headers,
      rows: finalRows,
      sourceTemplate: matchedSourceTemplate
        ? {
            template_id: matchedSourceTemplate.template_id,
            template_name: matchedSourceTemplate.template_name,
          }
        : null,
      preserveOriginalContent: false,
    };
  });

  return { workbook, sheetDatasets, sourceTemplates, workbookNotes, templateBuffer };
};

controller.getTemplates = async (req, res) => {
  try {
    const {
      email,
      page = 1,
      limit = 10,
      search = "",
      periodId,
    } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const pageNumber = parseInt(page, 10);
    const pageSize = parseInt(limit, 10);
    const skip = (pageNumber - 1) * pageSize;

    const query = {
      ...buildSearchQuery(search),
      ...(periodId ? { period: periodId } : {}),
    };

    const templates = await SniesTemplate.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize);

    const total = await SniesTemplate.countDocuments(query);

    return res.status(200).json({
      templates,
      total,
      page: pageNumber,
      pages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error("Error fetching SNIES templates:", error);
    return res.status(500).json({
      error: "Error fetching SNIES templates",
      details: error.message,
    });
  }
};

controller.getFeedOptions = async (req, res) => {
  try {
    const { email, periodId, search = "" } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const query = {
      ...(periodId ? { period: periodId } : {}),
      ...(search
        ? {
            name: { $regex: search, $options: "i" },
          }
        : {}),
      "loaded_data.0": { $exists: true },
    };

    const publishedTemplates = await PublishedTemplate.find(query)
      .sort({ name: 1 })
      .select("_id name period loaded_data");

    return res.status(200).json({
      publishedTemplates: publishedTemplates.map((template) => ({
        value: template._id.toString(),
        label: `${template.name} (${template.loaded_data?.length || 0} dependencias)`,
        name: template.name,
      })),
    });
  } catch (error) {
    console.error("Error fetching SNIES feed options:", error);
    return res.status(500).json({
      error: "Error fetching SNIES feed options",
      details: error.message,
    });
  }
};

controller.getConnectedData = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await SniesTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "SNIES template not found" });
    }

    const dataset = await buildSniesDataset(template);

    return res.status(200).json({
      template: {
        _id: template._id,
        name: template.name,
        file_name: template.file_name,
      },
      sourceTemplates: dataset.sourceTemplates,
      sheets: dataset.sheetDatasets.map((sheet) => ({
        worksheetName: sheet.worksheetName,
        sourceTemplate: sheet.sourceTemplate,
        headers: sheet.headers,
        rows: sheet.rows,
        preserveOriginalContent: sheet.preserveOriginalContent,
      })),
    });
  } catch (error) {
    console.error("Error fetching SNIES connected data:", error);
    return res.status(500).json({
      error: "Error fetching SNIES connected data",
      details: error.message,
    });
  }
};

controller.downloadConnectedData = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await SniesTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "SNIES template not found" });
    }

    const { workbook, sheetDatasets, workbookNotes, templateBuffer } = await buildSniesDataset(template);
    restoreWorkbookNotes(workbook, workbookNotes);

    const zip = new PizZip(templateBuffer);
    const worksheetXmlPathMap = getWorksheetXmlPathMap(zip);

    sheetDatasets.forEach(({ worksheetName, headers, rows, headerRowNumber, preserveOriginalContent }) => {
      if (preserveOriginalContent || !headers.length) {
        return;
      }

      const worksheetPath = worksheetXmlPathMap[worksheetName];
      const worksheetFile = worksheetPath ? zip.file(worksheetPath) : null;
      if (!worksheetFile) {
        return;
      }

      const updatedWorksheetXml = rewriteWorksheetXml(
        worksheetFile.asText(),
        headers,
        rows,
        headerRowNumber
      );

      zip.file(worksheetPath, updatedWorksheetXml);
    });

    const outputBuffer = zip.generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    });

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${buildDownloadFileName(template)}"; filename*=UTF-8''${encodeURIComponent(buildDownloadFileName(template))}`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    return res.send(outputBuffer);
  } catch (error) {
    console.error("Error downloading SNIES connected data:", error);
    return res.status(500).json({
      error: "Error downloading SNIES connected data",
      details: error.message,
    });
  }
};

controller.downloadTemplateFile = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await SniesTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "SNIES template not found" });
    }

    const fileBuffer = await downloadDriveFileBuffer(template.drive_file_id);
    const downloadFileName = buildDownloadFileName(template);

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${downloadFileName}"; filename*=UTF-8''${encodeURIComponent(downloadFileName)}`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    return res.send(fileBuffer);
  } catch (error) {
    console.error("Error downloading SNIES template file:", error);
    return res.status(500).json({
      error: "Error downloading SNIES template file",
      details: error.message,
    });
  }
};

controller.createTemplate = async (req, res) => {
  try {
    const { email, name, periodId } = req.body;
    const sourcePublishedTemplateIds = []
      .concat(req.body.sourcePublishedTemplateIds || [])
      .concat(req.body.sourcePublishedTemplateId || [])
      .filter(Boolean);

    if (!req.file) {
      return res.status(400).json({ error: "No file attached" });
    }

    if (!name?.trim()) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(400).json({ error: "Name is required" });
    }

    const user = await UserService.findUserByEmailAndRoles(email, [
      "Administrador",
      "Responsable",
    ]);
    const sourceTemplates = await getPublishedTemplateSources(sourcePublishedTemplateIds);

    const uploaded = await uploadFileToGoogleDrive(
      req.file,
      "Formatos/Plantillas/SNIES",
      req.file.originalname
    );

    const template = new SniesTemplate({
      name: name.trim(),
      file_name: req.file.originalname,
      created_by: user,
      period: periodId || undefined,
      source_published_template_id: sourceTemplates[0]?._id,
      source_published_template_name: sourceTemplates[0]?.name,
      source_published_templates: sourceTemplates.map((template) => ({
        template_id: template._id,
        template_name: template.name,
      })),
      drive_file_id: uploaded.id,
      drive_file_link: uploaded.webViewLink,
      drive_file_download: uploaded.webContentLink,
    });

    await template.save();

    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    return res.status(201).json({
      message: "SNIES template created",
      template,
    });
  } catch (error) {
    console.error("Error creating SNIES template:", error);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({
      error: "Error creating SNIES template",
      details: error.message,
    });
  }
};

controller.updateTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const { email, name, periodId } = req.body;
    const sourcePublishedTemplateIds = []
      .concat(req.body.sourcePublishedTemplateIds || [])
      .concat(req.body.sourcePublishedTemplateId || [])
      .filter(Boolean);

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await SniesTemplate.findById(id);
    if (!template) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(404).json({ error: "SNIES template not found" });
    }

    if (name?.trim()) {
      template.name = name.trim();
    }
    if (periodId) {
      template.period = periodId;
    }
    if (sourcePublishedTemplateIds.length > 0) {
      const sourceTemplates = await getPublishedTemplateSources(sourcePublishedTemplateIds);
      template.source_published_template_id = sourceTemplates[0]._id;
      template.source_published_template_name = sourceTemplates[0].name;
      template.source_published_templates = sourceTemplates.map((sourceTemplate) => ({
        template_id: sourceTemplate._id,
        template_name: sourceTemplate.name,
      }));
    }

    if (req.file) {
      const updated = await updateFileInGoogleDrive(
        template.drive_file_id,
        req.file,
        req.file.originalname
      );

      template.file_name = req.file.originalname;
      template.drive_file_link = updated.webViewLink;
      template.drive_file_download = updated.webContentLink;
    }

    await template.save();

    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    return res.status(200).json({
      message: "SNIES template updated",
      template,
    });
  } catch (error) {
    console.error("Error updating SNIES template:", error);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(500).json({
      error: "Error updating SNIES template",
      details: error.message,
    });
  }
};

controller.deleteTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await SniesTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "SNIES template not found" });
    }

    if (template.drive_file_id) {
      await deleteDriveFile(template.drive_file_id);
    }

    await SniesTemplate.findByIdAndDelete(id);

    return res.status(200).json({ message: "SNIES template deleted" });
  } catch (error) {
    console.error("Error deleting SNIES template:", error);
    return res.status(500).json({
      error: "Error deleting SNIES template",
      details: error.message,
    });
  }
};

module.exports = controller;
