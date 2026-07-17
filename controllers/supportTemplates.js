const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");
const ExcelJS = require("exceljs");

const PublishedTemplate = require("../models/publishedTemplates");
const Student = require("../models/students");
const User = require("../models/users");
const Dependency = require("../models/dependencies");
const ValidatorModel = require("../models/validators");
const Period = require("../models/periods");
const { extractDropdownOptionsFromComment } = require("../helpers/dropdownOptions");

const controller = {};

const GENERATED_COLUMN_DEFINITIONS = [
  { key: "NOMBRE_IDENTIFICADO", label: "Nombre identificado" },
  { key: "PROGRAMA_DEPENDENCIA", label: "Programa o dependencia" },
];

const GENERATED_COLUMNS = GENERATED_COLUMN_DEFINITIONS.map((column) => column.key);
const DEPRECATED_GENERATED_COLUMNS = [
  "FUENTE_PERSONA",
  "TIPO_APOYO_DETECTADO",
  "NOMBRE_APOYO_DETECTADO",
  "APOYOS_OTROS_PERIODOS",
  "PERIODOS_APOYO_PREVIO",
  "PLANTILLAS_APOYO_PREVIO",
  "ESTADO_CRUCE",
  "Tipo de apoyo detectado",
  "Nombre de apoyo detectado",
  "Apoyos en otros periodos",
  "Periodos con apoyo previo",
  "Plantillas con apoyo previo",
  "Estado del cruce",
];
const EMPTY_OUTPUT_VALUE = "SIN INFORMACION";
const OUTPUT_HEADER_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF404040" },
};
const OUTPUT_HEADER_FONT = {
  bold: true,
  color: { argb: "FFFFFFFF" },
};

const VALIDATOR_FIELD_MAPPINGS = {
  ID_TIPO_DOCUMENTO: "TIPO_DOCUMENTO",
  TIPO_DOCUMENTO: "TIPO_DOCUMENTO",
  ID_TIPO_CAPACITACION: "TIPO_CAPACITACION_GH",
  TIPO_CAPACITACION: "TIPO_CAPACITACION_GH",
  ID_CAPACITACION: "TIPO_CAPACITACION_GH",
  ID_TIPO_CURSO: "TIPO_CURSO_GH",
  TIPO_CURSO: "TIPO_CURSO_GH",
  ID_TIPO_CURSO_GH: "TIPO_CURSO_GH",
  ID_TEMA_CURSO: "TEMA_CURSO",
  TEMA_CURSO: "TEMA_CURSO",
  TIPO_DE_APOYO_FINANCIERO_ACADEMICO_OTROS_APOYOS: "TIPO_DE_APOYO",
  TIPO_DE_APOYO_FINANCIERO_ACAD_MICO_OTROS_APOYOS: "TIPO_DE_APOYO",
  TIPO_DE_APOYO: "TIPO_DE_APOYO",
  ID_TIPO_DE_APOYO: "TIPO_DE_APOYO",
  ID_TIPOS_DE_APOYOS: "TIPO_DE_APOYO",
  ID_TIPO_RECURSO: "TIPO_RECURSOS",
  TIPO_RECURSO: "TIPO_RECURSOS",
  ID_TIPO_RECURSOS: "TIPO_RECURSOS",
  ID_SECTOR_CONSULTORIA: "SECTOR_CONSULTORIA",
  SECTOR_CONSULTORIA: "SECTOR_CONSULTORIA",
  ID_MAXIMO_NIVEL_ESTUDIO: "TIPO_ACADEMICO_NO_ACADEMICO",
  ID_TIPO_BENEF_EXTENSION: "TIPO_BENEFICIARIO",
  ID_TIPO_BENEFICIARIO: "TIPO_BENEFICIARIO",
  ID_TIPO_DERECHO_PECUNIARIO: "TIPO_DERECHOS_PECUNIARIOS",
  ID_TIPO_ESTIMULO: "TIPO_ESTIMULO",
  ID_DEDICACION: "DEDICACION",

  // SNIES / Histórico Docentes
  DEDICACION: "DEDICACION",
  TIPO_CONTRATO: "TIPO_CONTRATO",
  TIPO_CONTRATO_DOCENTE: "TIPO_CONTRATO",
  METODOLOGIA_CONTRATO: "METODOLOGIA_CONTRATO",
  NIVEL_CONTRATO: "NIVEL_DOCENTE",
  NIVEL_DOCENTE: "NIVEL_DOCENTE",
  INGRESO_CONTRATO: "TIPO_VINCULACION",
  TIPO_VINCULACION: "TIPO_VINCULACION",

  // Capacitación GH (con y sin prefijo)
  CATEGORIA_GESTION: "CATEGORIA_GESTION_CURRICULAR",
  CATEGORIA_GESTION_CURRICULAR: "CATEGORIA_GESTION_CURRICULAR",
};

const ID_ALIASES = new Set([
  "NUM_DOCUMENTO",
  "NUMERO_DOCUMENTO",
  "NRO_DOCUMENTO",
  "NO_DOCUMENTO",
  "DOCUMENTO",
  "IDENTIFICACION",
  "NUMERO_IDENTIFICACION",
  "NRO_IDENTIFICACION",
  "CEDULA",
  "CEDULA_CIUDADANIA",
  "CEDULA_DE_CIUDADANIA",
  "DOC_IDENTIDAD",
  "IDENTIFICACION_BENEFICIARIO",
  // abreviaciones comunes SNIES / otras fuentes
  "NUM_DOC",
  "NRO_DOC",
  "NUMERO_DOC",
  "NO_DOC",
  "N_DOCUMENTO",
]);

const normalizeHeader = (value = "") =>
  String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

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

const noteToText = (note) => {
  if (!note) return "";
  if (typeof note === "string") return note;
  if (Array.isArray(note.texts)) return note.texts.map((item) => item?.text || "").join("");
  if (Array.isArray(note.richText)) return note.richText.map((item) => item?.text || "").join("");
  if (note.text) return String(note.text);
  return "";
};

