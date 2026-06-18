const fs = require("fs");
const os = require("os");
const path = require("path");
const ExcelJS = require("exceljs");
const PizZip = require("pizzip");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const SniesTemplate = require("../models/sniesTemplates");
const PublishedTemplate = require("../models/publishedTemplates");
const Dependency = require("../models/dependencies");
const Period = require("../models/periods");
const Student = require("../models/students");
const Validator = require("./validators");
const UserService = require("../services/users");
const {
  uploadFileToGoogleDrive,
  updateFileInGoogleDrive,
  deleteDriveFile,
  downloadDriveFileBuffer,
} = require("../config/googleDrive");
const { extractDropdownOptionsFromComment } = require("../helpers/dropdownOptions");

const axios = require("axios");

const controller = {};

const syncPublishedTemplateSnapshots = async (templateDocument) => {
  if (!templateDocument?._id) return;

  await PublishedTemplate.updateMany(
    { "template._id": templateDocument._id },
    {
      $set: {
        template: templateDocument.toObject ? templateDocument.toObject() : templateDocument,
      },
    }
  );
};

const normalizeArrayInput = (value) => {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
};

const normalizeBoolean = (value, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
};

const parseIdArray = (value) =>
  normalizeArrayInput(value)
    .flatMap((item) => {
      if (typeof item === "string" && item.trim().startsWith("[")) {
        try {
          return JSON.parse(item);
        } catch (error) {
          return [item];
        }
      }
      return [item];
    })
    .filter(Boolean);

const parseFieldsInput = (value) => {
  if (!value) return [];

  const rawFields = (() => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch (error) {
        return [];
      }
    }
    return [];
  })();

  return rawFields
    .map((field) => ({
      name: String(field?.name || "").trim(),
      worksheet_name: String(field?.worksheet_name || "").trim(),
      insert_after: String(field?.insert_after || "").trim(),
      datatype: String(field?.datatype || "").trim(),
      required: normalizeBoolean(field?.required, true),
      validate_with: String(field?.validate_with || "").trim(),
      comment: String(field?.comment || "").trim(),
      dropdown_options: Array.isArray(field?.dropdown_options) ? field.dropdown_options : [],
      excel_validation_options: Array.isArray(field?.excel_validation_options) ? field.excel_validation_options : [],
      validator_options: Array.isArray(field?.validator_options) ? field.validator_options : [],
      field_origin: String(field?.field_origin || "snies_extra").trim() === "snies_original"
        ? "snies_original"
        : "snies_extra",
      visible_for_producer: normalizeBoolean(field?.visible_for_producer, true),
      export_to_snies: normalizeBoolean(field?.export_to_snies, false),
      multiple: normalizeBoolean(field?.multiple, false),
    }))
    .filter((field) => field.name && field.datatype);
};

const parseFieldEquivalencesInput = (value) => {
  if (value === undefined) return undefined;
  if (value === null || value === "") return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (error) {
      return {};
    }
  }
  return value && typeof value === "object" ? value : {};
};

const getWorkbookSheetsFromTemplate = async (template) => {
  const templateBuffer = await downloadDriveFileBuffer(template.drive_file_id);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer);

  return workbook.worksheets.map((worksheet) => {
    const { headers } = extractWorksheetHeaders(worksheet);
    const configuredExtraFieldNames = new Set(
      (template.fields || [])
        .filter((field) => field?.field_origin !== "snies_original" && field?.worksheet_name === worksheet.name)
        .map((field) => normalizeFieldName(field.name))
        .filter(Boolean)
    );

    const originalHeaders = headers.filter(
      (header) => !configuredExtraFieldNames.has(normalizeFieldName(header))
    );
    const visualFields = originalHeaders.map((header) => ({
      name: header,
      field_origin: "snies_original",
      visible_for_producer: true,
      export_to_snies: true,
    }));

    const additionalFields = (template.fields || [])
      .filter((field) => field?.field_origin !== "snies_original" && field?.worksheet_name === worksheet.name)
      .map((field) => ({
        name: field.name || "",
        insert_after: field.insert_after || "",
        field_origin: "snies_extra",
        visible_for_producer: field.visible_for_producer ?? true,
        export_to_snies: field.export_to_snies ?? false,
      }));

    additionalFields.forEach((field) => {
      const normalizedName = normalizeFieldName(field.name);
      if (!normalizedName) {
        return;
      }

      const currentIndex = visualFields.findIndex((item) => normalizeFieldName(item.name) === normalizedName);
      if (currentIndex >= 0) {
        visualFields.splice(currentIndex, 1);
      }

      const insertAfter = normalizeFieldName(field.insert_after);
      const insertAfterIndex = insertAfter
        ? visualFields.findIndex((item) => normalizeFieldName(item.name) === insertAfter)
        : -1;

      if (insertAfterIndex >= 0) {
        visualFields.splice(insertAfterIndex + 1, 0, field);
      } else {
        visualFields.push(field);
      }
    });

    return {
      worksheetName: worksheet.name,
      headers: originalHeaders,
      visual_fields: visualFields,
    };
  }).filter(
    (sheet) =>
      !isInfoWorksheet(sheet.worksheetName) &&
      normalizeComparableName(sheet.worksheetName) !== "GUIA_CAMPOS_SNIES" &&
      normalizeComparableName(sheet.worksheetName) !== "LISTAS"
  );
};

const normalizeFieldName = (fieldName = "") =>
  fieldName
    .toString()
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

const normalizeEquivalenceItems = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.miro_fields)) return value.miro_fields;
  if (Array.isArray(value.fields)) return value.fields;
  return [];
};

const getEquivalenceItemFieldName = (item) => {
  if (typeof item === "string") return item;
  if (!item || typeof item !== "object") return "";
  return item.field_name || item.fieldName || item.name || item.value || "";
};

const getEquivalenceItemValueMappings = (item) => {
  if (!item || typeof item !== "object" || typeof item === "string") return {};
  const rawMappings = item.value_mappings || item.valueMappings;
  if (!rawMappings || typeof rawMappings !== "object" || Array.isArray(rawMappings)) return {};

  return Object.entries(rawMappings).reduce((acc, [targetValue, sourceValue]) => {
    const cleanTargetValue = String(targetValue || "").trim();
    const cleanSourceValue = String(sourceValue || "").trim();
    if (cleanTargetValue && cleanSourceValue) {
      acc[cleanTargetValue] = cleanSourceValue;
    }
    return acc;
  }, {});
};

const hasUsableValue = (value) => value !== undefined && value !== null && value !== "";

const applyValueMappings = (value, valueMappings = {}) => {
  if (!hasUsableValue(value) || Object.keys(valueMappings).length === 0) return value;

  const normalizedValue = normalizeFieldName(String(value).trim());
  const matchingMapping = Object.entries(valueMappings).find(
    ([targetValue, sourceValue]) =>
      normalizeFieldName(sourceValue) === normalizedValue ||
      normalizeFieldName(targetValue) === normalizedValue
  );

  return matchingMapping ? matchingMapping[0] : value;
};

const buildFieldEquivalenceLookup = (fieldEquivalences = {}) => {
  const lookup = new Map();

  Object.entries(fieldEquivalences || {}).forEach(([rawKey, rawValue]) => {
    const equivalence = rawValue && typeof rawValue === "object" ? rawValue : {};
    const worksheetName = equivalence.worksheet_name || equivalence.worksheetName || "";
    const fieldName = equivalence.field_name || equivalence.fieldName || rawKey;
    const normalizedFieldName = normalizeFieldName(fieldName);
    const normalizedWorksheetName = normalizeFieldName(worksheetName);
    const miroFieldMappings = normalizeEquivalenceItems(rawValue)
      .map((item) => ({
        fieldName: normalizeFieldName(getEquivalenceItemFieldName(item)),
        valueMappings: getEquivalenceItemValueMappings(item),
      }))
      .filter((item) => item.fieldName);

    if (!normalizedFieldName || miroFieldMappings.length === 0) {
      return;
    }

    const keys = normalizedWorksheetName
      ? [`${normalizedWorksheetName}::${normalizedFieldName}`]
      : [normalizedFieldName];

    keys.push(normalizedFieldName);

    keys.forEach((key) => {
      const current = lookup.get(key) || [];
      lookup.set(key, [...current, ...miroFieldMappings]);
    });
  });

  return lookup;
};

const getEquivalentFieldMappings = (lookup, worksheetName, fieldName) => {
  const normalizedWorksheetName = normalizeFieldName(worksheetName);
  const normalizedFieldName = normalizeFieldName(fieldName);
  if (!normalizedFieldName) return [];

  return [
    ...(lookup.get(`${normalizedWorksheetName}::${normalizedFieldName}`) || []),
    ...(lookup.get(normalizedFieldName) || []),
  ];
};

const buildDownloadFileName = (template) => {
  const fileName = String(template?.file_name || "").trim();
  if (fileName) return fileName;

  const templateName = String(template?.name || "").trim();
  return templateName ? `${templateName}.xlsx` : "plantilla_snies.xlsx";
};

