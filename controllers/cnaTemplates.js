const fs = require("fs");
const os = require("os");
const path = require("path");
const ExcelJS = require("exceljs");
const PizZip = require("pizzip");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const CnaTemplate = require("../models/cnaTemplates");
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
const {
  collapseRepeatedCompositeOption,
  extractDropdownOptionsFromComment,
} = require("../helpers/dropdownOptions");

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

const normalizeDropdownOptionArray = (value) => (
  Array.isArray(value)
    ? value
        .map((option) => (
          typeof option === "string"
            ? collapseRepeatedCompositeOption(option)
            : option
        ))
        .filter((option) => typeof option !== "string" || option.trim())
    : []
);

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
      dropdown_options: normalizeDropdownOptionArray(field?.dropdown_options),
      excel_validation_options: normalizeDropdownOptionArray(field?.excel_validation_options),
      validator_options: normalizeDropdownOptionArray(field?.validator_options),
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
  assertSupportedWorkbookBuffer(templateBuffer, "La plantilla CNA");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer);

  return workbook.worksheets.map((worksheet) => {
    const detailedHeaders = extractDetailedWorksheetHeaders(worksheet);
    const { headers } = detailedHeaders;
    const dropdownOptionsByField = extractWorksheetDropdownOptions(workbook, worksheet, detailedHeaders);
    const detailedFields = Array.isArray(detailedHeaders.fields) && detailedHeaders.fields.length
      ? detailedHeaders.fields
      : headers.map((header) => ({ name: header, baseName: header, groupPath: [] }));
    const configuredExtraFieldNames = new Set(
      (template.fields || [])
        .filter((field) => field?.field_origin !== "snies_original" && field?.worksheet_name === worksheet.name)
        .map((field) => normalizeDropdownFieldKey(field.name))
        .filter(Boolean)
    );

    const originalFieldDescriptors = detailedFields.filter(
      (field) =>
        !configuredExtraFieldNames.has(normalizeDropdownFieldKey(field.name)) &&
        !configuredExtraFieldNames.has(normalizeDropdownFieldKey(field.baseName || field.name))
    );
    const originalHeaders = originalFieldDescriptors.map((field) => field.name);
    const visualFields = originalFieldDescriptors.map((field) => ({
      name: field.name,
      base_name: field.baseName || field.name,
      source_name: field.baseName || field.name,
      group_path: field.groupPath || [],
      cell_ref: field.cellRef || "",
      row_number: field.rowNumber,
      column_number: field.columnNumber,
      field_origin: "snies_original",
      visible_for_producer: true,
      export_to_snies: true,
      validator_options:
        dropdownOptionsByField.get(normalizeDropdownFieldKey(field.name)) ||
        dropdownOptionsByField.get(normalizeDropdownFieldKey(field.baseName || field.name)) ||
        [],
    }));

    const additionalFields = (template.fields || [])
      .filter((field) => field?.field_origin !== "snies_original" && field?.worksheet_name === worksheet.name)
      .map((field) => ({
        name: field.name || "",
        insert_after: field.insert_after || "",
        field_origin: "snies_extra",
        visible_for_producer: field.visible_for_producer ?? true,
        export_to_snies: field.export_to_snies ?? false,
        validate_with: field.validate_with || "",
        dropdown_options: normalizeDropdownOptionArray(field.dropdown_options),
        excel_validation_options: normalizeDropdownOptionArray(field.excel_validation_options),
        validator_options: normalizeDropdownOptionArray(field.validator_options),
      }));

    additionalFields.forEach((field) => {
      const normalizedName = normalizeDropdownFieldKey(field.name);
      if (!normalizedName) {
        return;
      }

      const currentIndex = visualFields.findIndex((item) => normalizeDropdownFieldKey(item.name) === normalizedName);
      if (currentIndex >= 0) {
        visualFields.splice(currentIndex, 1);
      }

      const insertAfter = normalizeDropdownFieldKey(field.insert_after);
      const insertAfterIndex = insertAfter
        ? visualFields.findIndex((item) => normalizeDropdownFieldKey(item.name) === insertAfter)
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
      normalizeComparableName(sheet.worksheetName) !== "GUIA_CAMPOS_CNA" &&
      !isLookupWorksheet(sheet.worksheetName)
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

const hasUsableValue = (value) => value !== undefined && value !== null && value !== "";

const buildDownloadFileName = (template) => {
  const templateName = String(template?.name || "").trim();
  const extension = path.extname(String(template?.file_name || "").trim()) || ".xlsx";

  if (!templateName) {
    return `plantilla_cna${extension}`;
  }

  return `${templateName}${extension}`;
};

const sanitizeWorksheetName = (value, fallback = "Hoja") => {
  const cleaned = String(value || fallback)
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\\/*?:[\]]/g, " ")
    .replace(/^'+|'+$/g, "")
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
  const templateName = String(template?.name || "comparativo_cna").trim() || "comparativo_cna";
  return `${templateName}_comparativo_campos.xlsx`;
};

const buildAllComparisonsFileName = () => {
  const dateTag = new Date().toISOString().slice(0, 10);
  return `cna_comparativo_campos_${dateTag}.xlsx`;
};

const OPENXML_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
]);

const XLS_COMPOUND_FILE_SIGNATURE = "d0cf11e0a1b11ae1";
const ZIP_SIGNATURE = "504b0304";

const getBufferSignature = (buffer) =>
  Buffer.isBuffer(buffer) && buffer.length >= 8
    ? buffer.subarray(0, 8).toString("hex").toLowerCase()
    : "";

const isLegacyXlsBuffer = (buffer) => getBufferSignature(buffer).startsWith(XLS_COMPOUND_FILE_SIGNATURE);
const isZipWorkbookBuffer = (buffer) => getBufferSignature(buffer).startsWith(ZIP_SIGNATURE);

const isSupportedWorkbookExtension = (fileName = "") => {
  const extension = path.extname(String(fileName || "").trim()).toLowerCase();
  return extension === ".xlsx" || extension === ".xlsm";
};

const assertSupportedWorkbookFile = (file) => {
  const originalName = String(file?.originalname || "");
  const mimeType = String(file?.mimetype || "");

  if (!isSupportedWorkbookExtension(originalName)) {
    const error = new Error(
      "La plantilla CNA debe estar en formato .xlsx o .xlsm. Los archivos .xls no son compatibles."
    );
    error.statusCode = 400;
    throw error;
  }

  if (mimeType && !OPENXML_MIME_TYPES.has(mimeType)) {
    const error = new Error(
      "El archivo cargado no tiene un formato Excel Open XML valido (.xlsx o .xlsm)."
    );
    error.statusCode = 400;
    throw error;
  }
};

const assertSupportedWorkbookBuffer = (buffer, contextLabel = "La plantilla CNA") => {
  if (isLegacyXlsBuffer(buffer)) {
    const error = new Error(
      `${contextLabel} esta almacenada en formato .xls antiguo. Debes volver a cargarla como .xlsx para poder compararla o configurarla.`
    );
    error.statusCode = 400;
    throw error;
  }

  if (!isZipWorkbookBuffer(buffer)) {
    const error = new Error(
      `${contextLabel} no tiene un formato Excel Open XML valido (.xlsx o .xlsm).`
    );
    error.statusCode = 400;
    throw error;
  }
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
  if (Array.isArray(value.richText)) {
    return value.richText.map((item) => convertCellValue(item?.text)).join("");
  }
  if (value.hyperlink || value.text) return convertCellValue(value.text || value.hyperlink || "");
  if (value.result !== undefined) return convertCellValue(value.result);
  if (value.value !== undefined) return convertCellValue(value.value);
  if (value.$numberInt !== undefined) return value.$numberInt;
  if (value.$numberDouble !== undefined) return value.$numberDouble;
  if (value.error !== undefined) return "";
  return "";
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
    // Remove characters that are invalid in XML 1.0 / XLSX shared strings.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uD800-\uDFFF\uFFFE\uFFFF]/g, "")
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

const getValidatorOptions = (validator, preferredColumnName) => {
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

    // Para validadores de una sola columna con formato "CC Cédula de ciudadanía",
    // extraer solo el código inicial como valor almacenado.
    let storedValue = idText;
    if (!descKey) {
      const codeMatch = /^([A-Z0-9]{1,6})\s+.+$/.exec(idText);
      if (codeMatch) storedValue = codeMatch[1];
    }

    const seenKey = normalizeToken(storedValue);
    if (seen.has(seenKey)) return;

    const displayLabel = descText ? `${idText} ${descText}` : idText;
    seen.add(seenKey);
    options.push({ value: storedValue, displayLabel });
  });

  return options;
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
    const { headerRowNumber, headers } = extractWorksheetHeaders(worksheet);
    const commentsByRef = worksheetCommentsMap.get(worksheet.name) || new Map();
    const commentsByField = new Map();

    commentsByRef.forEach((commentText, cellRef) => {
      const parsedRef = parseCellReference(cellRef);
      if (!parsedRef || parsedRef.rowNumber !== headerRowNumber) {
        return;
      }

      const headerName = headers[parsedRef.columnNumber - 1];
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
    if (isInfoWorksheet(worksheet.name) || isGuideWorksheet(worksheet.name) || isLookupWorksheet(worksheet.name)) {
      return acc;
    }

    const { headerRowNumber, headers } = extractWorksheetHeaders(worksheet);
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

      sheetComments.push({
        ref: `${columnNumberToName(index + 1)}${headerRowNumber}`,
        text: commentText,
        columnNumber: index + 1,
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

const cleanRepeatedDropdownOptionsInWorkbook = async (workbookInput) => {
  const sourceBuffer = Buffer.isBuffer(workbookInput)
    ? Buffer.from(workbookInput)
    : fs.readFileSync(workbookInput);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(sourceBuffer);

  let changed = false;
  workbook.worksheets
    .filter((worksheet) => normalizeComparableName(worksheet.name) === "LISTAS")
    .forEach((worksheet) => {
      worksheet.eachRow({ includeEmpty: true }, (row) => {
        row.eachCell({ includeEmpty: true }, (cell) => {
          if (typeof cell.value !== "string") return;

          const cleanedValue = collapseRepeatedCompositeOption(cell.value);
          if (!cleanedValue || cleanedValue === cell.value) return;

          cell.value = cleanedValue;
          changed = true;
        });
      });
    });

  if (!changed) {
    return sourceBuffer;
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
};

const extractWorksheetHeaders = (worksheet) => {
  let bestRowNumber = 1;
  let bestHeaders = [];
  let bestScore = -1;
  const mergeLookup = buildWorksheetMergeLookup(worksheet);
  const maxScanRows = Math.min(120, worksheet.rowCount || 120);
  const maxColumnNumber = Math.min(200, Math.max(worksheet.columnCount || 0, 1));

  for (let rowNumber = 1; rowNumber <= maxScanRows; rowNumber += 1) {
    const rowHeaders = [];
    const seen = new Set();
    let styleCueCount = 0;
    let validationCueCount = 0;

    for (let columnNumber = 1; columnNumber <= maxColumnNumber; columnNumber += 1) {
      const { text, sourceRow, sourceColumn, spanColumns } = getMergedAwareCellValue(
        worksheet,
        mergeLookup,
        rowNumber,
        columnNumber
      );
      if (sourceRow !== rowNumber || sourceColumn !== columnNumber) {
        continue;
      }

      const label = cleanFieldLabel(text);
      if (!isLikelyHeaderLabel(label, spanColumns)) {
        continue;
      }

      const normalizedLabel = normalizeDropdownFieldKey(label);
      if (!normalizedLabel || seen.has(normalizedLabel)) {
        continue;
      }

      const cell = worksheet.getRow(sourceRow).getCell(sourceColumn);
      const hasBorder = Object.values(cell.border || {}).some(Boolean);
      const hasFill = Boolean(cell.fill?.type);
      const hasStyleCue = Boolean(cell.font?.bold || hasBorder || hasFill);

      if (hasStyleCue) styleCueCount += 1;
      if (cell.dataValidation?.type === "list") validationCueCount += 1;

      seen.add(normalizedLabel);
      rowHeaders.push(label);
    }

    if (rowHeaders.length === 0) {
      continue;
    }

    const longTextPenalty = rowHeaders.filter((header) => header.length > 80).length * 20;
    const singleCellPenalty = rowHeaders.length === 1 ? 10 : 0;
    const score =
      rowHeaders.length * 10 +
      styleCueCount * 3 +
      validationCueCount * 4 -
      longTextPenalty -
      singleCellPenalty;

    if (score > bestScore) {
      bestScore = score;
      bestHeaders = rowHeaders;
      bestRowNumber = rowNumber;
    }
  }

  return {
    headerRowNumber: bestRowNumber,
    headers: bestHeaders,
  };
};

const parseRangeReference = (rangeRef = "") => {
  const [startRef, endRef] = String(rangeRef).replace(/\$/g, "").split(":");
  const start = parseCellReference(startRef);
  const end = parseCellReference(endRef || startRef);

  if (!start || !end) {
    return null;
  }

  return {
    startRow: Math.min(start.rowNumber, end.rowNumber),
    endRow: Math.max(start.rowNumber, end.rowNumber),
    startColumn: Math.min(start.columnNumber, end.columnNumber),
    endColumn: Math.max(start.columnNumber, end.columnNumber),
  };
};

const normalizeDropdownFieldKey = (fieldName = "") =>
  normalizeFieldName(fieldName).replace(/^_+|_+$/g, "").replace(/_+/g, "_");

const cleanFieldLabel = (value = "") =>
  String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/^[_\s]+/g, "")
    .replace(/\s*:\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();

const cleanDropdownOptionLabel = (value = "") =>
  collapseRepeatedCompositeOption(cleanFieldLabel(value));

const splitInlineValidationList = (formula = "") => {
  const text = String(formula || "")
    .trim()
    .replace(/^=/, "")
    .replace(/^"|"$/g, "")
    .replace(/""/g, '"');

  if (!text || /^[A-Z_][A-Z0-9_]*$/i.test(text) || /!?\$?[A-Z]+\$?\d+/i.test(text)) {
    return [];
  }

  return text
    .split(/[;,]/)
    .map((item) => cleanDropdownOptionLabel(item))
    .filter(Boolean);
};

const parseFormulaRangeReference = (formula = "", fallbackSheetName = "") => {
  let text = String(formula || "").trim().replace(/^=/, "");
  if (!text || text.startsWith('"')) return null;

  let worksheetName = fallbackSheetName;
  let rangeRef = text;
  const bangIndex = text.lastIndexOf("!");
  if (bangIndex >= 0) {
    const rawSheetName = text.slice(0, bangIndex).trim();
    worksheetName = rawSheetName.replace(/^'|'$/g, "").replace(/''/g, "'");
    rangeRef = text.slice(bangIndex + 1);
  }

  rangeRef = rangeRef.replace(/\$/g, "").trim();
  if (!/^[A-Z]+\d+(:[A-Z]+\d+)?$/i.test(rangeRef)) return null;

  return { worksheetName, rangeRef };
};

const getFormulaRangeReferences = (workbook, worksheet, formula = "") => {
  const directRange = parseFormulaRangeReference(formula, worksheet.name);
  if (directRange) return [directRange];

  const definedName = String(formula || "").trim().replace(/^=/, "");
  if (!definedName || !workbook?.definedNames?.getRanges) return [];

  try {
    const definedRanges = workbook.definedNames.getRanges(definedName)?.ranges || [];
    return definedRanges
      .map((rangeRef) => parseFormulaRangeReference(rangeRef, worksheet.name))
      .filter(Boolean);
  } catch (error) {
    return [];
  }
};

const readOptionsFromRange = (workbook, worksheet, formula = "") => {
  const seen = new Set();
  const options = [];

  getFormulaRangeReferences(workbook, worksheet, formula).forEach(({ worksheetName, rangeRef }) => {
    const sourceWorksheet = workbook.getWorksheet(worksheetName);
    const parsedRange = parseRangeReference(rangeRef);
    if (!sourceWorksheet || !parsedRange) return;

    for (let row = parsedRange.startRow; row <= parsedRange.endRow; row += 1) {
      for (let column = parsedRange.startColumn; column <= parsedRange.endColumn; column += 1) {
        const label = cleanDropdownOptionLabel(convertCellValue(sourceWorksheet.getCell(row, column).value));
        if (!label || seen.has(label)) continue;
        seen.add(label);
        options.push(label);
      }
    }
  });

  return options;
};

const getValidationOptions = (workbook, worksheet, validation = {}) => {
  if (validation?.type !== "list") return [];

  const formulas = Array.isArray(validation.formulae) ? validation.formulae : [];
  const seen = new Set();
  const options = [];

  formulas.forEach((formula) => {
    const values = [
      ...splitInlineValidationList(formula),
      ...readOptionsFromRange(workbook, worksheet, formula),
    ];

    values.forEach((value) => {
      const label = cleanDropdownOptionLabel(value);
      if (!label || seen.has(label)) return;
      seen.add(label);
      options.push({ value: label, label });
    });
  });

  return options;
};

const getWorksheetListValidations = (worksheet) => {
  const validations = [];
  const model = worksheet.dataValidations?.model || {};

  Object.entries(model).forEach(([rangeRef, validation]) => {
    if (validation?.type !== "list") return;
    String(rangeRef)
      .split(/\s+/)
      .filter(Boolean)
      .forEach((singleRangeRef) => {
        const parsedRange = parseRangeReference(singleRangeRef);
        if (parsedRange) validations.push({ range: parsedRange, validation });
      });
  });

  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      if (!cell.dataValidation || cell.dataValidation.type !== "list") return;
      const key = `${rowNumber}:${columnNumber}`;
      const alreadyIncluded = validations.some(
        ({ range }) =>
          range.startRow <= rowNumber &&
          range.endRow >= rowNumber &&
          range.startColumn <= columnNumber &&
          range.endColumn >= columnNumber
      );
      if (alreadyIncluded) return;

      validations.push({
        range: {
          startRow: rowNumber,
          endRow: rowNumber,
          startColumn: columnNumber,
          endColumn: columnNumber,
        },
        validation: cell.dataValidation,
        key,
      });
    });
  });

  return validations;
};

const getNearbyValidationLabel = (worksheet, mergeLookup, rowNumber, columnNumber) => {
  for (let offset = 1; offset <= 5; offset += 1) {
    if (columnNumber - offset < 1) break;
    const { text } = getMergedAwareCellValue(worksheet, mergeLookup, rowNumber, columnNumber - offset);
    const label = cleanFieldLabel(text);
    if (label && isLikelyHeaderLabel(label)) return label;
  }

  for (let offset = 1; offset <= 3; offset += 1) {
    if (rowNumber - offset < 1) break;
    const { text } = getMergedAwareCellValue(worksheet, mergeLookup, rowNumber - offset, columnNumber);
    const label = cleanFieldLabel(text);
    if (label && isLikelyHeaderLabel(label)) return label;
  }

  return "";
};

const extractWorksheetDropdownOptions = (workbook, worksheet, detailedHeaders) => {
  const mergeLookup = buildWorksheetMergeLookup(worksheet);
  const optionsByField = new Map();
  const validations = getWorksheetListValidations(worksheet);

  const addOptions = (fieldName, options) => {
    const key = normalizeDropdownFieldKey(fieldName);
    if (!key || !Array.isArray(options) || options.length === 0) return;
    if (!optionsByField.has(key)) optionsByField.set(key, options);
  };

  validations.forEach(({ range, validation }) => {
    const options = getValidationOptions(workbook, worksheet, validation);
    if (options.length === 0) return;

    const sameColumnHeader = (detailedHeaders.fields || [])
      .filter(
        (field) =>
          field.columnNumber >= range.startColumn &&
          field.columnNumber <= range.endColumn &&
          field.rowNumber < range.startRow
      )
      .sort((a, b) => b.rowNumber - a.rowNumber)[0];
    if (sameColumnHeader?.name) addOptions(sameColumnHeader.name, options);
    if (sameColumnHeader?.baseName) addOptions(sameColumnHeader.baseName, options);

    const nearbyLabel = getNearbyValidationLabel(
      worksheet,
      mergeLookup,
      range.startRow,
      range.startColumn
    );
    if (nearbyLabel) addOptions(nearbyLabel, options);
  });

  return optionsByField;
};

const buildWorksheetMergeLookup = (worksheet) => {
  const mergeLookup = new Map();
  const mergeRanges = Array.isArray(worksheet.model?.merges) ? worksheet.model.merges : [];

  mergeRanges.forEach((rangeRef) => {
    const parsedRange = parseRangeReference(rangeRef);
    if (!parsedRange) {
      return;
    }

    for (let row = parsedRange.startRow; row <= parsedRange.endRow; row += 1) {
      for (let column = parsedRange.startColumn; column <= parsedRange.endColumn; column += 1) {
        mergeLookup.set(`${row}:${column}`, parsedRange);
      }
    }
  });

  return mergeLookup;
};

const getMergedAwareCellValue = (worksheet, mergeLookup, rowNumber, columnNumber) => {
  const mergeRange = mergeLookup.get(`${rowNumber}:${columnNumber}`);
  const sourceRow = mergeRange?.startRow || rowNumber;
  const sourceColumn = mergeRange?.startColumn || columnNumber;
  const rawValue = worksheet.getRow(sourceRow).getCell(sourceColumn).value;
  const text = String(convertCellValue(rawValue) || "").trim();

  return {
    text,
    sourceRow,
    sourceColumn,
    startRow: mergeRange?.startRow || rowNumber,
    endRow: mergeRange?.endRow || rowNumber,
    startColumn: mergeRange?.startColumn || columnNumber,
    endColumn: mergeRange?.endColumn || columnNumber,
    spanColumns: mergeRange ? mergeRange.endColumn - mergeRange.startColumn + 1 : 1,
    spanRows: mergeRange ? mergeRange.endRow - mergeRange.startRow + 1 : 1,
  };
};

const isLikelyHeaderLabel = (text = "", spanColumns = 1) => {
  const normalizedText = cleanFieldLabel(text);
  if (!normalizedText) {
    return false;
  }

  if (/^[-\u2013\u2014]+$/.test(normalizedText)) {
    return false;
  }

  if (/^[-\u2013\u2014]\s+/.test(normalizedText)) {
    return false;
  }

  if (/^tabla\s+\d+$/i.test(normalizedText)) {
    return false;
  }

  if (/^ejemplo\b/i.test(normalizedText)) {
    return false;
  }

  if (/^nota\s*\d*\s*[:.]/i.test(normalizedText)) {
    return false;
  }

  if (/^cuadro\s+\d+/i.test(normalizedText)) {
    return false;
  }

  if (/^proceso\s+de\s+acreditaci/i.test(normalizedText)) {
    return false;
  }

  if (normalizeComparableName(normalizedText) === "VERSION") {
    return false;
  }

  if (/^reemplace\b/i.test(normalizedText)) {
    return false;
  }

  if (/^\d+\s*[-.]\s+/.test(normalizedText)) {
    return false;
  }

  if (/^(esta plantilla|defina)\b/i.test(normalizedText)) {
    return false;
  }

  if (normalizedText.length > 140) {
    return false;
  }

  if (/^[\d.,\s]+%?$/.test(normalizedText)) {
    return false;
  }

  if (/^(I|II|III|IV|V|VI|VII|VIII|IX|X)$/i.test(normalizedText)) {
    return false;
  }

  const normalizedToken = normalizeToken(normalizedText);
  if (/^NOTA[\s_]*\d*/.test(normalizedToken)) {
    return false;
  }

  if (
    normalizedToken.includes("NO_DEBE_APARECER") ||
    normalizedToken.includes("SE_REFIERE_A") ||
    normalizedToken.includes("DILIGENCIA_EN_LA_PLATAFORMA")
  ) {
    return false;
  }

  if (spanColumns > 3 && normalizedToken.startsWith("INFORMACION")) {
    return false;
  }

  return true;
};

const FIELD_CONTEXT_SEPARATOR = " > ";

const isWorksheetChromeLabel = (label = "") => {
  const normalized = normalizeComparableName(label);
  return (
    /^CUADRO(_|$)/.test(normalized) ||
    normalized.includes("PROCESO_DE_ACREDITACION") ||
    normalized === "VERSION" ||
    normalized.startsWith("NOTA_")
  );
};

const isSummaryRowLabel = (label = "") => {
  const normalized = normalizeComparableName(label);
  return normalized === "PROMEDIO";
};

const isFillableContextLabel = (label = "") => {
  const normalized = normalizeComparableName(label);
  return (
    normalized.startsWith("LUGAR_DEL_CAMPUS") ||
    /^CAMPUS(_|\d|N$)/.test(normalized)
  );
};

const isRowScopedContextLabel = (candidate = {}) => {
  const normalized = normalizeComparableName(candidate.label);
  return (
    normalized.startsWith("LUGAR_DEL_CAMPUS") ||
    normalized.startsWith("COMUNIDAD_DE_")
  );
};

const isTopLevelSectionLabel = (label = "") => {
  const normalized = normalizeComparableName(label);
  return normalized.startsWith("COMUNIDAD_DE_");
};

const getHeaderCandidateCoverage = (candidate, sameRowCandidates = [], maxColumnNumber = 1) => {
  if (!isRowScopedContextLabel(candidate)) {
    return {
      startColumn: candidate.startColumn,
      endColumn: candidate.endColumn,
    };
  }

  const nextPeer = sameRowCandidates
    .filter(
      (item) =>
        item.columnNumber > candidate.columnNumber &&
        normalizeComparableName(item.label) !== normalizeComparableName(candidate.label) &&
        isRowScopedContextLabel(item)
    )
    .sort((a, b) => a.columnNumber - b.columnNumber)[0];

  return {
    startColumn: candidate.startColumn,
    endColumn: Math.max(candidate.endColumn, (nextPeer?.columnNumber || (maxColumnNumber + 1)) - 1),
  };
};

const isSameHeaderCandidate = (left = {}, right = {}) =>
  left.rowNumber === right.rowNumber &&
  left.columnNumber === right.columnNumber &&
  normalizeComparableName(left.label) === normalizeComparableName(right.label);

const hasHeaderChildCandidate = (candidate, candidates = []) =>
  candidates.some((child) => {
    if (child.rowNumber <= candidate.rowNumber || child.rowNumber > candidate.rowNumber + 4) {
      return false;
    }

    if (
      child.startColumn < candidate.startColumn ||
      child.endColumn > candidate.endColumn
    ) {
      return false;
    }

    return normalizeComparableName(child.label) !== normalizeComparableName(candidate.label);
  });

const findActiveContextCandidate = (fieldCandidate, candidatesByRow, maxColumnNumber) => {
  if (isFillableContextLabel(fieldCandidate.label)) {
    return null;
  }

  let activeContext = null;

  Array.from(candidatesByRow.entries())
    .filter(([rowNumber]) => rowNumber <= fieldCandidate.rowNumber)
    .sort(([rowA], [rowB]) => rowA - rowB)
    .forEach(([, rowCandidates]) => {
      rowCandidates.forEach((candidate) => {
        if (!isFillableContextLabel(candidate.label) || isSameHeaderCandidate(candidate, fieldCandidate)) {
          return;
        }

        const coverage = getHeaderCandidateCoverage(candidate, rowCandidates, maxColumnNumber);
        if (
          fieldCandidate.columnNumber < coverage.startColumn ||
          fieldCandidate.columnNumber > coverage.endColumn
        ) {
          return;
        }

        if (!activeContext || candidate.rowNumber >= activeContext.rowNumber) {
          activeContext = candidate;
        }
      });
    });

  return activeContext;
};

const dedupeContextLabels = (labels = []) => {
  const seen = new Set();
  return labels.filter((label) => {
    const normalized = normalizeComparableName(label);
    if (!normalized || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
    return true;
  });
};

const buildFieldGroupPath = (fieldCandidate, candidatesByRow, maxColumnNumber, allCandidates = []) => {
  const groups = [];
  const activeContext = findActiveContextCandidate(fieldCandidate, candidatesByRow, maxColumnNumber);

  Array.from(candidatesByRow.entries())
    .filter(([rowNumber]) => rowNumber < fieldCandidate.rowNumber)
    .sort(([rowA], [rowB]) => rowA - rowB)
    .forEach(([rowNumber, rowCandidates]) => {
      rowCandidates.forEach((candidate) => {
        if (
          candidate.rowNumber !== rowNumber ||
          isWorksheetChromeLabel(candidate.label) ||
          !isTopLevelSectionLabel(candidate.label)
        ) {
          return;
        }

        const coverage = getHeaderCandidateCoverage(candidate, rowCandidates, maxColumnNumber);
        if (
          fieldCandidate.columnNumber < coverage.startColumn ||
          fieldCandidate.columnNumber > coverage.endColumn
        ) {
          return;
        }

        if (normalizeComparableName(candidate.label) === normalizeComparableName(fieldCandidate.label)) {
          return;
        }

        groups.push(candidate.label);
      });
    });

  if (activeContext?.label) {
    groups.push(activeContext.label);
  }

  const parentSearchStartRow = activeContext?.rowNumber || 0;
  Array.from(candidatesByRow.entries())
    .filter(([rowNumber]) => rowNumber > parentSearchStartRow && rowNumber < fieldCandidate.rowNumber)
    .sort(([rowA], [rowB]) => rowA - rowB)
    .forEach(([, rowCandidates]) => {
      rowCandidates.forEach((candidate) => {
        if (
          isTopLevelSectionLabel(candidate.label) ||
          isFillableContextLabel(candidate.label) ||
          isSameHeaderCandidate(candidate, fieldCandidate) ||
          !hasHeaderChildCandidate(candidate, allCandidates)
        ) {
          return;
        }

        const coverage = getHeaderCandidateCoverage(candidate, rowCandidates, maxColumnNumber);
        if (
          fieldCandidate.columnNumber < coverage.startColumn ||
          fieldCandidate.columnNumber > coverage.endColumn
        ) {
          return;
        }

        groups.push(candidate.label);
      });
    });

  return dedupeContextLabels(groups);
};

const buildContextualFieldName = (fieldCandidate, groupPath) => {
  const pathParts = dedupeContextLabels([...(groupPath || []), fieldCandidate.label]);
  return pathParts.join(FIELD_CONTEXT_SEPARATOR);
};

const extractDetailedWorksheetHeaders = (worksheet) => {
  const maxHeaderScanRows = Math.min(120, worksheet.rowCount || 120);
  const mergeLookup = buildWorksheetMergeLookup(worksheet);
  const candidates = [];
  const candidatesByRow = new Map();
  const maxColumnNumber = Math.min(200, Math.max(worksheet.columnCount || 0, 1));

  for (let rowNumber = 1; rowNumber <= maxHeaderScanRows; rowNumber += 1) {
    for (let columnNumber = 1; columnNumber <= maxColumnNumber; columnNumber += 1) {
      const {
        text,
        sourceRow,
        sourceColumn,
        startColumn,
        endColumn,
        spanColumns,
        spanRows,
      } = getMergedAwareCellValue(
        worksheet,
        mergeLookup,
        rowNumber,
        columnNumber
      );
      if (sourceRow !== rowNumber || sourceColumn !== columnNumber) {
        continue;
      }

      const label = cleanFieldLabel(text);
      if (
        !isLikelyHeaderLabel(label, spanColumns) ||
        isWorksheetChromeLabel(label) ||
        isSummaryRowLabel(label)
      ) {
        continue;
      }

      const sourceCell = worksheet.getRow(sourceRow).getCell(sourceColumn);
      const hasBorder = Object.values(sourceCell.border || {}).some(Boolean);
      const hasFill = Boolean(sourceCell.fill?.type);
      const hasFieldCue = Boolean(sourceCell.font?.bold || hasBorder || hasFill || /:\s*$/.test(String(text)));
      if (!hasFieldCue && label.length > 60) {
        continue;
      }

      const normalizedLabel = normalizeDropdownFieldKey(label);
      if (!normalizedLabel) {
        continue;
      }

      const candidate = {
        label,
        rowNumber,
        columnNumber,
        sourceRow,
        sourceColumn,
        startColumn,
        endColumn,
        spanColumns,
        spanRows,
        cellRef: `${columnNumberToName(sourceColumn)}${sourceRow}`,
      };

      candidates.push(candidate);

      if (!candidatesByRow.has(rowNumber)) {
        candidatesByRow.set(rowNumber, []);
      }
      candidatesByRow.get(rowNumber).push(candidate);
    }
  }

  const rowCandidateCounts = new Map(
    Array.from(candidatesByRow.entries()).map(([rowNumber, rowCandidates]) => [
      rowNumber,
      rowCandidates.length,
    ])
  );

  const fieldCandidates = candidates.filter((candidate) => {
    const rowCandidateCount = rowCandidateCounts.get(candidate.rowNumber) || 0;
    const hasEnoughRowContext = rowCandidateCount >= 2 || isFillableContextLabel(candidate.label);
    if (!hasEnoughRowContext) {
      return false;
    }

    const hasChild = hasHeaderChildCandidate(candidate, candidates);
    if (hasChild && !isFillableContextLabel(candidate.label)) {
      return false;
    }

    return true;
  });

  const seen = new Map();
  const fields = fieldCandidates.map((candidate) => {
    const groupPath = buildFieldGroupPath(candidate, candidatesByRow, maxColumnNumber, candidates);
    const baseName = candidate.label;
    const displayName = buildContextualFieldName(candidate, groupPath);
    const normalizedDisplayName = normalizeDropdownFieldKey(displayName);
    const occurrence = (seen.get(normalizedDisplayName) || 0) + 1;
    seen.set(normalizedDisplayName, occurrence);
    const uniqueName = occurrence > 1
      ? `${displayName} (${candidate.cellRef})`
      : displayName;

    return {
      name: uniqueName,
      baseName,
      sourceName: baseName,
      groupPath,
      rowNumber: candidate.sourceRow,
      columnNumber: candidate.sourceColumn,
      cellRef: candidate.cellRef,
      spanColumns: candidate.spanColumns,
      spanRows: candidate.spanRows,
    };
  });

  return {
    headerRowNumber: fields[0]?.rowNumber || 1,
    headers: fields.map((field) => field.name),
    matchHeaders: fields.map((field) => field.baseName || field.name),
    fields,
  };
};

const cloneExcelStyle = (style = {}) => JSON.parse(JSON.stringify(style || {}));
const GUIDE_WORKSHEET_NAME = "GUIA_CAMPOS_CNA";
const LOOKUP_WORKSHEET_NAMES = new Set(["LISTAS", "MENU"]);
const isGuideWorksheet = (worksheetName = "") =>
  normalizeComparableName(worksheetName) === normalizeComparableName(GUIDE_WORKSHEET_NAME);
const isLookupWorksheet = (worksheetName = "") =>
  LOOKUP_WORKSHEET_NAMES.has(normalizeComparableName(worksheetName));

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
        if (sourceCell.dataValidation && Object.keys(sourceCell.dataValidation).length > 0) {
          targetCell.dataValidation = JSON.parse(JSON.stringify(sourceCell.dataValidation));
        }
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

  if (
    normalizedFields.length === 0 ||
    isInfoWorksheet(worksheet.name) ||
    isGuideWorksheet(worksheet.name) ||
    isLookupWorksheet(worksheet.name)
  ) {
    return;
  }

  const { headerRowNumber, headers } = extractWorksheetHeaders(worksheet);
  if (!headerRowNumber) {
    return;
  }

  const headerRow = worksheet.getRow(headerRowNumber);
  const currentHeaders = [...headers];
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
      ? insertAfterIndex + 2
      : currentHeaders.length + 1;

    worksheet.spliceColumns(insertColumnIndex, 0, []);

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

    currentHeaders.splice(insertColumnIndex - 1, 0, fieldName);
    normalizedHeaderNames.splice(insertColumnIndex - 1, 0, normalizedFieldName);
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

  if (
    normalizedFieldsToRemove.size === 0 ||
    isInfoWorksheet(worksheet.name) ||
    isGuideWorksheet(worksheet.name) ||
    isLookupWorksheet(worksheet.name)
  ) {
    return;
  }

  const { headers } = extractWorksheetHeaders(worksheet);
  for (let index = headers.length - 1; index >= 0; index -= 1) {
    const normalizedHeader = normalizeFieldName(headers[index]);
    if (normalizedFieldsToRemove.has(normalizedHeader)) {
      worksheet.spliceColumns(index + 1, 1);
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
    if (
      worksheet.name === sourcesSheetName ||
      isInfoWorksheet(worksheet.name) ||
      isGuideWorksheet(worksheet.name) ||
      isLookupWorksheet(worksheet.name)
    ) {
      return;
    }

    const { headerRowNumber, headers } = extractWorksheetHeaders(worksheet);
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
      const targetColumnIndex = fieldIndex + 1;
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
  assertSupportedWorkbookBuffer(sourceBuffer, "La plantilla CNA");
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
  assertSupportedWorkbookBuffer(sourceBuffer, "La plantilla CNA");
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
  assertSupportedWorkbookBuffer(templateBuffer, "La plantilla CNA");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer);
  workbook.worksheets.forEach((worksheet) => {
    removeConfiguredFieldsFromWorksheet(worksheet, (template.fields || []).filter((field) => field?.field_origin !== "snies_original"));
  });
  const workbookNotes = captureWorkbookNotes(workbook);
  const worksheets = workbook.worksheets.filter(
    (worksheet) => !isGuideWorksheet(worksheet.name) && !isLookupWorksheet(worksheet.name)
  );

  if (!worksheets[0]) {
    throw new Error("CNA template workbook has no worksheets");
  }

  const useWorksheetMapping = worksheets.length > 1;
  const mergedRows = enrichedSourceDatasets.flatMap((sourceTemplate) => sourceTemplate.rows);
  const equivalenceLookup = buildFieldEquivalenceLookup(template.field_equivalences);

  const sheetDatasets = worksheets.map((worksheet) => {
    const exportHeaderInfo = extractWorksheetHeaders(worksheet);
    const detailedHeaderInfo = extractDetailedWorksheetHeaders(worksheet);
    const headers = detailedHeaderInfo.headers.length
      ? detailedHeaderInfo.headers
      : exportHeaderInfo.headers;
    const headerFields = Array.isArray(detailedHeaderInfo.fields)
      ? detailedHeaderInfo.fields
      : [];
    const matchHeaders = detailedHeaderInfo.matchHeaders?.length
      ? detailedHeaderInfo.matchHeaders
      : headers;
    const headerRowNumber = detailedHeaderInfo.headerRowNumber || exportHeaderInfo.headerRowNumber;

    if (isInfoWorksheet(worksheet.name)) {
      return {
        worksheet,
        worksheetName: worksheet.name,
        headerRowNumber,
        headers,
        exportHeaderRowNumber: exportHeaderInfo.headerRowNumber,
        exportHeaders: exportHeaderInfo.headers,
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
        exportHeaderRowNumber: exportHeaderInfo.headerRowNumber,
        exportHeaders: exportHeaderInfo.headers,
        rows: [],
        sourceTemplate: null,
        preserveOriginalContent: false,
      };
    }

    const matchedSourceTemplate = useWorksheetMapping
      ? getWorksheetTemplateMatch(worksheet.name, matchHeaders, enrichedSourceDatasets)
      : null;
    const sourceRows = useWorksheetMapping
      ? matchedSourceTemplate?.rows || mergedRows
      : mergedRows;

    const normalizedHeaders = headers.map((header) => normalizeFieldName(header));
    const normalizedBaseHeaders = headers.map((header, index) =>
      normalizeFieldName(headerFields[index]?.baseName || header)
    );
    const finalRows = sourceRows.map((row) => {
      const normalizedRow = Object.entries(row).reduce((acc, [key, value]) => {
        acc[normalizeFieldName(key)] = value;
        return acc;
      }, {});

      return headers.reduce((acc, header, index) => {
        const normalizedHeader = normalizedHeaders[index];
        const normalizedBaseHeader = normalizedBaseHeaders[index];
        const directValue = normalizedRow[normalizedHeader] ?? normalizedRow[normalizedBaseHeader];
        const equivalentValue = [
          ...getEquivalentFieldMappings(equivalenceLookup, worksheet.name, header),
          ...getEquivalentFieldMappings(equivalenceLookup, worksheet.name, headerFields[index]?.baseName || ""),
        ]
          .map(({ fieldName, valueMappings }) =>
            applyValueMappings(normalizedRow[fieldName], valueMappings)
          )
          .find(hasUsableValue);
        const periodFallback = periodYear
          ? getPeriodValueForHeader(normalizedBaseHeader || normalizedHeader, periodValues)
          : undefined;

        acc[header] = hasUsableValue(directValue)
          ? directValue
          : equivalentValue ?? periodFallback ?? "";
        return acc;
      }, {});
    });

    return {
      worksheet,
      worksheetName: worksheet.name,
      headerRowNumber,
      headers,
      fieldDetails: headerFields,
      exportHeaderRowNumber: exportHeaderInfo.headerRowNumber,
      exportHeaders: exportHeaderInfo.headers,
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
  assertSupportedWorkbookBuffer(templateBuffer, "La plantilla CNA");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer);

  const sheetDatasets = workbook.worksheets.map((worksheet) => {
    const detailedHeaderInfo = extractDetailedWorksheetHeaders(worksheet);
    const { headers } = detailedHeaderInfo;
    const matchHeaders = detailedHeaderInfo.matchHeaders?.length
      ? detailedHeaderInfo.matchHeaders
      : headers;

    if (isInfoWorksheet(worksheet.name) || isLookupWorksheet(worksheet.name)) {
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
      ? getWorksheetTemplateMatch(worksheet.name, matchHeaders, normalizedSourceTemplates)
      : normalizedSourceTemplates[0] || null;

    return {
      worksheetName: worksheet.name,
      headers,
      fieldDetails: detailedHeaderInfo.fields || [],
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
    const sniesFieldDetails = Array.isArray(sheet.fieldDetails) ? sheet.fieldDetails : [];
    const miroFields = Array.isArray(sheet.sourceTemplate?.fieldNames)
      ? sheet.sourceTemplate.fieldNames
      : [];
    const totalRows = Math.max(sniesFields.length, miroFields.length, 1);

    worksheet.columns = [
      { width: 8 },
      { width: 38 },
      { width: 38 },
      { width: 10 },
      { width: 4 },
      { width: 8 },
      { width: 42 },
    ];

    worksheet.mergeCells("A1:D1");
    worksheet.mergeCells("F1:G1");
    worksheet.getCell("A1").value = "Campos CNA";
    worksheet.getCell("F1").value = "Campos Miro";
    worksheet.getCell("A2").value = "#";
    worksheet.getCell("B2").value = "Grupo CNA";
    worksheet.getCell("C2").value = "Campo CNA";
    worksheet.getCell("D2").value = "Celda";
    worksheet.getCell("F2").value = "#";
    worksheet.getCell("G2").value = "Campo Miro";

    for (let rowIndex = 0; rowIndex < totalRows; rowIndex += 1) {
      const excelRow = rowIndex + 3;
      const sniesField = sniesFields[rowIndex] || "";
      const sniesFieldDetail = sniesFieldDetails[rowIndex] || {};
      const miroField = miroFields[rowIndex] || "";
      const sniesGroupCell = worksheet.getCell(`B${excelRow}`);
      const sniesCell = worksheet.getCell(`C${excelRow}`);
      const sniesAddressCell = worksheet.getCell(`D${excelRow}`);
      const miroCell = worksheet.getCell(`G${excelRow}`);

      worksheet.getCell(`A${excelRow}`).value = sniesField ? rowIndex + 1 : "";
      sniesGroupCell.value = sanitizeExcelValue((sniesFieldDetail.groupPath || []).join(FIELD_CONTEXT_SEPARATOR));
      sniesCell.value = sanitizeExcelValue(sniesFieldDetail.baseName || sniesField);
      sniesAddressCell.value = sanitizeExcelValue(sniesFieldDetail.cellRef || "");
      worksheet.getCell(`F${excelRow}`).value = miroField ? rowIndex + 1 : "";
      miroCell.value = sanitizeExcelValue(miroField);

    }

    ["A1", "F1"].forEach((cellRef) => {
      const cell = worksheet.getCell(cellRef);
      cell.font = { bold: true, size: 12 };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    ["A2", "B2", "C2", "D2", "F2", "G2"].forEach((cellRef) => {
      const cell = worksheet.getCell(cellRef);
      cell.font = { bold: true };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    for (let rowNumber = 2; rowNumber <= totalRows + 2; rowNumber += 1) {
      applyFieldComparisonBorders(worksheet, rowNumber, ["A", "B", "C", "D", "F", "G"]);
    }

    worksheet.views = [{ state: "frozen", ySplit: 2 }];
  });
};

const appendConsolidatedFieldComparisonSheet = (workbook, template, dataset) => {
  const worksheet = workbook.addWorksheet(
    resolveUniqueWorksheetName(workbook, template.name, "Plantilla_CNA")
  );

  worksheet.columns = [
    { width: 24 },
    { width: 8 },
    { width: 38 },
    { width: 38 },
    { width: 10 },
    { width: 4 },
    { width: 8 },
    { width: 42 },
  ];

  let currentRow = 1;

  dataset.sheetDatasets.forEach((sheet, index) => {
    const sniesFields = Array.isArray(sheet.headers) ? sheet.headers : [];
    const sniesFieldDetails = Array.isArray(sheet.fieldDetails) ? sheet.fieldDetails : [];
    const miroFields = Array.isArray(sheet.sourceTemplate?.fieldNames)
      ? sheet.sourceTemplate.fieldNames
      : [];
    const totalRows = Math.max(sniesFields.length, miroFields.length, 1);
    const sectionStartRow = currentRow;
    const headerRow = sectionStartRow + 1;
    const subHeaderRow = sectionStartRow + 2;
    const dataStartRow = sectionStartRow + 3;
    const dataEndRow = dataStartRow + totalRows - 1;

    worksheet.mergeCells(`B${headerRow}:E${headerRow}`);
    worksheet.mergeCells(`G${headerRow}:H${headerRow}`);
    worksheet.getCell(`B${headerRow}`).value = "Campos CNA";
    worksheet.getCell(`G${headerRow}`).value = "Campos Miro";
    worksheet.getCell(`B${subHeaderRow}`).value = "#";
    worksheet.getCell(`C${subHeaderRow}`).value = "Grupo CNA";
    worksheet.getCell(`D${subHeaderRow}`).value = "Campo CNA";
    worksheet.getCell(`E${subHeaderRow}`).value = "Celda";
    worksheet.getCell(`G${subHeaderRow}`).value = "#";
    worksheet.getCell(`H${subHeaderRow}`).value = "Campo Miro";

    worksheet.mergeCells(`A${headerRow}:A${dataEndRow}`);
    const sectionCell = worksheet.getCell(`A${headerRow}`);
    sectionCell.value = sheet.worksheetName || `Hoja ${index + 1}`;
    sectionCell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    sectionCell.font = { bold: true, color: { argb: "FF1F1F1F" } };

    ["B", "G"].forEach((column) => {
      const cell = worksheet.getCell(`${column}${headerRow}`);
      cell.font = { bold: true, size: 12 };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    ["B", "C", "D", "E", "G", "H"].forEach((column) => {
      const cell = worksheet.getCell(`${column}${subHeaderRow}`);
      cell.font = { bold: true };
      cell.alignment = { horizontal: "center", vertical: "middle" };
    });

    for (let rowIndex = 0; rowIndex < totalRows; rowIndex += 1) {
      const excelRow = dataStartRow + rowIndex;
      const sniesField = sniesFields[rowIndex] || "";
      const sniesFieldDetail = sniesFieldDetails[rowIndex] || {};
      const miroField = miroFields[rowIndex] || "";
      const sniesGroupCell = worksheet.getCell(`C${excelRow}`);
      const sniesCell = worksheet.getCell(`D${excelRow}`);
      const sniesAddressCell = worksheet.getCell(`E${excelRow}`);
      const miroCell = worksheet.getCell(`H${excelRow}`);

      worksheet.getCell(`B${excelRow}`).value = sniesField ? rowIndex + 1 : "";
      sniesGroupCell.value = sanitizeExcelValue((sniesFieldDetail.groupPath || []).join(FIELD_CONTEXT_SEPARATOR));
      sniesCell.value = sanitizeExcelValue(sniesFieldDetail.baseName || sniesField);
      sniesAddressCell.value = sanitizeExcelValue(sniesFieldDetail.cellRef || "");
      worksheet.getCell(`G${excelRow}`).value = miroField ? rowIndex + 1 : "";
      miroCell.value = sanitizeExcelValue(miroField);


      applyFieldComparisonBorders(worksheet, excelRow, ["A", "B", "C", "D", "E", "G", "H"]);
    }

    applyFieldComparisonBorders(worksheet, headerRow, ["A", "B", "C", "D", "E", "G", "H"]);
    applyFieldComparisonBorders(worksheet, subHeaderRow, ["A", "B", "C", "D", "E", "G", "H"]);

    currentRow = dataEndRow + 2;
  });

  worksheet.views = [{ state: "frozen", ySplit: 3 }];
};

const buildFieldComparisonWorkbook = async (template, dataset) => {
  const workbook = new ExcelJS.Workbook();
  await appendFieldComparisonSheets(workbook, template, dataset);

  if (workbook.worksheets.length === 0) {
    const worksheet = workbook.addWorksheet("Resumen");
    worksheet.getCell("A1").value = "No se encontraron hojas comparables para esta plantilla CNA.";
  }

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

    const templates = await CnaTemplate.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize);

    const total = await CnaTemplate.countDocuments(query);

    return res.status(200).json({
      templates,
      total,
      page: pageNumber,
      pages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    console.error("Error fetching CNA templates:", error);
    return res.status(500).json({
      error: "Error fetching CNA templates",
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
    console.error("Error fetching CNA feed options:", error);
    return res.status(500).json({
      error: "Error fetching CNA feed options",
      details: error.message,
    });
  }
};

controller.getConnectedData = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await CnaTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "CNA template not found" });
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
        fieldDetails: sheet.fieldDetails || [],
        rows: sheet.rows,
        preserveOriginalContent: sheet.preserveOriginalContent,
      })),
    });
  } catch (error) {
    console.error("Error fetching CNA connected data:", error);
    return res.status(error.statusCode || 500).json({
      error: "Error fetching CNA connected data",
      details: error.message,
    });
  }
};

controller.downloadConnectedData = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await CnaTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "CNA template not found" });
    }

    const { workbook, sheetDatasets, workbookNotes, templateBuffer } = await buildSniesDataset(template);
    restoreWorkbookNotes(workbook, workbookNotes);

    const zip = new PizZip(templateBuffer);
    const worksheetXmlPathMap = getWorksheetXmlPathMap(zip);

    sheetDatasets.forEach(({
      worksheetName,
      headers,
      rows,
      headerRowNumber,
      exportHeaders,
      exportHeaderRowNumber,
      preserveOriginalContent,
    }) => {
      const hasContextualHeaders = Array.isArray(headers) && headers.some((header) =>
        String(header || "").includes(FIELD_CONTEXT_SEPARATOR)
      );
      const headersForExport = !hasContextualHeaders && Array.isArray(exportHeaders) && exportHeaders.length
        ? exportHeaders
        : headers;
      const headerRowForExport = exportHeaderRowNumber || headerRowNumber;

      if (preserveOriginalContent || !headersForExport.length) {
        return;
      }

      const worksheetPath = worksheetXmlPathMap[worksheetName];
      const worksheetFile = worksheetPath ? zip.file(worksheetPath) : null;
      if (!worksheetFile) {
        return;
      }

      const updatedWorksheetXml = rewriteWorksheetXml(
        worksheetFile.asText(),
        headersForExport,
        rows,
        headerRowForExport
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
    console.error("Error downloading CNA connected data:", error);
    return res.status(error.statusCode || 500).json({
      error: "Error downloading CNA connected data",
      details: error.message,
    });
  }
};

controller.downloadFieldComparison = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await CnaTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "CNA template not found" });
    }

    const previousFields = Array.isArray(template.fields) ? template.fields : [];

    const dataset = await buildSniesComparisonDataset(template);
    const comparisonWorkbook = await buildFieldComparisonWorkbook(template, dataset);
    // This workbook is generated from scratch with ExcelJS. Running the ZIP
    // artifact sanitizer here can strip required relationships and corrupt the
    // final XLSX file when Excel opens it.
    const outputBuffer = Buffer.from(await comparisonWorkbook.xlsx.writeBuffer());

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${buildComparisonFileName(template)}"; filename*=UTF-8''${encodeURIComponent(buildComparisonFileName(template))}`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    return res.send(outputBuffer);
  } catch (error) {
    console.error("Error downloading CNA field comparison:", error);
    return res.status(error.statusCode || 500).json({
      error: "Error downloading CNA field comparison",
      details: error.message,
    });
  }
};