const normalizeLookupValue = (value) => cellToText(value).trim().toUpperCase();

const splitTokens = (value = "") =>
  normalizeHeader(value)
    .split("_")
    .filter((token) => token && !["ID", "COD", "CODIGO", "DE", "DEL", "LA", "LAS", "LOS", "EL"].includes(token));

const normalizeId = (value) => {
  const raw = cellToText(value).trim();
  if (!raw) return "";
  return raw.replace(/[^\dA-Za-z]/g, "");
};

const isBlank = (value) => cellToText(value).trim() === "";

function cellToText(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== "object") return String(value);
  if (value.text !== undefined) return String(value.text);
  if (value.result !== undefined) return cellToText(value.result);
  if (Array.isArray(value.richText)) return value.richText.map((item) => item.text || "").join("");
  if (value.hyperlink && value.text) return String(value.text);
  return String(value);
}

const firstValue = (items) => {
  for (const item of items) {
    const value = cellToText(item).trim();
    if (value) return value;
  }
  return "";
};

const isDescriptionColumn = (columnName = "") => {
  const normalized = normalizeHeader(columnName);
  return (
    normalized.includes("DESCRIPCION") ||
    normalized.includes("NOMBRE") ||
    normalized.startsWith("DESC") ||
    normalized.includes("DETALLE") ||
    normalized.includes("LABEL")
  );
};

const selectDescriptionColumn = (validator, idColumn) => {
  const columns = Array.isArray(validator?.columns) ? validator.columns : [];
  return (
    columns.find((column) => column.name !== idColumn?.name && isDescriptionColumn(column.name)) ||
    columns.find((column) => column.name !== idColumn?.name && !column.is_validator)
  );
};

const buildValidatorLookup = async (periodId = null) => {
  let rawValidators;
  if (periodId) {
    const period = await Period.findById(periodId).select("screenshot.validators").lean();
    const periodValidators = period?.screenshot?.validators || [];
    rawValidators = periodValidators.length > 0 ? periodValidators : await ValidatorModel.find({}).lean();
  } else {
    rawValidators = await ValidatorModel.find({}).lean();
  }

  return rawValidators
    .map((validator) => {
      const columns = Array.isArray(validator.columns) ? validator.columns : [];
      const idColumn = columns.find((column) => column.is_validator) || columns[0];
      const descriptionColumn = selectDescriptionColumn(validator, idColumn);
      if (!idColumn?.values || !descriptionColumn?.values) return null;

      const valueMap = new Map();
      idColumn.values.forEach((id, index) => {
        const key = normalizeLookupValue(id);
        const description = cellToText(descriptionColumn.values[index]).trim();
        if (key && description) valueMap.set(key, description);
      });

      if (valueMap.size === 0) return null;

      return {
        name: validator.name,
        normalizedName: normalizeHeader(validator.name),
        tokens: new Set([...splitTokens(validator.name), ...splitTokens(idColumn.name)]),
        idColumnName: idColumn.name,
        descriptionColumnName: descriptionColumn.name,
        valueMap,
      };
    })
    .filter(Boolean);
};

const isValidatorCandidateHeader = (header, sampleValues) => {
  const normalized = normalizeHeader(header.name);
  console.log(`[VALIDATOR_CHECK v2] header="${header.name}" normalized="${normalized}"`);
  if (!sampleValues.length) return false;
  if (["NUM_DOCUMENTO", "NUMERO_DOCUMENTO", "NRO_DOCUMENTO", "NO_DOCUMENTO", "DOCUMENTO"].includes(normalized)) {
    return false;
  }
  if (normalized.includes("NUM_DOCUMENTO") || normalized.includes("NUMERO_DOCUMENTO")) return false;
  if (normalized.includes("HORAS") || normalized.includes("VALOR") || normalized.includes("CANTIDAD")) return false;
  if (normalized.includes("DURACION") || normalized.includes("FECHA") || normalized.startsWith("ANO") || normalized.startsWith("AÑO") || normalized.endsWith("ANO") || normalized.endsWith("AÑO")) {
    console.log(`[VALIDATOR_CHECK v2] EXCLUIDO por DURACION/FECHA/ANO: "${normalized}"`);
    return false;
  }

  const shortCodes = sampleValues.every((value) => /^[A-Z0-9]{1,8}$/.test(normalizeLookupValue(value)));
  if (!shortCodes) return false;

  return (
    normalized.startsWith("ID_") ||
    normalized.includes("_ID_") ||
    normalized.includes("TIPO") ||
    normalized.includes("TEMA") ||
    normalized.includes("CATEGORIA") ||
    normalized.includes("MODALIDAD") ||
    normalized.includes("SEXO") ||
    normalized.includes("ESTADO") ||
    normalized.includes("PAIS") ||
    normalized.includes("DEDICACION") ||
    normalized.includes("CONTRATO") ||
    normalized.includes("METODOLOGIA") ||
    normalized.includes("NIVEL") ||
    normalized.includes("INGRESO") ||
    normalized.includes("VINCULACION") ||
    normalized in VALIDATOR_FIELD_MAPPINGS
  );
};

const findValidatorForHeader = (header, validators, sampleValues) => {
  const normalized = normalizeHeader(header.name);
  const mappedValidatorName = VALIDATOR_FIELD_MAPPINGS[normalized];
  if (mappedValidatorName) {
    const exact = validators.find((validator) => validator.normalizedName === normalizeHeader(mappedValidatorName));
    if (exact) return exact;
  }

  const headerTokens = splitTokens(header.name);
  if (headerTokens.length === 0) return null;

  let best = null;
  let bestScore = 0;

  validators.forEach((validator) => {
    const overlap = headerTokens.filter((token) => validator.tokens.has(token)).length;
    const valueMatches = sampleValues.filter((value) => validator.valueMap.has(normalizeLookupValue(value))).length;
    const score = overlap * 3 + valueMatches * 2;

    if (score > bestScore) {
      best = validator;
      bestScore = score;
    }
  });

  return bestScore >= 5 ? best : null;
};