const sanitizeWorksheetName = (value, fallback = "Hoja") => {
  const cleaned = String(value || fallback)
    .replace(/[\\/*?:[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return (cleaned || fallback).slice(0, 31);
};

const resolveUniqueWorksheetName = (workbook, value, fallback = "Hoja") => {
  const baseName = sanitizeWorksheetName(value, fallback) || fallback;
  let candidate = baseName;
  let counter = 1;

  while (workbook.getWorksheet(candidate)) {
    const suffix = `_${counter}`;
    candidate = `${baseName.slice(0, 31 - suffix.length)}${suffix}`;
    counter += 1;
  }

  return candidate;
};

const buildComparisonFileName = (template) => {
  const templateName = String(template?.name || "comparativo_snies").trim() || "comparativo_snies";
  return `${templateName}_comparativo_campos.xlsx`;
};

const buildAllComparisonsFileName = () => {
  const dateTag = new Date().toISOString().slice(0, 10);
  return `snies_comparativo_campos_${dateTag}.xlsx`;
};

const MATCH_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFD9F2D9" },
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

const pickWorksheetRows = (rows = [], worksheetName = "", headers = []) => {
  const normalizedWorksheetName = normalizeComparableName(worksheetName);
  const rowsWithSheet = rows.filter((row) => row?.__SHEET_NAME);

  if (rowsWithSheet.length === 0) {
    return rows;
  }

  const exactSheetRows = rowsWithSheet.filter(
    (row) => normalizeComparableName(row.__SHEET_NAME) === normalizedWorksheetName
  );
  if (exactSheetRows.length > 0) {
    return exactSheetRows;
  }

  const partialSheetRows = rowsWithSheet.filter((row) => {
    const normalizedRowSheetName = normalizeComparableName(row.__SHEET_NAME);
    return normalizedRowSheetName.includes(normalizedWorksheetName) ||
      normalizedWorksheetName.includes(normalizedRowSheetName);
  });
  if (partialSheetRows.length > 0) {
    return partialSheetRows;
  }

  const normalizedHeaders = new Set(headers.map((header) => normalizeFieldName(header)).filter(Boolean));
  const groups = rowsWithSheet.reduce((acc, row) => {
    const key = normalizeComparableName(row.__SHEET_NAME);
    if (!key) return acc;
    if (!acc.has(key)) acc.set(key, []);
    acc.get(key).push(row);
    return acc;
  }, new Map());

  let bestRows = [];
  let bestScore = 0;

  groups.forEach((sheetRows) => {
    const rowKeys = new Set(getNormalizedRowKeys(sheetRows));
    const score = [...normalizedHeaders].filter((header) => rowKeys.has(header)).length;
    if (score > bestScore) {
      bestScore = score;
      bestRows = sheetRows;
    }
  });

  if (bestRows.length > 0 && bestScore > 0) {
    return bestRows;
  }

  const legacyRows = rows.filter((row) => !row?.__SHEET_NAME);
  return legacyRows.length > 0 ? legacyRows : rows;
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

const normalizeToken = (value = "") =>
  String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

const resolveValueByKey = (row, targetKey) => {
  if (Object.prototype.hasOwnProperty.call(row || {}, targetKey)) {
    return row[targetKey];
  }

  const normalizedTarget = normalizeToken(targetKey);
  const matchedKey = Object.keys(row || {}).find((key) => normalizeToken(key) === normalizedTarget);
  return matchedKey ? row[matchedKey] : undefined;
};

const toOptionText = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && value.$numberInt !== undefined) {
    return String(value.$numberInt ?? "").trim();
  }
  return String(value).trim();
};

const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const shouldUseValidatorCodeOnly = (...values) =>
  values.some((value) => {
    const normalized = normalizeFieldName(value);
    if (!normalized) return false;

    return (
      normalized === "ID" ||
      normalized === "TIPO" ||
      normalized === "CODIGO" ||
      normalized === "COD" ||
      normalized.startsWith("ID_") ||
      normalized.startsWith("TIPO_") ||
      normalized.startsWith("CODIGO_") ||
      normalized.startsWith("COD_") ||
      normalized.includes("_ID_") ||
      normalized.includes("_TIPO_") ||
      normalized.includes("_CODIGO_") ||
      normalized.includes("_COD_")
    );
  });

const extractInitialValidatorCode = (value, description = "") => {
  const text = toOptionText(value);
  if (!text) return "";

  const descText = toOptionText(description);
  if (descText) {
    const withoutDescription = text
      .replace(new RegExp(`\\s*${escapeRegExp(descText)}\\s*$`, "i"), "")
      .replace(/[\s.:;\-]+$/g, "")
      .trim();

    if (withoutDescription && withoutDescription !== text) {
      return withoutDescription;
    }
  }

  const codeMatch = /^([A-Z]{1,6}[A-Z0-9]*|\d+(?:[.,]\d+)*)(?:\s*[\.):;\-]\s*|\s+).+$/u.exec(text);
  if (!codeMatch) return text;

  return codeMatch[1].replace(/[.,]+$/g, "").trim();
};

const normalizeValidatorValueKey = (value) => normalizeFieldName(toOptionText(value));

const buildValidatorOptionLookup = (options = []) => {
  const lookup = new Map();

  options.forEach((option) => {
    const value = option?.value;
    const displayLabel = option?.displayLabel;
    const normalizedValue = normalizeValidatorValueKey(value);
    const normalizedDisplayLabel = normalizeValidatorValueKey(displayLabel);

    if (normalizedValue) lookup.set(normalizedValue, value);
    if (normalizedDisplayLabel) lookup.set(normalizedDisplayLabel, value);
  });

  return lookup;
};

const getWorksheetFieldLookupKey = (worksheetName, fieldName) =>
  `${normalizeFieldName(worksheetName)}::${normalizeFieldName(fieldName)}`;

const getValidatorOptions = (validator, preferredColumnName, fieldName = "") => {
  const options = [];
  const seen = new Set();

  (validator?.values || []).forEach((row) => {
    const keys = Object.keys(row || {});
    if (keys.length === 0) return;

    const preferredKey = preferredColumnName
      ? keys.find((key) => normalizeToken(key) === normalizeToken(preferredColumnName))
      : undefined;

    const idKey = preferredKey || keys[0];
    const idValue = resolveValueByKey(row, idKey);
    if (idValue === null || idValue === undefined) return;

    const descKey = keys.find((key) => {
      if (key === idKey) return false;
      const normalized = normalizeToken(key);
      return (
        normalized.includes("DESCRIPCION") ||
        normalized.includes("NOMBRE") ||
        normalized.startsWith("DESC")
      );
    });

    const idText = toOptionText(idValue);
    if (!idText) return;

    const descValue = descKey ? resolveValueByKey(row, descKey) : undefined;
    const descText = toOptionText(descValue);
    if (descKey && !descText) return;

    // In SNIES code/id/type columns, store only the initial code.
    const storedValue = shouldUseValidatorCodeOnly(fieldName, preferredColumnName, idKey, validator?.name)
      ? extractInitialValidatorCode(idText, descText)
      : idText;

    const seenKey = normalizeToken(storedValue);
    if (seen.has(seenKey)) return;

    const displayLabel = descText ? `${idText} ${descText}` : idText;
    seen.add(seenKey);
    options.push({ value: storedValue, displayLabel });
  });

  return options;
};

const buildSniesValidatorNormalizationLookup = async (fields = [], periodId = null) => {
  const fieldsWithValidator = fields.filter(
    (field) => field?.worksheet_name && field?.name && field?.validate_with && !field?.multiple
  );

  const lookup = {
    byWorksheet: new Map(),
    byFieldName: new Map(),
  };

  if (fieldsWithValidator.length === 0) {
    return lookup;
  }

  const validatorResults = await Promise.all(
    fieldsWithValidator.map(async (field) => ({
      field,
      validator: await Validator.giveValidatorToExcel(field.validate_with, periodId),
    }))
  );

  validatorResults.forEach(({ field, validator }) => {
    if (!validator) return;

    const validateWithParts = String(field.validate_with || "").split(" - ");
    const validatorColumnName = validateWithParts.slice(1).join(" - ").trim();
    const options = getValidatorOptions(validator, validatorColumnName, field.name);
    if (options.length === 0) return;

    const normalizedFieldName = normalizeFieldName(field.name);
    const normalizer = {
      field,
      optionLookup: buildValidatorOptionLookup(options),
      codeOnly: shouldUseValidatorCodeOnly(field.name, validatorColumnName, validator?.name),
    };

    lookup.byWorksheet.set(getWorksheetFieldLookupKey(field.worksheet_name, field.name), normalizer);
    if (!lookup.byFieldName.has(normalizedFieldName)) {
      lookup.byFieldName.set(normalizedFieldName, normalizer);
    }
  });

  return lookup;
};

const getSniesValidatorNormalizer = (lookup, worksheetName, fieldName) =>
  lookup.byWorksheet.get(getWorksheetFieldLookupKey(worksheetName, fieldName)) ||
  lookup.byFieldName.get(normalizeFieldName(fieldName));

const normalizeSniesValidatorOutputValue = (value, normalizer) => {
  if (!normalizer) return value;

  const text = toOptionText(value);
  if (!text) return value;

  const directMatch = normalizer.optionLookup.get(normalizeValidatorValueKey(text));
  if (directMatch !== undefined) return directMatch;

  if (!normalizer.codeOnly) return value;

  const extractedCode = extractInitialValidatorCode(text);
  const codeMatch = normalizer.optionLookup.get(normalizeValidatorValueKey(extractedCode));
  return codeMatch !== undefined ? codeMatch : extractedCode;
};

const columnNameToNumber = (columnName = "") => {
  return String(columnName)
    .toUpperCase()
    .split("")
    .reduce((total, char) => {
      if (char < "A" || char > "Z") {
        return total;
      }

      return total * 26 + (char.charCodeAt(0) - 64);
    }, 0);
};

const parseCellReference = (cellRef = "") => {
  const match = String(cellRef).match(/^([A-Z]+)(\d+)$/i);
  if (!match) {
    return null;
  }

  return {
    columnName: match[1].toUpperCase(),
    columnNumber: columnNameToNumber(match[1]),
    rowNumber: Number(match[2]),
  };
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

const buildCellNode = (doc, cellRef, value, styleId = null) => {
  const cellNode = doc.createElement("c");
  cellNode.setAttribute("r", cellRef);

  if (styleId !== null && styleId !== undefined && styleId !== "") {
    cellNode.setAttribute("s", String(styleId));
  }

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

const getRelationshipTargetPath = (baseFilePath, target = "") => {
  const normalizedTarget = String(target || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalizedTarget) {
    return null;
  }

  if (normalizedTarget.startsWith("xl/")) {
    return normalizedTarget;
  }

  const baseDir = path.posix.dirname(baseFilePath);
  return path.posix.normalize(path.posix.join(baseDir, normalizedTarget));
};

const getWorksheetCommentsFileMap = (zip, worksheetPathMap) => {
  const parser = new DOMParser();
  const commentsBySheet = new Map();

  Object.entries(worksheetPathMap).forEach(([worksheetName, worksheetPath]) => {
    const relsPath = `${path.posix.dirname(worksheetPath)}/_rels/${path.posix.basename(worksheetPath)}.rels`;
    const relsFile = zip.file(relsPath);

    if (!relsFile) {
      commentsBySheet.set(worksheetName, new Map());
      return;
    }

    const relsDoc = parser.parseFromString(relsFile.asText(), "application/xml");
    const relationships = Array.from(relsDoc.getElementsByTagName("Relationship"));
    const commentsRelationship = relationships.find((relationship) =>
      String(relationship.getAttribute("Type") || "").includes("/comments")
    );

    if (!commentsRelationship) {
      commentsBySheet.set(worksheetName, new Map());
      return;
    }

    const commentsPath = getRelationshipTargetPath(worksheetPath, commentsRelationship.getAttribute("Target"));
    const commentsFile = commentsPath ? zip.file(commentsPath) : null;

    if (!commentsFile) {
      commentsBySheet.set(worksheetName, new Map());
      return;
    }

    const commentsDoc = parser.parseFromString(commentsFile.asText(), "application/xml");
    const sheetComments = new Map();

    Array.from(commentsDoc.getElementsByTagName("comment")).forEach((commentNode) => {
      const ref = commentNode.getAttribute("ref");
      const textValue = Array.from(commentNode.getElementsByTagName("t"))
        .map((textNode) => textNode.textContent || "")
        .join("")
        .trim();

      if (ref && textValue) {
        sheetComments.set(ref, textValue);
      }
    });

    commentsBySheet.set(worksheetName, sheetComments);
  });

  return commentsBySheet;
};

const getOriginalHeaderCommentsBySheet = (templateBuffer, workbook) => {
  const zip = new PizZip(templateBuffer);
  const worksheetPathMap = getWorksheetXmlPathMap(zip);
  const worksheetCommentsMap = getWorksheetCommentsFileMap(zip, worksheetPathMap);
  const originalCommentsBySheet = new Map();

  workbook.worksheets.forEach((worksheet) => {
    const { headerRowNumber, headers, headerColumns } = extractWorksheetHeaders(worksheet);
    const commentsByRef = worksheetCommentsMap.get(worksheet.name) || new Map();
    const commentsByField = new Map();

    commentsByRef.forEach((commentText, cellRef) => {
      const parsedRef = parseCellReference(cellRef);
      if (!parsedRef || parsedRef.rowNumber !== headerRowNumber) {
        return;
      }

      const headerIndex = headerColumns.findIndex((columnNumber) => columnNumber === parsedRef.columnNumber);
      const headerName = headerIndex >= 0 ? headers[headerIndex] : "";
      const normalizedHeaderName = normalizeFieldName(headerName);

      if (normalizedHeaderName && commentText) {
        commentsByField.set(normalizedHeaderName, commentText);
      }
    });

    originalCommentsBySheet.set(worksheet.name, commentsByField);
  });

  return originalCommentsBySheet;
};

const buildWorksheetHeaderCommentsPlan = (workbook, configuredFields, originalCommentsBySheet) => {
  const configuredCommentsBySheet = new Map();

  configuredFields
    .filter((field) => field?.name && field?.worksheet_name)
    .forEach((field) => {
      const sheetName = String(field.worksheet_name || "").trim();
      const normalizedFieldName = normalizeFieldName(field.name);

      if (!configuredCommentsBySheet.has(sheetName)) {
        configuredCommentsBySheet.set(sheetName, new Map());
      }

      configuredCommentsBySheet.get(sheetName).set(normalizedFieldName, String(field.comment || "").trim());
    });

  return workbook.worksheets.reduce((acc, worksheet) => {
    if (isInfoWorksheet(worksheet.name) || isGuideWorksheet(worksheet.name)) {
      return acc;
    }

    const { headerRowNumber, headers, headerColumns } = extractWorksheetHeaders(worksheet);
    const originalComments = originalCommentsBySheet.get(worksheet.name) || new Map();
    const configuredComments = configuredCommentsBySheet.get(worksheet.name) || new Map();

    const comments = headers.reduce((sheetComments, headerName, index) => {
      const normalizedHeaderName = normalizeFieldName(headerName);
      const configuredComment = configuredComments.get(normalizedHeaderName);
      const originalComment = originalComments.get(normalizedHeaderName);
      const commentText = configuredComment || originalComment || "";

      if (!commentText) {
        return sheetComments;
      }

      const columnNumber = headerColumns[index] || index + 1;
      sheetComments.push({
        ref: `${columnNumberToName(columnNumber)}${headerRowNumber}`,
        text: commentText,
        columnNumber,
        rowNumber: headerRowNumber,
      });

      return sheetComments;
    }, []);

    if (comments.length > 0) {
      acc.set(worksheet.name, comments);
    }

    return acc;
  }, new Map());
};

const applyHeaderHelpPromptsToWorkbook = (workbook, commentsPlan, endRow = 1000) => {
  if (!commentsPlan || commentsPlan.size === 0) {
    return;
  }

  commentsPlan.forEach((comments, worksheetName) => {
    const worksheet = workbook.getWorksheet(worksheetName);
    if (!worksheet || !Array.isArray(comments) || comments.length === 0) {
      return;
    }

    comments.forEach((comment) => {
      const promptText = String(comment.text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
      if (!promptText) {
        return;
      }

      const promptTitle = worksheet.getCell(comment.ref).value
        ? String(worksheet.getCell(comment.ref).value).slice(0, 32)
        : "Ayuda";

      for (let row = comment.rowNumber + 1; row <= endRow; row += 1) {
        const cell = worksheet.getCell(row, comment.columnNumber);
        const baseValidation = cell.dataValidation && Object.keys(cell.dataValidation).length > 0
          ? { ...cell.dataValidation }
          : {
              type: "custom",
              allowBlank: true,
              formulae: ["TRUE"],
              showErrorMessage: false,
            };

        cell.dataValidation = {
          ...baseValidation,
          showInputMessage: true,
          promptTitle,
          prompt: promptText.length > 255 ? `${promptText.slice(0, 252)}...` : promptText,
        };
      }
    });
  });
};

const applyHeaderDropdownsFromComments = (workbook, commentsPlan, endRow = 1000) => {
  if (!commentsPlan || commentsPlan.size === 0) {
    return;
  }

  const sourcesSheetName = "_Listas";
  const existingSourcesSheet = workbook.getWorksheet(sourcesSheetName);
  const sourcesSheet = existingSourcesSheet ?? workbook.addWorksheet(sourcesSheetName);
  sourcesSheet.state = "veryHidden";

  let sourceCol = Math.max(1, sourcesSheet.columnCount + 1);

  commentsPlan.forEach((comments, worksheetName) => {
    const worksheet = workbook.getWorksheet(worksheetName);
    if (!worksheet || !Array.isArray(comments) || comments.length === 0) {
      return;
    }

    comments.forEach((comment) => {
      const options = extractDropdownOptionsFromComment(comment.text, { preserveLeadingCodes: true });
      if (options.length === 0) {
        return;
      }

      options.forEach((option, optionIndex) => {
        sourcesSheet.getCell(optionIndex + 1, sourceCol).value = option;
      });

      const colLetter = columnNumberToName(sourceCol);
      const rangeRef = `'${sourcesSheetName}'!$${colLetter}$1:$${colLetter}$${options.length}`;

      for (let row = comment.rowNumber + 1; row <= endRow; row += 1) {
        const cell = worksheet.getCell(row, comment.columnNumber);

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

const buildCommentsXml = (comments = []) => {
  const doc = new DOMParser().parseFromString(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author/></authors><commentList/></comments>',
    "application/xml"
  );

  const commentListNode = doc.getElementsByTagName("commentList")[0];
  comments.forEach((comment) => {
    const commentNode = doc.createElement("comment");
    commentNode.setAttribute("ref", comment.ref);
    commentNode.setAttribute("authorId", "0");

    const textNode = doc.createElement("text");
    const runNode = doc.createElement("t");
    runNode.appendChild(doc.createTextNode(String(comment.text || "")));
    textNode.appendChild(runNode);
    commentNode.appendChild(textNode);
    commentListNode.appendChild(commentNode);
  });

  return new XMLSerializer().serializeToString(doc);
};

const buildVmlCommentsXml = (comments = []) => {
  const shapeNodes = comments
    .map((comment, index) => {
      const startColumn = Math.max(comment.columnNumber - 1, 0);
      const startRow = Math.max(comment.rowNumber - 1, 0);
      const endColumn = startColumn + 5;
      const endRow = startRow + 20;

      return `<v:shape id="_x0000_s${1025 + index}" type="#_x0000_t202" style="position:absolute;visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"/><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${startColumn}, 0, ${startRow}, 0, ${endColumn}, 0, ${endRow}, 0</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${startRow}</x:Row><x:Column>${startColumn}</x:Column></x:ClientData></v:shape>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<xml xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:x="urn:schemas-microsoft-com:office:excel">` +
    `<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>` +
    `<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202.0" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>` +
    `${shapeNodes}</xml>`;
};

const ensureContentTypeEntry = (typesDoc, selector, createEntry) => {
  if (selector()) {
    return;
  }

  const typesNode = typesDoc.getElementsByTagName("Types")[0];
  if (typesNode) {
    typesNode.appendChild(createEntry(typesDoc));
  }
};

const upsertWorksheetComments = (zip, worksheetPath, comments, commentIndex) => {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const relsPath = `${path.posix.dirname(worksheetPath)}/_rels/${path.posix.basename(worksheetPath)}.rels`;
  const commentsPath = `xl/comments${commentIndex}.xml`;
  const vmlPath = `xl/drawings/vmlDrawing${commentIndex}.vml`;

  let relsDoc;
  let relationshipsNode;

  if (zip.file(relsPath)) {
    relsDoc = parser.parseFromString(zip.file(relsPath).asText(), "application/xml");
    relationshipsNode = relsDoc.getElementsByTagName("Relationships")[0];
  } else {
    relsDoc = parser.parseFromString(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
      "application/xml"
    );
    relationshipsNode = relsDoc.getElementsByTagName("Relationships")[0];
  }

  Array.from(relsDoc.getElementsByTagName("Relationship")).forEach((relationship) => {
    const type = String(relationship.getAttribute("Type") || "");
    const target = String(relationship.getAttribute("Target") || "");

    if (type.includes("/comments") || type.includes("/vmlDrawing")) {
      const targetPath = getRelationshipTargetPath(worksheetPath, target);
      if (targetPath) {
        zip.remove(targetPath);
      }

      relationship.parentNode?.removeChild(relationship);
    }
  });

  const commentsRelId = "rIdSniesComments";
  const vmlRelId = "rIdSniesVml";

  const commentsRel = relsDoc.createElement("Relationship");
  commentsRel.setAttribute("Id", commentsRelId);
  commentsRel.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments");
  commentsRel.setAttribute("Target", `../comments${commentIndex}.xml`);
  relationshipsNode.appendChild(commentsRel);

  const vmlRel = relsDoc.createElement("Relationship");
  vmlRel.setAttribute("Id", vmlRelId);
  vmlRel.setAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing");
  vmlRel.setAttribute("Target", `../drawings/vmlDrawing${commentIndex}.vml`);
  relationshipsNode.appendChild(vmlRel);

  zip.file(relsPath, serializer.serializeToString(relsDoc));

  const worksheetDoc = parser.parseFromString(zip.file(worksheetPath).asText(), "application/xml");
  Array.from(worksheetDoc.getElementsByTagName("legacyDrawing")).forEach((node) => {
    node.parentNode?.removeChild(node);
  });
  Array.from(worksheetDoc.getElementsByTagName("legacyDrawingHF")).forEach((node) => {
    node.parentNode?.removeChild(node);
  });

  const worksheetNode = worksheetDoc.getElementsByTagName("worksheet")[0];
  if (worksheetNode) {
    const legacyDrawingNode = worksheetDoc.createElement("legacyDrawing");
    legacyDrawingNode.setAttribute("r:id", vmlRelId);
    worksheetNode.appendChild(legacyDrawingNode);
  }

  zip.file(worksheetPath, serializer.serializeToString(worksheetDoc));
  zip.file(commentsPath, buildCommentsXml(comments));
  zip.file(vmlPath, buildVmlCommentsXml(comments));
};

const injectWorksheetCommentsIntoWorkbook = (buffer, commentsPlan) => {
  if (!commentsPlan || commentsPlan.size === 0) {
    return buffer;
  }

  const zip = new PizZip(buffer);
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const worksheetPathMap = getWorksheetXmlPathMap(zip);

  let commentIndex = 1;
  commentsPlan.forEach((comments, worksheetName) => {
    const worksheetPath = worksheetPathMap[worksheetName];
    if (!worksheetPath || !zip.file(worksheetPath) || !Array.isArray(comments) || comments.length === 0) {
      return;
    }

    upsertWorksheetComments(zip, worksheetPath, comments, commentIndex);
    commentIndex += 1;
  });

  const contentTypesFile = zip.file("[Content_Types].xml");
  if (contentTypesFile) {
    const typesDoc = parser.parseFromString(contentTypesFile.asText(), "application/xml");

    ensureContentTypeEntry(
      typesDoc,
      () =>
        Array.from(typesDoc.getElementsByTagName("Default")).some(
          (node) =>
            node.getAttribute("Extension") === "vml" &&
            node.getAttribute("ContentType") === "application/vnd.openxmlformats-officedocument.vmlDrawing"
        ),
      (doc) => {
        const node = doc.createElement("Default");
        node.setAttribute("Extension", "vml");
        node.setAttribute("ContentType", "application/vnd.openxmlformats-officedocument.vmlDrawing");
        return node;
      }
    );

    for (let index = 1; index < commentIndex; index += 1) {
      ensureContentTypeEntry(
        typesDoc,
        () =>
          Array.from(typesDoc.getElementsByTagName("Override")).some(
            (node) =>
              node.getAttribute("PartName") === `/xl/comments${index}.xml` &&
              node.getAttribute("ContentType") === "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"
          ),
        (doc) => {
          const node = doc.createElement("Override");
          node.setAttribute("PartName", `/xl/comments${index}.xml`);
          node.setAttribute(
            "ContentType",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"
          );
          return node;
        }
      );
    }

    zip.file("[Content_Types].xml", serializer.serializeToString(typesDoc));
  }

  return Buffer.from(
    zip.generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    })
  );
};

const rewriteWorksheetXml = (xmlContent, headers, rows, headerRowNumber, headerColumns = []) => {
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const doc = parser.parseFromString(xmlContent, "application/xml");
  const worksheetNode = doc.getElementsByTagName("worksheet")[0];
  const sheetDataNode = doc.getElementsByTagName("sheetData")[0];

  if (!worksheetNode || !sheetDataNode) {
    return xmlContent;
  }

  // Capture column styles from the first data row BEFORE removing it, so
  // new data rows inherit the original template's cell formatting.
  const columnStyleMap = {};
  const allDataRows = Array.from(sheetDataNode.getElementsByTagName("row"));
  const firstDataRow = allDataRows.find(
    (rowNode) => Number(rowNode.getAttribute("r")) === headerRowNumber + 1
  );
  if (firstDataRow) {
    Array.from(firstDataRow.getElementsByTagName("c")).forEach((cell) => {
      const ref = cell.getAttribute("r") || "";
      const colLetter = ref.replace(/[0-9]/g, "");
      const styleId = cell.getAttribute("s");
      if (colLetter && styleId !== null && styleId !== undefined && styleId !== "") {
        columnStyleMap[colLetter] = styleId;
      }
    });
  }

  allDataRows
    .filter((rowNode) => Number(rowNode.getAttribute("r")) > headerRowNumber)
    .forEach((rowNode) => {
      sheetDataNode.removeChild(rowNode);
    });

  rows.forEach((row, rowIndex) => {
    const excelRowNumber = headerRowNumber + 1 + rowIndex;
    const rowNode = doc.createElement("row");
    rowNode.setAttribute("r", String(excelRowNumber));

    headers.forEach((header, headerIndex) => {
      const columnNumber = headerColumns[headerIndex] || headerIndex + 1;
      const colLetter = columnNumberToName(columnNumber);
      const cellRef = `${colLetter}${excelRowNumber}`;
      const styleId = columnStyleMap[colLetter] ?? null;
      const cellNode = buildCellNode(doc, cellRef, sanitizeExcelValue(row[header]), styleId);
      rowNode.appendChild(cellNode);
    });

    sheetDataNode.appendChild(rowNode);
  });

  const dimensionNode = doc.getElementsByTagName("dimension")[0];
  if (dimensionNode && headers.length > 0) {
    const lastColumnNumber = Math.max(...headerColumns.filter(Boolean), headers.length);
    const lastColumn = columnNumberToName(lastColumnNumber);
    const lastRow = Math.max(headerRowNumber + rows.length, headerRowNumber);
    dimensionNode.setAttribute("ref", `A1:${lastColumn}${lastRow}`);
  }

  return serializer.serializeToString(doc);
};

const sanitizeWorkbookZipArtifacts = (buffer) => {
  const zip = new PizZip(buffer);
  const parser = new DOMParser();
  const serializer = new XMLSerializer();
  const worksheetRelsFolder = "xl/worksheets/_rels/";

  const filesToDelete = new Set();
  const worksheetRelFiles = Object.keys(zip.files).filter(
    (fileName) => fileName.startsWith(worksheetRelsFolder) && fileName.endsWith(".rels")
  );

  worksheetRelFiles.forEach((relsPath) => {
    const relsFile = zip.file(relsPath);
    if (!relsFile) {
      return;
    }

    const relsDoc = parser.parseFromString(relsFile.asText(), "application/xml");
    const relationshipsNode = relsDoc.getElementsByTagName("Relationships")[0];
    if (!relationshipsNode) {
      return;
    }

    const relationships = Array.from(relsDoc.getElementsByTagName("Relationship"));
    const removedIds = [];

    relationships.forEach((relationship) => {
      const type = relationship.getAttribute("Type") || "";
      const target = relationship.getAttribute("Target") || "";

      if (
        type.includes("/threadedComment") ||
        type.includes("/person")
      ) {
        removedIds.push(relationship.getAttribute("Id"));
        const normalizedTarget = target.replace(/^\/+/, "").replace(/^\.\.\//g, "");
        const fullTarget = normalizedTarget.startsWith("xl/")
          ? normalizedTarget
          : `xl/${normalizedTarget}`;
        filesToDelete.add(fullTarget);
        relationshipsNode.removeChild(relationship);
      }
    });

    if (removedIds.length > 0) {
      const worksheetPath = relsPath
        .replace("xl/worksheets/_rels/", "xl/worksheets/")
        .replace(".xml.rels", ".xml");
      const worksheetFile = zip.file(worksheetPath);

      if (worksheetFile) {
        const worksheetDoc = parser.parseFromString(worksheetFile.asText(), "application/xml");
        ["legacyDrawing", "legacyDrawingHF"].forEach((tagName) => {
          Array.from(worksheetDoc.getElementsByTagName(tagName)).forEach((node) => {
            const relationId =
              node.getAttribute("r:id") || node.getAttribute("id") || node.getAttribute("R:id");
            if (!relationId || removedIds.includes(relationId)) {
              node.parentNode?.removeChild(node);
            }
          });
        });

        zip.file(worksheetPath, serializer.serializeToString(worksheetDoc));
      }

      zip.file(relsPath, serializer.serializeToString(relsDoc));
    }
  });

  Array.from(filesToDelete).forEach((filePath) => {
    zip.remove(filePath);
  });

  const workbookRelsFile = zip.file("xl/_rels/workbook.xml.rels");
  if (workbookRelsFile) {
    const workbookRelsDoc = parser.parseFromString(workbookRelsFile.asText(), "application/xml");
    const relationshipsNode = workbookRelsDoc.getElementsByTagName("Relationships")[0];
    const hasThemeFile = Boolean(zip.file("xl/theme/theme1.xml"));
    let removedTheme = false;

    if (relationshipsNode) {
      Array.from(workbookRelsDoc.getElementsByTagName("Relationship")).forEach((relationship) => {
        const type = relationship.getAttribute("Type") || "";

        if (type.includes("/theme") && !hasThemeFile) {
          relationshipsNode.removeChild(relationship);
          removedTheme = true;
        }
      });
    }

    zip.file("xl/_rels/workbook.xml.rels", serializer.serializeToString(workbookRelsDoc));

    if (removedTheme) {
      const workbookFile = zip.file("xl/workbook.xml");
      if (workbookFile) {
        const workbookDoc = parser.parseFromString(workbookFile.asText(), "application/xml");
        const workbookPr = workbookDoc.getElementsByTagName("workbookPr")[0];
        if (workbookPr) {
          workbookPr.removeAttribute("defaultThemeVersion");
        }
        zip.file("xl/workbook.xml", serializer.serializeToString(workbookDoc));
      }
    }
  }

  return Buffer.from(
    zip.generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    })
  );
};

const extractWorksheetHeaders = (worksheet) => {
  let bestRowNumber = 1;
  let bestHeaders = [];
  let bestHeaderColumns = [];

  for (let rowNumber = 1; rowNumber <= Math.min(20, worksheet.rowCount || 20); rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const headers = [];
    const headerColumns = [];

    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      const header = String(convertCellValue(cell.value) || "").trim();
      if (!header) return;
      headers.push(header);
      headerColumns.push(columnNumber);
    });

    if (headers.length > bestHeaders.length) {
      bestHeaders = headers;
      bestHeaderColumns = headerColumns;
      bestRowNumber = rowNumber;
    }
  }

  return {
    headerRowNumber: bestRowNumber,
    headers: bestHeaders,
    headerColumns: bestHeaderColumns,
  };
};

const cloneExcelStyle = (style = {}) => JSON.parse(JSON.stringify(style || {}));
const GUIDE_WORKSHEET_NAME = "GUIA_CAMPOS_SNIES";
const isGuideWorksheet = (worksheetName = "") =>
  normalizeComparableName(worksheetName) === normalizeComparableName(GUIDE_WORKSHEET_NAME);

const cloneCellValue = (value) => {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "object") {
    return JSON.parse(JSON.stringify(value));
  }

  return value;
};

const cloneWorkbookWithoutLegacyArtifacts = (sourceWorkbook) => {
  const cleanWorkbook = new ExcelJS.Workbook();

  cleanWorkbook.creator = sourceWorkbook.creator;
  cleanWorkbook.lastModifiedBy = sourceWorkbook.lastModifiedBy;
  cleanWorkbook.created = sourceWorkbook.created;
  cleanWorkbook.modified = sourceWorkbook.modified;
  cleanWorkbook.lastPrinted = sourceWorkbook.lastPrinted;
  cleanWorkbook.properties = { ...(sourceWorkbook.properties || {}) };
  cleanWorkbook.calcProperties = { ...(sourceWorkbook.calcProperties || {}) };
  cleanWorkbook.views = Array.isArray(sourceWorkbook.views)
    ? JSON.parse(JSON.stringify(sourceWorkbook.views))
    : [];

  sourceWorkbook.worksheets.forEach((sourceSheet) => {
    const targetSheet = cleanWorkbook.addWorksheet(sourceSheet.name, {
      properties: { ...(sourceSheet.properties || {}) },
      pageSetup: { ...(sourceSheet.pageSetup || {}) },
      views: Array.isArray(sourceSheet.views) ? JSON.parse(JSON.stringify(sourceSheet.views)) : [],
      state: sourceSheet.state,
    });

    sourceSheet.columns.forEach((column, index) => {
      const targetColumn = targetSheet.getColumn(index + 1);
      targetColumn.width = column.width;
      targetColumn.hidden = column.hidden;
      targetColumn.outlineLevel = column.outlineLevel;
      targetColumn.style = cloneExcelStyle(column.style || {});
    });

    sourceSheet.eachRow({ includeEmpty: true }, (sourceRow, rowNumber) => {
      const targetRow = targetSheet.getRow(rowNumber);
      targetRow.height = sourceRow.height;
      targetRow.hidden = sourceRow.hidden;
      targetRow.outlineLevel = sourceRow.outlineLevel;

      sourceRow.eachCell({ includeEmpty: true }, (sourceCell, colNumber) => {
        const targetCell = targetRow.getCell(colNumber);
        targetCell.value = cloneCellValue(sourceCell.value);
        targetCell.style = cloneExcelStyle(sourceCell.style || {});
        if (sourceCell.numFmt) targetCell.numFmt = sourceCell.numFmt;
        if (sourceCell.note) {
          targetCell.note = cloneNoteValue(sourceCell.note);
        }
      });

      targetRow.commit();
    });

    const mergeRanges = sourceSheet.model?.merges || [];
    mergeRanges.forEach((range) => {
      try {
        targetSheet.mergeCells(range);
      } catch (error) {
        // Ignore invalid merge ranges from legacy templates.
      }
    });
  });

  return cleanWorkbook;
};

const applyConfiguredFieldsToWorksheet = (worksheet, configuredFields = []) => {
  const normalizedFields = configuredFields.filter(
    (field) => field?.name && field?.worksheet_name === worksheet.name
  );

  if (normalizedFields.length === 0 || isInfoWorksheet(worksheet.name) || isGuideWorksheet(worksheet.name)) {
    return;
  }

  const { headerRowNumber, headers, headerColumns } = extractWorksheetHeaders(worksheet);
  if (!headerRowNumber) {
    return;
  }

  const headerRow = worksheet.getRow(headerRowNumber);
  const currentHeaders = [...headers];
  let currentHeaderColumns = [...headerColumns];
  const normalizedHeaderNames = currentHeaders.map((header) => normalizeFieldName(header));

  normalizedFields.forEach((field) => {
    const fieldName = String(field.name || "").trim();
    const normalizedFieldName = normalizeFieldName(fieldName);

    if (!fieldName || !normalizedFieldName || normalizedHeaderNames.includes(normalizedFieldName)) {
      return;
    }

    const normalizedInsertAfter = normalizeFieldName(field.insert_after || "");
    const insertAfterIndex = normalizedInsertAfter
      ? normalizedHeaderNames.findIndex((header) => header === normalizedInsertAfter)
      : -1;
    const insertColumnIndex = insertAfterIndex >= 0
      ? (currentHeaderColumns[insertAfterIndex] || insertAfterIndex + 1) + 1
      : Math.max(...currentHeaderColumns.filter(Boolean), currentHeaders.length) + 1;

    worksheet.spliceColumns(insertColumnIndex, 0, []);
    currentHeaderColumns = currentHeaderColumns.map((columnNumber) =>
      columnNumber >= insertColumnIndex ? columnNumber + 1 : columnNumber
    );

    const targetCell = headerRow.getCell(insertColumnIndex);
    const styleSourceCell = insertColumnIndex > 1
      ? headerRow.getCell(insertColumnIndex - 1)
      : headerRow.getCell(insertColumnIndex + 1);

    if (styleSourceCell?.style) {
      targetCell.style = cloneExcelStyle(styleSourceCell.style);
    }

    targetCell.value = fieldName;
    targetCell.note = field.comment
      ? {
          texts: [
            {
              text: String(field.comment).trim(),
              font: {
                size: 11,
                name: "Calibri",
              },
            },
          ],
        }
      : undefined;

    const sourceColumn = worksheet.getColumn(insertColumnIndex > 1 ? insertColumnIndex - 1 : insertColumnIndex + 1);
    const targetColumn = worksheet.getColumn(insertColumnIndex);
    if (sourceColumn?.width) {
      targetColumn.width = sourceColumn.width;
    } else {
      targetColumn.width = Math.max(fieldName.length + 4, 18);
    }

    const insertHeaderIndex = insertAfterIndex >= 0 ? insertAfterIndex + 1 : currentHeaders.length;
    currentHeaders.splice(insertHeaderIndex, 0, fieldName);
    currentHeaderColumns.splice(insertHeaderIndex, 0, insertColumnIndex);
    normalizedHeaderNames.splice(insertHeaderIndex, 0, normalizedFieldName);
  });
};

const clearWorkbookNotes = (workbook) => {
  workbook.worksheets.forEach((worksheet) => {
    worksheet.eachRow({ includeEmpty: true }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        if (cell.note) {
          cell.note = undefined;
        }
      });
    });
  });
};

const removeConfiguredFieldsFromWorksheet = (worksheet, configuredFields = []) => {
  const normalizedFieldsToRemove = new Set(
    configuredFields
      .filter((field) => field?.name && field?.worksheet_name === worksheet.name)
      .map((field) => normalizeFieldName(field.name))
      .filter(Boolean)
  );

  if (normalizedFieldsToRemove.size === 0 || isInfoWorksheet(worksheet.name) || isGuideWorksheet(worksheet.name)) {
    return;
  }

  const { headers, headerColumns } = extractWorksheetHeaders(worksheet);
  for (let index = headers.length - 1; index >= 0; index -= 1) {
    const normalizedHeader = normalizeFieldName(headers[index]);
    if (normalizedFieldsToRemove.has(normalizedHeader)) {
      worksheet.spliceColumns(headerColumns[index] || index + 1, 1);
    }
  }
};

const fieldHasDropdownSource = (field = {}) =>
  Boolean(field?.worksheet_name && field?.name && !field?.multiple) &&
  extractDropdownOptionsFromComment(field.comment, { preserveLeadingCodes: true }).length > 0;

const getCommentDropdownOptions = (field = {}) =>
  extractDropdownOptionsFromComment(field.comment, { preserveLeadingCodes: true }).map((value) => ({ value }));

const applyCommentDropdownsToWorkbook = (workbook, configuredFields = []) => {
  const fieldsWithDropdown = configuredFields.filter(fieldHasDropdownSource);

  if (fieldsWithDropdown.length === 0) {
    return;
  }

  const sourcesSheetName = "_Listas";
  const existingSourcesSheet = workbook.getWorksheet(sourcesSheetName);
  const sourcesSheet = existingSourcesSheet ?? workbook.addWorksheet(sourcesSheetName);
  sourcesSheet.state = "veryHidden";

  let sourceCol = Math.max(1, sourcesSheet.columnCount + 1);

  workbook.worksheets.forEach((worksheet) => {
    if (worksheet.name === sourcesSheetName || isInfoWorksheet(worksheet.name) || isGuideWorksheet(worksheet.name)) {
      return;
    }

    const { headerRowNumber, headers, headerColumns } = extractWorksheetHeaders(worksheet);
    if (!headerRowNumber) {
      return;
    }

    const worksheetFields = fieldsWithDropdown.filter((field) => field.worksheet_name === worksheet.name);
    worksheetFields.forEach((field) => {
      const fieldIndex = headers.findIndex(
        (header) => normalizeFieldName(header) === normalizeFieldName(field.name)
      );
      if (fieldIndex < 0) {
        return;
      }

      const options = getCommentDropdownOptions(field);
      if (options.length === 0) {
        return;
      }

      options.forEach((option, optionIndex) => {
        sourcesSheet.getCell(optionIndex + 1, sourceCol).value = option.value;
      });

      const colLetter = columnNumberToName(sourceCol);
      const rangeRef = `'${sourcesSheetName}'!$${colLetter}$1:$${colLetter}$${options.length}`;
      const targetColumnIndex = headerColumns[fieldIndex] || fieldIndex + 1;
      const normalizedComment = field.comment
        ? String(field.comment).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim()
        : "";
      const promptText =
        normalizedComment.length > 220
          ? `${normalizedComment.slice(0, 217)}...`
          : normalizedComment;

      for (let row = headerRowNumber + 1; row <= 1000; row += 1) {
        const cell = worksheet.getCell(row, targetColumnIndex);
        const validation = {
          type: "list",
          allowBlank: true,
          formulae: [rangeRef],
          showErrorMessage: true,
          errorTitle: "Valor no valido",
          error: "Selecciona un valor de la lista desplegable.",
        };

        if (promptText) {
          validation.showInputMessage = true;
          validation.promptTitle = String(field.name || "").slice(0, 32);
          validation.prompt = promptText;
        }

        cell.dataValidation = validation;
      }

      sourceCol += 1;
    });
  });
};

const buildWorkbookWithConfiguredFields = async (
  workbookInput,
  configuredFields = [],
  previousConfiguredFields = [],
  periodId = null
) => {
  const sourceBuffer = Buffer.isBuffer(workbookInput)
    ? Buffer.from(workbookInput)
    : fs.readFileSync(workbookInput);
  const sourceWorkbook = new ExcelJS.Workbook();

  await sourceWorkbook.xlsx.load(sourceBuffer);

  const originalCommentsBySheet = getOriginalHeaderCommentsBySheet(sourceBuffer, sourceWorkbook);

  const workbook = cloneWorkbookWithoutLegacyArtifacts(sourceWorkbook);

  workbook.worksheets.forEach((worksheet) => {
    removeConfiguredFieldsFromWorksheet(worksheet, previousConfiguredFields);
    applyConfiguredFieldsToWorksheet(worksheet, configuredFields);
  });

  applyCommentDropdownsToWorkbook(workbook, configuredFields);

  const headerCommentsPlan = buildWorksheetHeaderCommentsPlan(
    workbook,
    configuredFields,
    originalCommentsBySheet
  );
  applyHeaderDropdownsFromComments(workbook, headerCommentsPlan);
  applyHeaderHelpPromptsToWorkbook(workbook, headerCommentsPlan);

  const existingGuideWorksheet = workbook.getWorksheet(GUIDE_WORKSHEET_NAME);
  if (existingGuideWorksheet) {
    workbook.removeWorksheet(existingGuideWorksheet.id);
  }

  const updatedBuffer = await workbook.xlsx.writeBuffer();
  const sanitizedBuffer = sanitizeWorkbookZipArtifacts(Buffer.from(updatedBuffer));
  return injectWorksheetCommentsIntoWorkbook(sanitizedBuffer, headerCommentsPlan);
};

const workbookHasHeaderCommentDropdowns = async (workbookInput) => {
  const sourceBuffer = Buffer.isBuffer(workbookInput)
    ? Buffer.from(workbookInput)
    : fs.readFileSync(workbookInput);
  const sourceWorkbook = new ExcelJS.Workbook();

  await sourceWorkbook.xlsx.load(sourceBuffer);

  const originalCommentsBySheet = getOriginalHeaderCommentsBySheet(sourceBuffer, sourceWorkbook);
  for (const commentsByField of originalCommentsBySheet.values()) {
    for (const commentText of commentsByField.values()) {
      if (extractDropdownOptionsFromComment(commentText, { preserveLeadingCodes: true }).length > 0) {
        return true;
      }
    }
  }

  return false;
};

const createTemporaryExcelUpload = (fileName, buffer) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "snies-template-"));
  const tempPath = path.join(tempDir, fileName || `snies-template-${Date.now()}.xlsx`);

  fs.writeFileSync(tempPath, buffer);

  return {
    path: tempPath,
    originalname: fileName || path.basename(tempPath),
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    tempDir,
  };
};

const cleanupTemporaryExcelUpload = (file) => {
  if (file?.path && fs.existsSync(file.path)) {
    fs.unlinkSync(file.path);
  }

  if (file?.tempDir && fs.existsSync(file.tempDir)) {
    fs.rmSync(file.tempDir, { recursive: true, force: true });
  }
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

    const recordMapsBySheet = new Map();

    loadedData.filled_data.forEach((fieldData) => {
      const values = Array.isArray(fieldData?.values) ? fieldData.values : [];
      const sheetName = String(
        fieldData?.sheet_name || fieldData?.sheet || fieldData?.sheetName || ""
      ).trim();
      const sheetKey = sheetName || "__legacy__";

      if (!recordMapsBySheet.has(sheetKey)) {
        recordMapsBySheet.set(sheetKey, []);
      }

      const recordMap = recordMapsBySheet.get(sheetKey);

      values.forEach((rawValue, index) => {
        if (!recordMap[index]) {
          recordMap[index] = {
            Dependencia: depCodeToNameMap[loadedData.dependency] || loadedData.dependency,
            __DEP_CODE: loadedData.dependency, // dep_code interno para enriquecimiento
            ...(sheetName ? { __SHEET_NAME: sheetName } : {}),
          };
        }

        recordMap[index][normalizeFieldName(fieldData.field_name)] = convertCellValue(rawValue);
      });
    });

    recordMapsBySheet.forEach((recordMap) => {
      rows.push(...recordMap.filter(Boolean));
    });
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

const buildSniesDataset = async (template, fallbackPubTemId = null) => {
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

  let sourceTemplates = getSourceTemplatesFromSnies(template);

  // When the frontend provides a specific published template ID (e.g. user navigated
  // from that template), add it to the source list if it's not already there.
  // This handles the case where source_published_templates has a stale/wrong ID.
  if (fallbackPubTemId) {
    const alreadyIncluded = sourceTemplates.some(
      (s) => String(s.template_id) === String(fallbackPubTemId)
    );
    if (!alreadyIncluded) {
      try {
        const pubTem = await PublishedTemplate.findById(fallbackPubTemId).select("_id name").lean();
        if (pubTem) {
          sourceTemplates = [...sourceTemplates, { template_id: pubTem._id, template_name: pubTem.name }];
          console.log(`[SNIES-Dataset] Added fallback pubTemId ${fallbackPubTemId} → "${pubTem.name}"`);
        }
      } catch (e) {
        console.warn("[SNIES-Dataset] Could not load fallback pubTem:", e.message);
      }
    }
  }
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
  workbook.worksheets.forEach((worksheet) => {
    removeConfiguredFieldsFromWorksheet(worksheet, (template.fields || []).filter((field) => field?.field_origin !== "snies_original"));
  });
  const workbookNotes = captureWorkbookNotes(workbook);
  const worksheets = workbook.worksheets.filter(
    (worksheet) => !isGuideWorksheet(worksheet.name)
  );

  if (!worksheets[0]) {
    throw new Error("SNIES template workbook has no worksheets");
  }

  const useWorksheetMapping = worksheets.length > 1;
  const mergedRows = enrichedSourceDatasets.flatMap((sourceTemplate) => sourceTemplate.rows);
  const validatorNormalizationLookup = await buildSniesValidatorNormalizationLookup(template.fields || [], template.period);
  const equivalenceLookup = buildFieldEquivalenceLookup(template.field_equivalences);

  const sheetDatasets = worksheets.map((worksheet) => {
    const { headerRowNumber, headers, headerColumns } = extractWorksheetHeaders(worksheet);

    if (isInfoWorksheet(worksheet.name)) {
      return {
        worksheet,
        worksheetName: worksheet.name,
        headerRowNumber,
        headers,
        headerColumns,
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
        headerColumns: [],
        rows: [],
        sourceTemplate: null,
        preserveOriginalContent: false,
      };
    }

    const matchedSourceTemplate = useWorksheetMapping
      ? getWorksheetTemplateMatch(worksheet.name, headers, enrichedSourceDatasets)
      : null;
    const candidateSourceRows = useWorksheetMapping
      ? matchedSourceTemplate?.rows || mergedRows
      : mergedRows;
    const sourceRows = pickWorksheetRows(candidateSourceRows, worksheet.name, headers);

    const normalizedHeaders = headers.map((header) => normalizeFieldName(header));
    const finalRows = sourceRows.map((row) => {
      const normalizedRow = Object.entries(row).reduce((acc, [key, value]) => {
        acc[normalizeFieldName(key)] = value;
        return acc;
      }, {});

      return headers.reduce((acc, header, index) => {
        const normalizedHeader = normalizedHeaders[index];
        const directValue = normalizedRow[normalizedHeader];
        const equivalentValue = getEquivalentFieldMappings(equivalenceLookup, worksheet.name, header)
          .map(({ fieldName, valueMappings }) =>
            applyValueMappings(normalizedRow[fieldName], valueMappings)
          )
          .find(hasUsableValue);
        const periodFallback = periodYear
          ? getPeriodValueForHeader(normalizedHeader, periodValues)
          : undefined;

        const normalizer = getSniesValidatorNormalizer(validatorNormalizationLookup, worksheet.name, header);
        const value = hasUsableValue(directValue)
          ? directValue
          : equivalentValue ?? periodFallback ?? "";
        acc[header] = normalizeSniesValidatorOutputValue(value, normalizer);
        return acc;
      }, {});
    });

    return {
      worksheet,
      worksheetName: worksheet.name,
      headerRowNumber,
      headers,
      headerColumns,
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

const buildSniesComparisonDataset = async (template) => {
  const sourceTemplates = getSourceTemplatesFromSnies(template);
  const sourceTemplateIds = sourceTemplates.map((item) => item.template_id).filter(Boolean);

  const publishedTemplates = sourceTemplateIds.length
    ? await PublishedTemplate.find(
        { _id: { $in: sourceTemplateIds } },
        { _id: 1, name: 1, "template.fields.name": 1 }
      ).lean()
    : [];

  const sourceTemplateMap = publishedTemplates.reduce((acc, publishedTemplate) => {
    acc[String(publishedTemplate._id)] = publishedTemplate;
    return acc;
  }, {});

  const normalizedSourceTemplates = sourceTemplates.map((sourceTemplate) => {
    const publishedTemplate = sourceTemplateMap[String(sourceTemplate.template_id)];
    const fieldNames = Array.isArray(publishedTemplate?.template?.fields)
      ? publishedTemplate.template.fields.map((field) => field?.name).filter(Boolean)
      : [];

    return {
      template_id: sourceTemplate.template_id,
      template_name: sourceTemplate.template_name,
      fieldNames,
      normalizedKeys: fieldNames.map((fieldName) => normalizeFieldName(fieldName)),
    };
  });

  const templateBuffer = await downloadDriveFileBuffer(template.drive_file_id);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer);

  const sheetDatasets = workbook.worksheets.map((worksheet) => {
    const { headers } = extractWorksheetHeaders(worksheet);

    if (isInfoWorksheet(worksheet.name)) {
      return null;
    }

    if (headers.length === 0) {
      return {
        worksheetName: worksheet.name,
        headers,
        sourceTemplate: null,
      };
    }

    const matchedSourceTemplate = workbook.worksheets.length > 1
      ? getWorksheetTemplateMatch(worksheet.name, headers, normalizedSourceTemplates)
      : normalizedSourceTemplates[0] || null;

    return {
      worksheetName: worksheet.name,
      headers,
      sourceTemplate: matchedSourceTemplate
        ? {
            template_id: matchedSourceTemplate.template_id,
            template_name: matchedSourceTemplate.template_name,
            fieldNames: matchedSourceTemplate.fieldNames || [],
          }
        : null,
    };
  });

  return {
    sheetDatasets: sheetDatasets.filter(Boolean),
    sourceTemplates: normalizedSourceTemplates,
  };
};

const applyFieldComparisonBorders = (worksheet, rowNumber, columns) => {
  columns.forEach((column) => {
    worksheet.getCell(`${column}${rowNumber}`).border = {
      top: { style: "thin", color: { argb: "FFD0D7DE" } },
      left: { style: "thin", color: { argb: "FFD0D7DE" } },
      bottom: { style: "thin", color: { argb: "FFD0D7DE" } },
      right: { style: "thin", color: { argb: "FFD0D7DE" } },
    };
  });
};

const appendFieldComparisonSheets = async (workbook, template, dataset, includeTemplateNameInSheet = false) => {
  dataset.sheetDatasets.forEach((sheet, index) => {
    const rawSheetName = includeTemplateNameInSheet
      ? `${template.name}_${sheet.worksheetName}`
      : sheet.worksheetName;
    const worksheet = workbook.addWorksheet(
      resolveUniqueWorksheetName(workbook, rawSheetName, `Hoja_${index + 1}`)
    );
    const sniesFields = Array.isArray(sheet.headers) ? sheet.headers : [];
    const miroFields = Array.isArray(sheet.sourceTemplate?.fieldNames)
      ? sheet.sourceTemplate.fieldNames
      : [];
    const miroNormalizedFieldSet = new Set(miroFields.map((fieldName) => normalizeFieldName(fieldName)));
    const sniesNormalizedFieldSet = new Set(sniesFields.map((fieldName) => normalizeFieldName(fieldName)));
    const totalRows = Math.max(sniesFields.length, miroFields.length, 1);

    worksheet.columns = [
      { width: 8 },
      { width: 42 },
      { width: 4 },
      { width: 8 },
      { width: 42 },
    ];

    worksheet.mergeCells("A1:B1");
    worksheet.mergeCells("D1:E1");
    worksheet.getCell("A1").value = "Campos SNIES";
    worksheet.getCell("D1").value = "Campos MIRÓ";
    worksheet.getCell("A2").value = "#";
    worksheet.getCell("B2").value = "Campo SNIES";
    worksheet.getCell("D2").value = "#";
    worksheet.getCell("E2").value = "Campo MIRÓ";

    for (let rowIndex = 0; rowIndex < totalRows; rowIndex += 1) {
      const excelRow = rowIndex + 3;
      const sniesField = sniesFields[rowIndex] || "";
      const miroField = miroFields[rowIndex] || "";
      const sniesCell = worksheet.getCell(`B${excelRow}`);
      const miroCell = worksheet.getCell(`E${excelRow}`);

      worksheet.getCell(`A${excelRow}`).value = sniesField ? rowIndex + 1 : "";
      sniesCell.value = sniesField;
      worksheet.getCell(`D${excelRow}`).value = miroField ? rowIndex + 1 : "";
      miroCell.value = miroField;

      if (sniesField && miroNormalizedFieldSet.has(normalizeFieldName(sniesField))) {
        sniesCell.fill = MATCH_FILL;
      }

      if (miroField && sniesNormalizedFieldSet.has(normalizeFieldName(miroField))) {
        miroCell.fill = MATCH_FILL;
      }
    }

    ["A1", "D1"].forEach((cellRef) => {
      const cell = worksheet.getCell(cellRef);
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 12 };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF0F1F39" },
      };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    ["A2", "B2", "D2", "E2"].forEach((cellRef) => {
      const cell = worksheet.getCell(cellRef);
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1D4E89" },
      };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    for (let rowNumber = 2; rowNumber <= totalRows + 2; rowNumber += 1) {
      applyFieldComparisonBorders(worksheet, rowNumber, ["A", "B", "D", "E"]);
    }

    worksheet.views = [{ state: "frozen", ySplit: 2 }];
  });
};

const appendConsolidatedFieldComparisonSheet = (workbook, template, dataset) => {
  const worksheet = workbook.addWorksheet(
    resolveUniqueWorksheetName(workbook, template.name, "Plantilla_SNIES")
  );

  worksheet.columns = [
    { width: 24 },
    { width: 8 },
    { width: 42 },
    { width: 4 },
    { width: 8 },
    { width: 42 },
  ];

  let currentRow = 1;

  dataset.sheetDatasets.forEach((sheet, index) => {
    const sniesFields = Array.isArray(sheet.headers) ? sheet.headers : [];
    const miroFields = Array.isArray(sheet.sourceTemplate?.fieldNames)
      ? sheet.sourceTemplate.fieldNames
      : [];
    const miroNormalizedFieldSet = new Set(miroFields.map((fieldName) => normalizeFieldName(fieldName)));
    const sniesNormalizedFieldSet = new Set(sniesFields.map((fieldName) => normalizeFieldName(fieldName)));
    const totalRows = Math.max(sniesFields.length, miroFields.length, 1);
    const sectionStartRow = currentRow;
    const headerRow = sectionStartRow + 1;
    const subHeaderRow = sectionStartRow + 2;
    const dataStartRow = sectionStartRow + 3;
    const dataEndRow = dataStartRow + totalRows - 1;

    worksheet.mergeCells(`B${headerRow}:C${headerRow}`);
    worksheet.mergeCells(`E${headerRow}:F${headerRow}`);
    worksheet.getCell(`B${headerRow}`).value = "Campos SNIES";
    worksheet.getCell(`E${headerRow}`).value = "Campos MIRÓ";
    worksheet.getCell(`B${subHeaderRow}`).value = "#";
    worksheet.getCell(`C${subHeaderRow}`).value = "Campo SNIES";
    worksheet.getCell(`E${subHeaderRow}`).value = "#";
    worksheet.getCell(`F${subHeaderRow}`).value = "Campo MIRÓ";

    worksheet.mergeCells(`A${headerRow}:A${dataEndRow}`);
    const sectionCell = worksheet.getCell(`A${headerRow}`);
    sectionCell.value = sheet.worksheetName || `Hoja ${index + 1}`;
    sectionCell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    sectionCell.font = { bold: true, color: { argb: "FF1F1F1F" } };
    sectionCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFF2F2F2" },
    };

    ["B", "E"].forEach((column) => {
      const cell = worksheet.getCell(`${column}${headerRow}`);
      cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 12 };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF0F1F39" },
      };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    ["B", "C", "E", "F"].forEach((column) => {
      const cell = worksheet.getCell(`${column}${subHeaderRow}`);
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1D4E89" },
      };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    for (let rowIndex = 0; rowIndex < totalRows; rowIndex += 1) {
      const excelRow = dataStartRow + rowIndex;
      const sniesField = sniesFields[rowIndex] || "";
      const miroField = miroFields[rowIndex] || "";
      const sniesCell = worksheet.getCell(`C${excelRow}`);
      const miroCell = worksheet.getCell(`F${excelRow}`);

      worksheet.getCell(`B${excelRow}`).value = sniesField ? rowIndex + 1 : "";
      sniesCell.value = sniesField;
      worksheet.getCell(`E${excelRow}`).value = miroField ? rowIndex + 1 : "";
      miroCell.value = miroField;

      if (sniesField && miroNormalizedFieldSet.has(normalizeFieldName(sniesField))) {
        sniesCell.fill = MATCH_FILL;
      }

      if (miroField && sniesNormalizedFieldSet.has(normalizeFieldName(miroField))) {
        miroCell.fill = MATCH_FILL;
      }

      applyFieldComparisonBorders(worksheet, excelRow, ["A", "B", "C", "E", "F"]);
    }

    applyFieldComparisonBorders(worksheet, headerRow, ["A", "B", "C", "E", "F"]);
    applyFieldComparisonBorders(worksheet, subHeaderRow, ["A", "B", "C", "E", "F"]);

    currentRow = dataEndRow + 2;
  });

  worksheet.views = [{ state: "frozen", ySplit: 3 }];
};

const buildFieldComparisonWorkbook = async (template, dataset) => {
  const workbook = new ExcelJS.Workbook();
  await appendFieldComparisonSheets(workbook, template, dataset);
  return workbook;
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
    };

    const publishedTemplates = await PublishedTemplate.find(query)
      .sort({ name: 1 })
      .select("_id name period loaded_data")
      .lean();

    return res.status(200).json({
      publishedTemplates: publishedTemplates.map((template) => ({
        value: template._id.toString(),
        label: `${template.name} (${template.loaded_data?.length || 0} dependencias con datos)`,
        name: template.name,
        loadedDependencies: template.loaded_data?.length || 0,
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
    const { email, pubTemId } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await SniesTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "SNIES template not found" });
    }

    const dataset = await buildSniesDataset(template, pubTemId || null);

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
    const { email, pubTemId } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await SniesTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "SNIES template not found" });
    }

    const { workbook, sheetDatasets, workbookNotes, templateBuffer } = await buildSniesDataset(template, pubTemId || null);
    restoreWorkbookNotes(workbook, workbookNotes);

    const zip = new PizZip(templateBuffer);
    const worksheetXmlPathMap = getWorksheetXmlPathMap(zip);

    sheetDatasets.forEach(({ worksheetName, headers, rows, headerRowNumber, headerColumns, preserveOriginalContent }) => {
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
        headerRowNumber,
        headerColumns
      );

      zip.file(worksheetPath, updatedWorksheetXml);
    });

    const outputBuffer = zip.generate({
      type: "nodebuffer",
      compression: "DEFLATE",
    });

    const fileName = buildDownloadFileName(template);

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.send(outputBuffer);
  } catch (error) {
    console.error("Error downloading SNIES connected data:", error);
    return res.status(500).json({
      error: "Error downloading SNIES connected data",
      details: error.message,
    });
  }
};

controller.downloadFieldComparison = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await SniesTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "SNIES template not found" });
    }

    const previousFields = Array.isArray(template.fields) ? template.fields : [];

    const dataset = await buildSniesComparisonDataset(template);
    const comparisonWorkbook = await buildFieldComparisonWorkbook(template, dataset);
    const outputBuffer = await comparisonWorkbook.xlsx.writeBuffer();

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${buildComparisonFileName(template)}"; filename*=UTF-8''${encodeURIComponent(buildComparisonFileName(template))}`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    return res.send(Buffer.from(outputBuffer));
  } catch (error) {
    console.error("Error downloading SNIES field comparison:", error);
    return res.status(500).json({
      error: "Error downloading SNIES field comparison",
      details: error.message,
    });
  }
};

controller.downloadAllFieldComparisons = async (req, res) => {
  try {
    const { email, periodId } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const templates = await SniesTemplate.find(periodId ? { period: periodId } : {})
      .sort({ createdAt: -1 });

    if (!templates.length) {
      return res.status(404).json({ error: "No SNIES templates found" });
    }

    const workbook = new ExcelJS.Workbook();

    for (const template of templates) {
      const dataset = await buildSniesComparisonDataset(template);
      appendConsolidatedFieldComparisonSheet(workbook, template, dataset);
    }

    const outputBuffer = await workbook.xlsx.writeBuffer();

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${buildAllComparisonsFileName()}"; filename*=UTF-8''${encodeURIComponent(buildAllComparisonsFileName())}`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    return res.send(Buffer.from(outputBuffer));
  } catch (error) {
    console.error("Error downloading all SNIES field comparisons:", error);
    return res.status(500).json({
      error: "Error downloading all SNIES field comparisons",
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
    const shouldRebuildWorkbook =
      (template.fields || []).some(fieldHasDropdownSource) ||
      await workbookHasHeaderCommentDropdowns(fileBuffer);
    const downloadableBuffer = shouldRebuildWorkbook
      ? await buildWorkbookWithConfiguredFields(
          fileBuffer,
          template.fields || [],
          [],
          template.period || null
        )
      : fileBuffer;
    const downloadFileName = buildDownloadFileName(template);

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${downloadFileName}"; filename*=UTF-8''${encodeURIComponent(downloadFileName)}`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    return res.send(downloadableBuffer);
  } catch (error) {
    console.error("Error downloading SNIES template file:", error);
    return res.status(500).json({
      error: "Error downloading SNIES template file",
      details: error.message,
    });
  }
};

controller.getTemplateById = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await SniesTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "SNIES template not found" });
    }

    const workbookSheets = await getWorkbookSheetsFromTemplate(template);

    return res.status(200).json({
      _id: template._id,
      name: template.name,
      file_name: template.file_name,
      file_description: template.file_description || "",
      active: template.active,
      fields: (template.fields || []).map((field) => ({
        name: field.name || "",
        worksheet_name: field.worksheet_name || "",
        insert_after: field.insert_after || "",
        datatype: field.datatype || "",
        required: field.required ?? true,
        validate_with: field.validate_with || "",
        comment: field.comment || "",
        dropdown_options: field.dropdown_options || [],
        excel_validation_options: field.excel_validation_options || [],
        validator_options: field.validator_options || [],
        field_origin: field.field_origin || "snies_extra",
        visible_for_producer: field.visible_for_producer ?? true,
        export_to_snies: field.export_to_snies ?? false,
        multiple: field.multiple ?? false,
      })),
      dimensions: (template.dimensions || []).map((item) => String(item)),
      producers: (template.producers || []).map((item) => String(item)),
      source_published_template_id: template.source_published_template_id,
      source_published_template_name: template.source_published_template_name,
      source_published_templates: template.source_published_templates || [],
      field_equivalences: template.field_equivalences || {},
      created_by: template.created_by,
      period: template.period,
      workbook_sheets: workbookSheets,
    });
  } catch (error) {
    console.error("Error fetching SNIES template by id:", error);
    return res.status(500).json({
      error: "Error fetching SNIES template by id",
      details: error.message,
    });
  }
};

controller.createTemplate = async (req, res) => {
  try {
    const { email, name, periodId, file_description, active } = req.body;
    const sourcePublishedTemplateIds = []
      .concat(req.body.sourcePublishedTemplateIds || [])
      .concat(req.body.sourcePublishedTemplateId || [])
      .filter(Boolean);
    const fields = parseFieldsInput(req.body.fields);
    const dimensions = parseIdArray(req.body.dimensions);
    const producers = parseIdArray(req.body.producers);
    const fieldEquivalences = parseFieldEquivalencesInput(req.body.field_equivalences);

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
    let uploadFile = req.file;

    if (fields.length > 0) {
      const updatedWorkbookBuffer = await buildWorkbookWithConfiguredFields(
        req.file.path,
        fields,
        [],
        periodId || null
      );
      fs.writeFileSync(req.file.path, updatedWorkbookBuffer);
    }

    const uploaded = await uploadFileToGoogleDrive(
      uploadFile,
      "Formatos/Plantillas/SNIES",
      uploadFile.originalname
    );

    const template = new SniesTemplate({
      name: name.trim(),
      file_name: req.file.originalname,
      file_description: file_description ? String(file_description).trim() : "",
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
      active: normalizeBoolean(active, true),
      fields,
      dimensions,
      producers,
      ...(fieldEquivalences !== undefined && { field_equivalences: fieldEquivalences }),
    });

    await template.save();
    await syncPublishedTemplateSnapshots(template);

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
  let tempUploadFile = null;

  try {
    const { id } = req.params;
    const { email, name, periodId, file_name, file_description, active } = req.body;
    const sourcePublishedTemplateIds = []
      .concat(req.body.sourcePublishedTemplateIds || [])
      .concat(req.body.sourcePublishedTemplateId || [])
      .filter(Boolean);
    const fields = parseFieldsInput(req.body.fields);
    const dimensions = parseIdArray(req.body.dimensions);
    const producers = parseIdArray(req.body.producers);
    const fieldEquivalences = parseFieldEquivalencesInput(req.body.field_equivalences);

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await SniesTemplate.findById(id);
    if (!template) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(404).json({ error: "SNIES template not found" });
    }

    const previousFields = Array.isArray(template.fields)
      ? template.fields.map((field) => ({ ...field.toObject?.() || field }))
      : [];

    if (name?.trim()) {
      template.name = name.trim();
    }
    if (file_name?.trim()) {
      template.file_name = file_name.trim();
    }
    if (file_description !== undefined) {
      template.file_description = String(file_description || "").trim();
    }
    if (periodId) {
      template.period = periodId;
    }
    if (req.body.active !== undefined) {
      template.active = normalizeBoolean(active, template.active);
    }
    if (req.body.fields !== undefined) {
      template.fields = fields;
    }
    if (req.body.dimensions !== undefined) {
      template.dimensions = dimensions;
    }
    if (req.body.producers !== undefined) {
      template.producers = producers;
    }
    if (fieldEquivalences !== undefined) {
      template.field_equivalences = fieldEquivalences;
      template.markModified('field_equivalences');
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

    if (req.file && fields.length > 0) {
      const updatedWorkbookBuffer = await buildWorkbookWithConfiguredFields(
        req.file.path,
        fields,
        [],
        template.period || null
      );
      fs.writeFileSync(req.file.path, updatedWorkbookBuffer);
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
    } else if (req.body.fields !== undefined) {
      const currentWorkbookBuffer = await downloadDriveFileBuffer(template.drive_file_id);
      const updatedWorkbookBuffer = await buildWorkbookWithConfiguredFields(
        currentWorkbookBuffer,
        fields,
        previousFields,
        template.period || null
      );

      tempUploadFile = createTemporaryExcelUpload(template.file_name, updatedWorkbookBuffer);

      const updated = await updateFileInGoogleDrive(
        template.drive_file_id,
        tempUploadFile,
        template.file_name
      );

      template.drive_file_link = updated.webViewLink;
      template.drive_file_download = updated.webContentLink;
    }

    await template.save();
    await syncPublishedTemplateSnapshots(template);

    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    cleanupTemporaryExcelUpload(tempUploadFile);

    return res.status(200).json({
      message: "SNIES template updated",
      template,
    });
  } catch (error) {
    console.error("Error updating SNIES template:", error);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    cleanupTemporaryExcelUpload(tempUploadFile);
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