controller.downloadAllFieldComparisons = async (req, res) => {
  try {
    const { email, periodId } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const templates = await CnaTemplate.find(periodId ? { period: periodId } : {})
      .sort({ createdAt: -1 });

    if (!templates.length) {
      return res.status(404).json({ error: "No CNA templates found" });
    }

    const workbook = new ExcelJS.Workbook();

    for (const template of templates) {
      const dataset = await buildSniesComparisonDataset(template);
      appendConsolidatedFieldComparisonSheet(workbook, template, dataset);
    }

    if (workbook.worksheets.length === 0) {
      const worksheet = workbook.addWorksheet("Resumen");
      worksheet.getCell("A1").value = "No se encontraron comparativos CNA para las plantillas consultadas.";
    }

    // This workbook is generated from scratch with ExcelJS. Running the ZIP
    // artifact sanitizer here can strip required relationships and corrupt the
    // final XLSX file when Excel opens it.
    const outputBuffer = Buffer.from(await workbook.xlsx.writeBuffer());

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${buildAllComparisonsFileName()}"; filename*=UTF-8''${encodeURIComponent(buildAllComparisonsFileName())}`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    return res.send(outputBuffer);
  } catch (error) {
    console.error("Error downloading all CNA field comparisons:", error);
    return res.status(error.statusCode || 500).json({
      error: "Error downloading all CNA field comparisons",
      details: error.message,
    });
  }
};