const getPersonName = (record = {}) =>
  firstValue([
    record.name,
    record.full_name,
    record.user_name,
    record.student_name,
    record.nombre,
    record.nombres_y_apellidos,
    [record.nombres, record.apellidos].filter(Boolean).join(" "),
  ]);

const getPersonProgram = (record = {}) =>
  firstValue([
    record.program,
    record.programa,
    record.program_name,
    record.programName,
    record.nombre_programa,
    record.academic_program,
    record.program_code,
    record.codigo_programa,
  ]);

const getDependencyCodes = (record = {}) => {
  const secondaryCodes = Array.isArray(record.additional_dependencies) ? record.additional_dependencies : [];
  return [
    record.dep_code,
    record.dependency_code,
    record.codigo_dependencia,
    record.cod_dependencia,
    record.dependencia_codigo,
    ...secondaryCodes,
  ]
    .map((value) => cellToText(value).trim())
    .filter(Boolean);
};

const getPayloadDependencyName = (record = {}) =>
  firstValue([
    record.dependencyName,
    record.dependency_name,
    record.dependency,
    record.dependencia,
    record.dep_name,
    record.nombre_dependencia,
  ]);

const isFacultyDependency = (dependency) => normalizeHeader(dependency?.name || "").includes("FACULTAD");

const findFacultyDependency = (depCode, dependencyByCode) => {
  const visited = new Set();
  let current = dependencyByCode.get(cellToText(depCode).trim());

  while (current && !visited.has(current.dep_code)) {
    if (isFacultyDependency(current)) return current;
    visited.add(current.dep_code);
    current = dependencyByCode.get(cellToText(current.dep_father).trim());
  }

  return null;
};

const getDependencyDisplayName = (depCode, dependencyByCode, fallbackName = "") => {
  const code = cellToText(depCode).trim();
  const dependency = dependencyByCode.get(code);
  const faculty = findFacultyDependency(code, dependencyByCode);
  return faculty?.name || dependency?.name || fallbackName || code;
};

const getFuncionarioContext = (record = {}, dependencyByCode = new Map()) => {
  const dependencyCodes = getDependencyCodes(record);
  const explicitDependencyName = getPayloadDependencyName(record);

  for (const depCode of dependencyCodes) {
    const faculty = findFacultyDependency(depCode, dependencyByCode);
    if (faculty?.name) return faculty.name;
  }

  return getDependencyDisplayName(dependencyCodes[0], dependencyByCode, explicitDependencyName);
};

const buildDependencyByCode = async () => {
  const dependencies = await Dependency.find({}, "dep_code name dep_father").lean();
  return new Map(
    dependencies
      .map((dependency) => ({
        dep_code: cellToText(dependency.dep_code).trim(),
        name: cellToText(dependency.name).trim(),
        dep_father: cellToText(dependency.dep_father).trim(),
      }))
      .filter((dependency) => dependency.dep_code)
      .map((dependency) => [dependency.dep_code, dependency])
  );
};

const putPerson = (map, identification, payload, priority, dependencyByCode = new Map()) => {
  const id = normalizeId(identification);
  const name = getPersonName(payload);
  if (!id || !name) return;

  const current = map.get(id);
  if (!current || priority > current.priority) {
    const personType = payload.personType || "";
    map.set(id, {
      identification: id,
      name,
      email: payload.email || payload.correo || "",
      personType,
      programaDependencia:
        personType === "student"
          ? getPersonProgram(payload)
          : getFuncionarioContext(payload, dependencyByCode),
      priority,
    });
  }
};

const safeGetEndpoint = async (endpoint, timeout = 20000) => {
  if (!endpoint) return [];
  try {
    const response = await axios.get(endpoint, { timeout });
    return Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    console.warn(`[support-templates] No fue posible consultar endpoint externo: ${error.message}`);
    return [];
  }
};

const buildPeopleMap = async (identifications) => {
  const ids = [...new Set(identifications.map(normalizeId).filter(Boolean))];
  const people = new Map();
  if (ids.length === 0) return people;

  const numericIds = ids.map((id) => Number(id)).filter((id) => Number.isFinite(id));
  const [studentsDb, usersDb, usersApi, studentsApi] = await Promise.all([
    Student.find({ identification: { $in: ids } }).lean(),
    User.find({ identification: { $in: numericIds } }).lean(),
    safeGetEndpoint(process.env.USERS_ENDPOINT, 15000),
    safeGetEndpoint(process.env.STUDENTS_ENDPOINT, 20000),
  ]);
  const dependencyByCode = await buildDependencyByCode();

  studentsDb.forEach((student) => putPerson(people, student.identification, { ...student, personType: "student" }, 40, dependencyByCode));
  studentsApi.forEach((student) => putPerson(people, student.identification, { ...student, personType: "student" }, 35, dependencyByCode));
  usersDb.forEach((user) => putPerson(people, user.identification, { ...user, personType: "funcionario" }, 30, dependencyByCode));
  usersApi.forEach((user) => putPerson(people, user.identification, { ...user, personType: "funcionario" }, 25, dependencyByCode));

  return people;
};

const normalizeEmailValue = (value) => cellToText(value).trim().toLowerCase();

// Documento asignado cuando la persona se identifica por correo (no por
// numero de documento): SIGA/Iceberg no entregan el tipo de documento, solo
// el numero — pero practicamente toda la poblacion (estudiantes, egresados y
// administrativos) se identifica con cedula de ciudadania en Colombia.
const DEFAULT_DOCUMENT_TYPE_BY_EMAIL = "CC";

const normalizeCodeValue = (value) => cellToText(value).trim().toLowerCase();

// Igual que putPerson, pero indexando por una clave arbitraria (correo o
// codigo de usuario/estudiante, no por identificacion): se usa para resolver
// filas de plantillas donde "No de documento"/"Tipo de documento" llegan
// vacios y solo se tiene el correo y/o el codigo del usuario (ej. exportes de
// la plataforma Bookeau).
const putPersonByKey = (map, key, payload, priority, dependencyByCode = new Map()) => {
  const normalizedKey = normalizeCodeValue(key);
  const identification = normalizeId(payload.identification);
  const name = getPersonName(payload);
  if (!normalizedKey || !identification || !name) return;

  const current = map.get(normalizedKey);
  if (!current || priority > current.priority) {
    const personType = payload.personType || "";
    map.set(normalizedKey, {
      identification,
      name,
      personType,
      programaDependencia:
        personType === "student"
          ? getPersonProgram(payload)
          : getFuncionarioContext(payload, dependencyByCode),
      priority,
    });
  }
};

// Trae UNA sola vez los datos de estudiantes y funcionarios (bases locales +
// API en vivo de SIGA) y arma dos indices — por correo y por codigo de
// usuario/estudiante — para resolver filas cuyo numero de documento llego
// vacio. Cubre ambas poblaciones (estudiantes Y funcionarios) siempre, sin
// importar el "Tipo de usuario" de la fila.
const buildUnresolvedPeopleIndex = async (emails, codes) => {
  const rawEmails = [...new Set(emails.map((value) => cellToText(value).trim()).filter(Boolean))];
  const rawCodes = [...new Set(codes.map((value) => cellToText(value).trim()).filter(Boolean))];

  const byEmail = new Map();
  const byCode = new Map();
  if (rawEmails.length === 0 && rawCodes.length === 0) return { byEmail, byCode };

  const [studentsDbByEmail, usersDbByEmail, usersApi, studentsApi] = await Promise.all([
    rawEmails.length ? Student.find({ email: { $in: rawEmails } }).lean() : [],
    rawEmails.length ? User.find({ email: { $in: rawEmails } }).lean() : [],
    safeGetEndpoint(process.env.USERS_ENDPOINT, 15000),
    safeGetEndpoint(process.env.STUDENTS_ENDPOINT, 20000),
  ]);
  const dependencyByCode = await buildDependencyByCode();

  studentsDbByEmail.forEach((student) => putPersonByKey(byEmail, student.email, { ...student, personType: "student" }, 40, dependencyByCode));
  usersDbByEmail.forEach((user) => putPersonByKey(byEmail, user.email, { ...user, personType: "funcionario" }, 30, dependencyByCode));

  studentsApi.forEach((student) => {
    putPersonByKey(byEmail, student.email, { ...student, personType: "student" }, 35, dependencyByCode);
    putPersonByKey(byCode, student.code_student, { ...student, personType: "student" }, 35, dependencyByCode);
  });
  usersApi.forEach((user) => {
    putPersonByKey(byEmail, user.email, { ...user, personType: "funcionario" }, 25, dependencyByCode);
    putPersonByKey(byCode, user.code_user, { ...user, personType: "funcionario" }, 25, dependencyByCode);
  });

  return { byEmail, byCode };
};

const getFieldKind = (fieldName) => {
  const normalized = normalizeHeader(fieldName);
  // "Tipo de documento" no se usa para localizar a la persona (eso lo hace la
  // columna de No de documento / identificación); se detecta aparte solo para
  // poder rellenarla cuando se resuelve la persona por correo (ver
  // buildPeopleMapByEmail / resolveRowIdentification).
  if (normalized.includes("TIPO_DOCUMENTO") || normalized.includes("TIPO_DE_DOCUMENTO")) return "documentTypeOutput";
  if (normalized.includes("CORREO") || normalized === "EMAIL" || normalized.includes("E_MAIL")) return "email";
  // Respaldo cuando el correo de la plantilla no coincide con el correo
  // "oficial" de SIGA (ej. alias con nombre.apellido en vez del correo con
  // codigo): el codigo de usuario/estudiante permite resolver igual.
  if (normalized.includes("CODIGO") && normalized.includes("USUARIO")) return "userCode";
  if (ID_ALIASES.has(normalized)) return "identification";
  if (normalized.includes("IDENTIFICACION") || normalized.includes("CEDULA") || normalized.includes("DOCUMENTO")) {
    return "identification";
  }
  // abreviaciones tipo NUM_DOC, NRO_DOC, NO_DOC no capturadas arriba
  if (/^(NUM|NUMERO|NRO|NO|N)_?DOC$/.test(normalized)) return "identification";
  if (normalized.includes("TIPO") && normalized.includes("APOYO")) return "supportType";
  if (normalized.includes("NOMBRE") && normalized.includes("APOYO")) return "supportName";
  if (normalized.includes("DESCRIPCION") && normalized.includes("APOYO")) return "supportDescription";
  if (normalized.includes("VALOR") && normalized.includes("APOYO")) return "supportValue";
  if (
    ["NOMBRE", "NOMBRE_COMPLETO", "NOMBRES_Y_APELLIDOS", "APELLIDOS_Y_NOMBRES", "NOMBRE_BENEFICIARIO"].includes(normalized)
  ) {
    return "personName";
  }
  return null;
};

const findHeaderByKind = (headers, kind) => headers.find((header) => getFieldKind(header.name) === kind) || null;

const getRecordValue = (record, header) => {
  if (!header) return "";
  return cellToText(record.valuesByColumn[header.column] || "").trim();
};

const getPeriodLabel = (period) => {
  if (!period) return "";
  if (typeof period === "string") return period;
  return period.name || period.descripcion || String(period._id || "");
};

const getPeriodTime = (period) => {
  const raw = period?.start_date || period?.createdAt || period?.updatedAt || "";
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
};

const compactUnique = (values) => [...new Set(values.map((value) => cellToText(value).trim()).filter(Boolean))];

const outputText = (value, fallback = EMPTY_OUTPUT_VALUE) => {
  const text = cellToText(value).trim();
  return text || fallback;
};