controller.downloadTemplateFile = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await CnaTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "CNA template not found" });
    }

    const fileBuffer = await downloadDriveFileBuffer(template.drive_file_id);
    const shouldRebuildWorkbook =
      (template.fields || []).some(fieldHasDropdownSource) ||
      await workbookHasHeaderCommentDropdowns(fileBuffer);
    const rebuiltBuffer = shouldRebuildWorkbook
      ? await buildWorkbookWithConfiguredFields(
          fileBuffer,
          template.fields || [],
          [],
          template.period || null
        )
      : fileBuffer;
    const downloadableBuffer = await cleanRepeatedDropdownOptionsInWorkbook(rebuiltBuffer);
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
    console.error("Error downloading CNA template file:", error);
    return res.status(500).json({
      error: "Error downloading CNA template file",
      details: error.message,
    });
  }
};

controller.getTemplateById = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await CnaTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "CNA template not found" });
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
        dropdown_options: normalizeDropdownOptionArray(field.dropdown_options),
        excel_validation_options: normalizeDropdownOptionArray(field.excel_validation_options),
        validator_options: normalizeDropdownOptionArray(field.validator_options),
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
    console.error("Error fetching CNA template by id:", error);
    return res.status(500).json({
      error: "Error fetching CNA template by id",
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

    assertSupportedWorkbookFile(req.file);

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
      "Formatos/Plantillas/CNA",
      uploadFile.originalname
    );

    const template = new CnaTemplate({
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
      message: "CNA template created",
      template,
    });
  } catch (error) {
    console.error("Error creating CNA template:", error);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(error.statusCode || 500).json({
      error: "Error creating CNA template",
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

    const template = await CnaTemplate.findById(id);
    if (!template) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(404).json({ error: "CNA template not found" });
    }

    if (req.file) {
      assertSupportedWorkbookFile(req.file);
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
      template.markModified("field_equivalences");
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
      message: "CNA template updated",
      template,
    });
  } catch (error) {
    console.error("Error updating CNA template:", error);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    cleanupTemporaryExcelUpload(tempUploadFile);
    return res.status(error.statusCode || 500).json({
      error: "Error updating CNA template",
      details: error.message,
    });
  }
};

controller.deleteTemplate = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const template = await CnaTemplate.findById(id);
    if (!template) {
      return res.status(404).json({ error: "CNA template not found" });
    }

    if (template.drive_file_id) {
      await deleteDriveFile(template.drive_file_id);
    }

    await CnaTemplate.findByIdAndDelete(id);

    return res.status(200).json({ message: "CNA template deleted" });
  } catch (error) {
    console.error("Error deleting CNA template:", error);
    return res.status(500).json({
      error: "Error deleting CNA template",
      details: error.message,
    });
  }
};

module.exports = controller;