const buildSupportHistory = async (periodId) => {
  const query = {
    "loaded_data.filled_data.field_name": { $regex: "apoyo|documento|cedula|identificaci", $options: "i" },
  };
  if (periodId) query.period = { $ne: periodId };

  const templates = await PublishedTemplate.find(query)
    .select("name period loaded_data createdAt")
    .populate("period", "name start_date end_date")
    .lean();

  const history = new Map();

  templates.forEach((template) => {
    (template.loaded_data || []).forEach((loadedData) => {
      const columns = {
        identification: [],
        supportType: [],
        supportName: [],
        supportDescription: [],
        supportValue: [],
      };

      (loadedData.filled_data || []).forEach((fieldData) => {
        const kind = getFieldKind(fieldData.field_name);
        if (columns[kind]) {
          columns[kind].push(fieldData);
        }
      });

      const maxLength = Math.max(
        0,
        ...Object.values(columns).flat().map((fieldData) => (Array.isArray(fieldData.values) ? fieldData.values.length : 0))
      );

      for (let index = 0; index < maxLength; index += 1) {
        const identification = normalizeId(firstValue(columns.identification.map((col) => col.values?.[index])));
        if (!identification) continue;

        const item = {
          templateName: template.name || "",
          period: getPeriodLabel(template.period),
          periodTime: getPeriodTime(template.period) || getPeriodTime(template),
          dependency: loadedData.dependency || "",
          supportType: firstValue(columns.supportType.map((col) => col.values?.[index])),
          supportName: firstValue(columns.supportName.map((col) => col.values?.[index])),
          supportDescription: firstValue(columns.supportDescription.map((col) => col.values?.[index])),
          supportValue: firstValue(columns.supportValue.map((col) => col.values?.[index])),
        };

        const hasSupportInfo = item.supportType || item.supportName || item.supportDescription || item.supportValue;
        if (!hasSupportInfo) continue;

        if (!history.has(identification)) history.set(identification, []);
        history.get(identification).push(item);
      }
    });
  });

  history.forEach((items) => {
    items.sort((a, b) => b.periodTime - a.periodTime || a.templateName.localeCompare(b.templateName));
  });

  return history;
};

// Algunas plantillas (ej. exportes de Bookeau) traen una fila de titulo antes
// de los encabezados reales ("REPETIDOS PRESTAMOS PLATAFORMA BOOKEAU" en la
// fila 1, encabezados de columna en la fila 2). Buscar siempre en la fila 1
// hacia que esas hojas nunca detectaran ninguna columna (todo quedaba SIN
// identificar). Se busca entre las primeras filas la que tenga mas celdas no
// vacias: una fila de titulo tipicamente solo tiene 1 celda con contenido,
// mientras que la fila de encabezados tiene una por cada columna.
const HEADER_SCAN_MAX_ROW = 10;

const findHeaderRowNumber = (worksheet) => {
  let bestRow = 1;
  let bestCount = -1;
  const maxRow = Math.min(worksheet.rowCount, HEADER_SCAN_MAX_ROW);

  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    let count = 0;
    worksheet.getRow(rowNumber).eachCell({ includeEmpty: false }, (cell) => {
      if (cellToText(cell.value).trim()) count += 1;
    });
    if (count > bestCount) {
      bestCount = count;
      bestRow = rowNumber;
    }
  }

  return bestRow;
};

const parseWorksheet = (worksheet) => {
  try {
    const headerRowNumber = findHeaderRowNumber(worksheet);
    const headerRow = worksheet.getRow(headerRowNumber);
    const headers = [];
    headerRow.eachCell({ includeEmpty: false }, (cell, column) => {
      const name = cellToText(cell.value).trim();
      if (name) headers.push({ column, name, normalized: normalizeHeader(name) });
    });

    if (headers.length === 0) {
      console.warn(`[supportTemplates] Hoja "${worksheet.name}": sin encabezados (fila ${headerRowNumber}), se omite.`);
      return null;
    }
    if (headerRowNumber > 1) {
      console.log(`[supportTemplates] Hoja "${worksheet.name}": encabezados detectados en fila ${headerRowNumber} (no en la fila 1).`);
    }

    // Intentar detectar columna de identificación (no obligatorio)
    let idHeader = findHeaderByKind(headers, "identification");

    if (!idHeader) {
      // Fallback: columna cuyos primeros valores sean cédulas numéricas (5-12 dígitos)
      idHeader = headers.find((h) => {
        const samples = [];
        for (let r = headerRowNumber + 1; r <= Math.min(worksheet.rowCount, headerRowNumber + 19); r++) {
          const v = cellToText(worksheet.getRow(r).getCell(h.column).value).trim();
          if (v) samples.push(v);
        }
        const numeric = samples.filter((v) => /^\d{5,12}$/.test(v)).length;
        return samples.length >= 3 && numeric / samples.length >= 0.7;
      }) || null;
    }

    if (idHeader) {
      console.log(`[supportTemplates] Hoja "${worksheet.name}": columna ID = "${idHeader.name}"`);
    } else {
      console.warn(`[supportTemplates] Hoja "${worksheet.name}": sin columna de ID detectada, se procesa sin identificación. Encabezados: ${headers.map(h => `${h.name}(${h.normalized})`).join(", ")}`);
    }

    const fieldMap = {
      identification: idHeader,   // puede ser null — las filas quedarán como SIN_CEDULA
      personName: findHeaderByKind(headers, "personName"),
      supportType: findHeaderByKind(headers, "supportType"),
      supportName: findHeaderByKind(headers, "supportName"),
      supportDescription: findHeaderByKind(headers, "supportDescription"),
      supportValue: findHeaderByKind(headers, "supportValue"),
      // Para hojas donde "No de documento"/"Tipo de documento" llegan vacías
      // (ej. exportes de Bookeau): se resuelven buscando a la persona por
      // correo o por código de usuario/estudiante (ver resolveRowIdentification
      // en buildEnrichedRows).
      email: findHeaderByKind(headers, "email"),
      userCode: findHeaderByKind(headers, "userCode"),
      documentTypeOutput: findHeaderByKind(headers, "documentTypeOutput"),
    };

    const rows = [];
    for (let rowNumber = headerRowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const excelRow = worksheet.getRow(rowNumber);
      const valuesByColumn = {};
      let hasValue = false;
      headers.forEach((header) => {
        const value = excelRow.getCell(header.column).value;
        valuesByColumn[header.column] = value;
        if (!isBlank(value)) hasValue = true;
      });
      if (!hasValue) continue;
      rows.push({ rowNumber, valuesByColumn });
    }

    if (rows.length === 0) {
      console.warn(`[supportTemplates] Hoja "${worksheet.name}": sin filas de datos, se omite.`);
      return null;
    }

    return { worksheet, headers, fieldMap, rows };
  } catch (e) {
    console.warn(`[supportTemplates] Error parseando hoja "${worksheet.name}": ${e.message}`);
    return null;
  }
};

const readUploadedWorkbook = async (file) => {
  if (!file) {
    const error = new Error("Debes subir una plantilla en formato .xlsx o .xlsm.");
    error.status = 400;
    throw error;
  }

  const extension = path.extname(file.originalname || "").toLowerCase();
  if (![".xlsx", ".xlsm"].includes(extension)) {
    const error = new Error("La plantilla debe estar en formato .xlsx o .xlsm.");
    error.status = 400;
    throw error;
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file.path);

  console.log(`[supportTemplates] Hojas en workbook (${workbook.worksheets.length}): ${workbook.worksheets.map(ws => `"${ws.name}" rowCount=${ws.rowCount}`).join(" | ")}`);

  if (workbook.worksheets.length === 0) {
    const error = new Error("La plantilla no contiene hojas para procesar.");
    error.status = 400;
    throw error;
  }

  const sheets = workbook.worksheets.map(parseWorksheet).filter(Boolean);
  console.log(`[supportTemplates] Hojas procesables: ${sheets.length} — ${sheets.map(s => s.worksheet.name).join(", ")}`);

  if (sheets.length === 0) {
    const error = new Error("Ninguna hoja tiene datos para procesar.");
    error.status = 400;
    throw error;
  }

  return { workbook, sheets };
};

const buildValidatorColumns = async (headers, rows, periodId = null) => {
  const validators = await buildValidatorLookup(periodId);
  if (validators.length === 0) return [];

  const usedOutputNames = new Set(GENERATED_COLUMNS.map(normalizeHeader));
  const columns = [];

  headers.forEach((header) => {
    const sampleValues = compactUnique(
      rows
        .map((row) => row.valuesByColumn[header.column])
        .filter((value) => !isBlank(value))
    ).slice(0, 50);

    if (!isValidatorCandidateHeader(header, sampleValues)) return;

    const validator = findValidatorForHeader(header, validators, sampleValues);
    if (!validator) return;

    const matchedCount = sampleValues.filter((value) => validator.valueMap.has(normalizeLookupValue(value))).length;
    if (matchedCount === 0) return;

    let outputColumn = `DESC_${normalizeHeader(header.name)}`;
    const baseOutputLabel = `Descripcion de ${header.name}`;
    let outputLabel = baseOutputLabel;
    let suffix = 2;
    while (usedOutputNames.has(normalizeHeader(outputColumn))) {
      outputColumn = `DESC_${normalizeHeader(header.name)}_${suffix}`;
      outputLabel = `${baseOutputLabel} ${suffix}`;
      suffix += 1;
    }
    usedOutputNames.add(normalizeHeader(outputColumn));

    columns.push({
      sourceField: header.name,
      sourceColumn: header.column,
      outputColumn,
      outputLabel,
      validatorName: validator.name,
      validatorColumn: validator.idColumnName,
      descriptionColumn: validator.descriptionColumnName,
      valueMap: validator.valueMap,
    });
  });

  return columns;
};

const buildEnrichedRows = async ({ rows, fieldMap, periodId, validatorColumns }) => {
  // Filas sin numero de documento pero con correo y/o codigo de usuario (ej.
  // exportes de la plataforma Bookeau, con "No de documento"/"Tipo de
  // documento" vacios): se resuelve la identificacion buscando a la persona
  // por correo (o, si el correo no coincide, por codigo de usuario/estudiante)
  // en SIGA (via API en vivo, estudiantes Y funcionarios) y en las bases
  // locales, ANTES de armar la lista de identificaciones — asi el resto del
  // cruce (personas, historial de apoyos) funciona igual que si el numero de
  // documento ya viniera en la plantilla. Las filas que ya traen numero de
  // documento no se tocan.
  const needsEmailResolution = Boolean(fieldMap.identification && (fieldMap.email || fieldMap.userCode));
  const blankIdRows = needsEmailResolution
    ? rows.filter((row) => !normalizeId(getRecordValue(row, fieldMap.identification)))
    : [];
  const emailsToResolve = blankIdRows.map((row) => getRecordValue(row, fieldMap.email)).filter(Boolean);
  const codesToResolve = blankIdRows.map((row) => getRecordValue(row, fieldMap.userCode)).filter(Boolean);
  const { byEmail: emailPeopleMap, byCode: codePeopleMap } = needsEmailResolution
    ? await buildUnresolvedPeopleIndex(emailsToResolve, codesToResolve)
    : { byEmail: new Map(), byCode: new Map() };

  const resolveRowIdentification = (row) => {
    const direct = normalizeId(getRecordValue(row, fieldMap.identification));
    if (direct) return { identification: direct, resolvedByEmail: false };
    if (!needsEmailResolution) return { identification: "", resolvedByEmail: false };

    const email = getRecordValue(row, fieldMap.email);
    const byEmailPerson = email ? emailPeopleMap.get(normalizeEmailValue(email)) : null;
    if (byEmailPerson) return { identification: byEmailPerson.identification, resolvedByEmail: true };

    const code = getRecordValue(row, fieldMap.userCode);
    const byCodePerson = code ? codePeopleMap.get(normalizeCodeValue(code)) : null;
    if (byCodePerson) return { identification: byCodePerson.identification, resolvedByEmail: true };

    return { identification: "", resolvedByEmail: false };
  };

  const identifications = rows.map((row) => resolveRowIdentification(row).identification).filter(Boolean);
  const [peopleMap, supportHistory] = await Promise.all([
    buildPeopleMap(identifications),
    buildSupportHistory(periodId),
  ]);

  let personsFound = 0;
  let withPreviousSupport = 0;
  let resolvedByEmailCount = 0;

  const enrichedRows = rows.map((row) => {
    const { identification, resolvedByEmail } = resolveRowIdentification(row);
    const person = identification ? peopleMap.get(identification) : null;
    const history = identification ? supportHistory.get(identification) || [] : [];

    const validatorDescriptions = {};
    (validatorColumns || []).forEach((validatorColumn) => {
      const rawValue = row.valuesByColumn[validatorColumn.sourceColumn];
      const key = normalizeLookupValue(rawValue);
      const description = validatorColumn.valueMap.get(key) || "";
      const rawText = cellToText(rawValue).trim();
      if (description) {
        validatorDescriptions[validatorColumn.outputColumn] = `${cellToText(rawValue).trim()} - ${description}`;
      } else if (rawText) {
        validatorDescriptions[validatorColumn.outputColumn] = `${rawText} - SIN DESCRIPCION`;
      } else {
        validatorDescriptions[validatorColumn.outputColumn] = EMPTY_OUTPUT_VALUE;
      }
    });

    if (person) personsFound += 1;
    if (history.length > 0) withPreviousSupport += 1;
    if (resolvedByEmail && identification) resolvedByEmailCount += 1;

    let status = "SIN_CEDULA";
    if (identification) {
      if (person && history.length > 0) status = "IDENTIFICADO_CON_HISTORIAL";
      else if (person) status = "IDENTIFICADO";
      else if (history.length > 0) status = "IDENTIFICADO_POR_HISTORIAL";
      else status = "NO_IDENTIFICADO";
    }

    return {
      row_number: row.rowNumber,
      identificacion: identification,
      // Solo true cuando el numero de documento se resolvio por correo
      // (celda de "No de documento" venia vacia): applyGeneratedColumns usa
      // esto para rellenar UNICAMENTE esas celdas vacias, sin tocar filas
      // que ya traian su propio numero de documento.
      resolved_by_email: Boolean(resolvedByEmail && identification),
      assigned_document_type: resolvedByEmail && identification ? DEFAULT_DOCUMENT_TYPE_BY_EMAIL : "",
      nombre_identificado: outputText(person?.name || getRecordValue(row, fieldMap.personName), "NO IDENTIFICADO"),
      programa_dependencia: outputText(person?.programaDependencia, "NO IDENTIFICADO"),
      apoyos_otros_periodos: outputText(compactUnique(history.map((item) => item.supportName || item.supportType)).join(" | "), "SIN HISTORIAL"),
      periodos_apoyo_previo: outputText(compactUnique(history.map((item) => item.period)).join(" | "), "SIN HISTORIAL"),
      plantillas_apoyo_previo: outputText(compactUnique(history.map((item) => item.templateName)).join(" | "), "SIN HISTORIAL"),
      estado_cruce: status,
      _history_count: history.length,
      validadores_resueltos: validatorDescriptions,
    };
  });

  const resolvedValidatorValues = enrichedRows.reduce(
    (count, row) =>
      count +
      Object.values(row.validadores_resueltos || {}).filter((value) => {
        const text = cellToText(value).trim();
        return text && text !== EMPTY_OUTPUT_VALUE && !text.endsWith("SIN DESCRIPCION");
      }).length,
    0
  );

  return {
    enrichedRows,
    summary: {
      totalRows: rows.length,
      withIdentification: identifications.length,
      personsFound,
      withPreviousSupport,
      resolvedByEmail: resolvedByEmailCount,
      withoutMatches: enrichedRows.filter((row) => row.estado_cruce === "NO_IDENTIFICADO").length,
      validatorColumns: (validatorColumns || []).length,
      resolvedValidatorValues,
    },
  };
};

const removeDeprecatedGeneratedColumns = (worksheet) => {
  const headerRow = worksheet.getRow(1);
  const deprecatedNames = new Set(DEPRECATED_GENERATED_COLUMNS.map(normalizeHeader));
  const columnsToRemove = [];

  headerRow.eachCell({ includeEmpty: false }, (cell, column) => {
    if (deprecatedNames.has(normalizeHeader(cellToText(cell.value)))) {
      columnsToRemove.push(column);
    }
  });

  columnsToRemove
    .sort((left, right) => right - left)
    .forEach((column) => worksheet.spliceColumns(column, 1));
};

const removeBlankRows = (worksheet) => {
  const lastColumn = Math.max(worksheet.columnCount, 1);

  for (let rowNumber = worksheet.rowCount; rowNumber >= 2; rowNumber -= 1) {
    const row = worksheet.getRow(rowNumber);
    let hasValue = false;

    for (let columnNumber = 1; columnNumber <= lastColumn; columnNumber += 1) {
      if (!isBlank(row.getCell(columnNumber).value)) {
        hasValue = true;
        break;
      }
    }

    if (!hasValue) worksheet.spliceRows(rowNumber, 1);
  }
};

const applyGeneratedColumns = (worksheet, enrichedRows, validatorColumns = [], fieldMap = null) => {
  // No se agregan columnas nuevas (ni "Nombre identificado" ni "Programa o
  // dependencia"): solo se limpian columnas de ese tipo si vienen de una
  // descarga previa de esta misma funcionalidad (compatibilidad hacia atras).
  removeDeprecatedGeneratedColumns(worksheet);

  // Los validadores siguen resolviendo su propia columna de origen (no crean
  // columnas nuevas: sobreescriben el codigo por su descripcion en el mismo sitio).
  validatorColumns.forEach((vc) => {
    const cell = worksheet.getRow(1).getCell(vc.sourceColumn);
    cell.font = OUTPUT_HEADER_FONT;
    cell.fill = OUTPUT_HEADER_FILL;
  });

  // Unicas columnas propias de la plantilla que se tocan: "No de documento"
  // (fieldMap.identification, la misma que ya se usa para buscar a la
  // persona) y, si existe, "Tipo de documento". Solo se escriben cuando
  // enriched.resolved_by_email es true — es decir, solo en las celdas que
  // llegaron vacias y se resolvieron por correo — el resto de la plantilla
  // no se toca.
  const identificationColumn = fieldMap?.identification?.column || null;
  const documentTypeColumn = fieldMap?.documentTypeOutput?.column || null;

  enrichedRows.forEach((enriched) => {
    const row = worksheet.getRow(enriched.row_number);
    // Overwrite validator source column with the resolved description
    validatorColumns.forEach((vc) => {
      const description = enriched.validadores_resueltos?.[vc.outputColumn];
      if (description != null)
        row.getCell(vc.sourceColumn).value = outputText(description);
    });
    if (enriched.resolved_by_email) {
      if (identificationColumn != null) row.getCell(identificationColumn).value = enriched.identificacion;
      if (documentTypeColumn != null && enriched.assigned_document_type)
        row.getCell(documentTypeColumn).value = enriched.assigned_document_type;
    }
    row.commit();
  });

  removeBlankRows(worksheet);

  validatorColumns.forEach((vc) => {
    worksheet.getColumn(vc.sourceColumn).width = Math.max(30, worksheet.getColumn(vc.sourceColumn).width || 0);
  });

  worksheet.getRow(1).commit();
};

const applyHeaderDropdownsFromNotes = (workbook, endRow = 1000) => {
  const sourcesSheetName = "_Listas";
  const sourcesSheet = workbook.getWorksheet(sourcesSheetName) || workbook.addWorksheet(sourcesSheetName);
  sourcesSheet.state = "veryHidden";

  let sourceCol = Math.max(1, sourcesSheet.columnCount + 1);

  workbook.worksheets.forEach((worksheet) => {
    if (worksheet.name === sourcesSheetName) return;

    const headerRow = worksheet.getRow(1);
    headerRow.eachCell({ includeEmpty: false }, (headerCell, columnNumber) => {
      const options = extractDropdownOptionsFromComment(noteToText(headerCell.note), { preserveLeadingCodes: true });
      if (options.length === 0) return;

      options.forEach((option, optionIndex) => {
        sourcesSheet.getCell(optionIndex + 1, sourceCol).value = option;
      });

      const colLetter = columnNumberToName(sourceCol);
      const rangeRef = `'${sourcesSheetName}'!$${colLetter}$1:$${colLetter}$${options.length}`;

      for (let rowNumber = 2; rowNumber <= endRow; rowNumber += 1) {
        const cell = worksheet.getCell(rowNumber, columnNumber);

        cell.dataValidation = {
          type: "list",
          allowBlank: true,
          formulae: [rangeRef],
          showErrorMessage: true,
          errorTitle: "Valor no valido",
          error: "Selecciona un valor de la lista desplegable.",
        };
      }

      sourceCol += 1;
    });
  });
};

const processFile = async (req) => {
  try {
    const periodId = req.body.period_id || req.body.periodId || null;
    const { workbook, sheets } = await readUploadedWorkbook(req.file);

    const processedSheets = [];
    for (const sheet of sheets) {
      const validatorColumns = await buildValidatorColumns(sheet.headers, sheet.rows, periodId);
      const result = await buildEnrichedRows({ rows: sheet.rows, fieldMap: sheet.fieldMap, periodId, validatorColumns });
      processedSheets.push({ ...sheet, ...result, validatorColumns });
    }

    return { workbook, sheets: processedSheets };
  } catch (error) {
    console.error('[supportTemplates] ERROR in processFile:', error.message, error.stack);
    throw error;
  }
};

const buildPreviewRows = (rows) =>
  rows.map((row) => ({
    row_number: row.row_number,
    identificacion: row.identificacion,
    nombre_identificado: row.nombre_identificado,
    programa_dependencia: row.programa_dependencia,
    validadores_resueltos: row.validadores_resueltos,
  }));

const cleanupFile = async (file) => {
  if (!file?.path) return;
  try {
    await fs.unlink(file.path);
  } catch (error) {
    // The temp file may have already been removed by the OS.
  }
};

controller.preview = async (req, res) => {
  try {
    const { sheets } = await processFile(req);
    res.json(sheets.map((sheet) => ({
      sheetName: sheet.worksheet.name,
      columnsAdded: sheet.validatorColumns.map((item) => item.outputLabel || item.outputColumn),
      validatorColumns: sheet.validatorColumns.map((item) => ({
        sourceField: item.sourceField,
        outputColumn: item.outputColumn,
        outputLabel: item.outputLabel || item.outputColumn,
        validatorName: item.validatorName,
        validatorColumn: item.validatorColumn,
        descriptionColumn: item.descriptionColumn,
      })),
      summary: sheet.summary,
      rows: buildPreviewRows(sheet.enrichedRows.slice(0, 100)),
    })));
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || "No fue posible procesar la plantilla." });
  } finally {
    await cleanupFile(req.file);
  }
};

controller.download = async (req, res) => {
  try {
    const { workbook, sheets } = await processFile(req);
    for (const sheet of sheets) {
      applyGeneratedColumns(sheet.worksheet, sheet.enrichedRows, sheet.validatorColumns, sheet.fieldMap);
    }
    applyHeaderDropdownsFromNotes(workbook);
    const buffer = await workbook.xlsx.writeBuffer();
    const originalName = path.basename(req.file.originalname || "plantilla.xlsx", path.extname(req.file.originalname || ""));
    const filename = `${originalName}_cruzada_siga_iceberg.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('[supportTemplates] ERROR in download:', error.message, error.stack);
    res.status(error.status || 500).json({ message: error.message || "No fue posible generar la plantilla enriquecida." });
  } finally {
    await cleanupFile(req.file);
  }
};

module.exports = controller;
