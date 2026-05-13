const fs = require("fs/promises");
const path = require("path");
const axios = require("axios");
const ExcelJS = require("exceljs");

const PublishedTemplate = require("../models/publishedTemplates");
const Student = require("../models/students");
const User = require("../models/users");
const ValidatorModel = require("../models/validators");

const controller = {};

const GENERATED_COLUMNS = [
  "NOMBRE_IDENTIFICADO",
  "FUENTE_PERSONA",
  "TIPO_APOYO_DETECTADO",
  "NOMBRE_APOYO_DETECTADO",
  "APOYOS_OTROS_PERIODOS",
  "PERIODOS_APOYO_PREVIO",
  "PLANTILLAS_APOYO_PREVIO",
  "ESTADO_CRUCE",
];

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
]);

const normalizeHeader = (value = "") =>
  String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

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

const buildValidatorLookup = async () => {
  const validators = await ValidatorModel.find({}).lean();

  return validators
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
  if (!sampleValues.length) return false;
  if (["NUM_DOCUMENTO", "NUMERO_DOCUMENTO", "NRO_DOCUMENTO", "NO_DOCUMENTO", "DOCUMENTO"].includes(normalized)) {
    return false;
  }
  if (normalized.includes("NUM_DOCUMENTO") || normalized.includes("NUMERO_DOCUMENTO")) return false;
  if (normalized.includes("HORAS") || normalized.includes("VALOR") || normalized.includes("CANTIDAD")) return false;

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
    normalized.includes("PAIS")
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

const putPerson = (map, identification, payload, priority) => {
  const id = normalizeId(identification);
  const name = getPersonName(payload);
  if (!id || !name) return;

  const current = map.get(id);
  if (!current || priority > current.priority) {
    map.set(id, {
      identification: id,
      name,
      email: payload.email || payload.correo || "",
      program: payload.program || payload.programa || "",
      source: payload.source,
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

  studentsDb.forEach((student) => putPerson(people, student.identification, { ...student, source: "ICEBERG/BD" }, 40));
  studentsApi.forEach((student) => putPerson(people, student.identification, { ...student, source: "ICEBERG" }, 35));
  usersDb.forEach((user) => putPerson(people, user.identification, { ...user, source: "SIGA/BD" }, 30));
  usersApi.forEach((user) => putPerson(people, user.identification, { ...user, source: "SIGA" }, 25));

  return people;
};

const getFieldKind = (fieldName) => {
  const normalized = normalizeHeader(fieldName);
  if (normalized.includes("TIPO_DOCUMENTO") || normalized.includes("TIPO_DE_DOCUMENTO")) return null;
  if (ID_ALIASES.has(normalized)) return "identification";
  if (normalized.includes("IDENTIFICACION") || normalized.includes("CEDULA") || normalized.includes("DOCUMENTO")) {
    return "identification";
  }
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

  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    const error = new Error("La plantilla no contiene hojas para procesar.");
    error.status = 400;
    throw error;
  }

  const headerRow = worksheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, column) => {
    const name = cellToText(cell.value).trim();
    if (name) headers.push({ column, name, normalized: normalizeHeader(name) });
  });

  if (headers.length === 0) {
    const error = new Error("La primera fila debe contener encabezados.");
    error.status = 400;
    throw error;
  }

  const idHeader = findHeaderByKind(headers, "identification");
  if (!idHeader) {
    const error = new Error("No se encontro una columna de cedula o numero de documento.");
    error.status = 400;
    throw error;
  }

  const fieldMap = {
    identification: idHeader,
    personName: findHeaderByKind(headers, "personName"),
    supportType: findHeaderByKind(headers, "supportType"),
    supportName: findHeaderByKind(headers, "supportName"),
    supportDescription: findHeaderByKind(headers, "supportDescription"),
    supportValue: findHeaderByKind(headers, "supportValue"),
  };

  const rows = [];
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const excelRow = worksheet.getRow(rowNumber);
    const valuesByColumn = {};
    let hasValue = false;

    headers.forEach((header) => {
      const value = excelRow.getCell(header.column).value;
      valuesByColumn[header.column] = value;
      if (!isBlank(value)) hasValue = true;
    });

    if (!hasValue) continue;

    rows.push({
      rowNumber,
      valuesByColumn,
    });
  }

  return { workbook, worksheet, headers, fieldMap, rows };
};

const buildValidatorColumns = async (headers, rows) => {
  const validators = await buildValidatorLookup();
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
    let suffix = 2;
    while (usedOutputNames.has(normalizeHeader(outputColumn))) {
      outputColumn = `DESC_${normalizeHeader(header.name)}_${suffix}`;
      suffix += 1;
    }
    usedOutputNames.add(normalizeHeader(outputColumn));

    columns.push({
      sourceField: header.name,
      sourceColumn: header.column,
      outputColumn,
      validatorName: validator.name,
      validatorColumn: validator.idColumnName,
      descriptionColumn: validator.descriptionColumnName,
      valueMap: validator.valueMap,
    });
  });

  return columns;
};

const buildEnrichedRows = async ({ rows, fieldMap, periodId, validatorColumns }) => {
  const identifications = rows.map((row) => normalizeId(getRecordValue(row, fieldMap.identification))).filter(Boolean);
  const [peopleMap, supportHistory] = await Promise.all([
    buildPeopleMap(identifications),
    buildSupportHistory(periodId),
  ]);

  let personsFound = 0;
  let withPreviousSupport = 0;

  const enrichedRows = rows.map((row) => {
    const identification = normalizeId(getRecordValue(row, fieldMap.identification));
    const person = identification ? peopleMap.get(identification) : null;
    const history = identification ? supportHistory.get(identification) || [] : [];

    const validatorDescriptions = {};
    (validatorColumns || []).forEach((validatorColumn) => {
      const rawValue = row.valuesByColumn[validatorColumn.sourceColumn];
      const key = normalizeLookupValue(rawValue);
      const description = validatorColumn.valueMap.get(key) || "";
      if (description) {
        validatorDescriptions[validatorColumn.outputColumn] = `${cellToText(rawValue).trim()} - ${description}`;
      }
    });

    const supportType = getRecordValue(row, fieldMap.supportType);
    const supportName = getRecordValue(row, fieldMap.supportName);
    const detectedSupport = supportName || supportType || firstValue(history.map((item) => item.supportName || item.supportType));

    if (person) personsFound += 1;
    if (history.length > 0) withPreviousSupport += 1;

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
      nombre_identificado: person?.name || getRecordValue(row, fieldMap.personName),
      fuente_persona: person?.source || "",
      tipo_apoyo_detectado: supportType || firstValue(history.map((item) => item.supportType)),
      nombre_apoyo_detectado: detectedSupport,
      apoyos_otros_periodos: compactUnique(history.map((item) => item.supportName || item.supportType)).join(" | "),
      periodos_apoyo_previo: compactUnique(history.map((item) => item.period)).join(" | "),
      plantillas_apoyo_previo: compactUnique(history.map((item) => item.templateName)).join(" | "),
      estado_cruce: status,
      _history_count: history.length,
      validadores_resueltos: validatorDescriptions,
    };
  });

  const resolvedValidatorValues = enrichedRows.reduce(
    (count, row) => count + Object.keys(row.validadores_resueltos || {}).length,
    0
  );

  return {
    enrichedRows,
    summary: {
      totalRows: rows.length,
      withIdentification: identifications.length,
      personsFound,
      withPreviousSupport,
      withoutMatches: enrichedRows.filter((row) => row.estado_cruce === "NO_IDENTIFICADO").length,
      validatorColumns: (validatorColumns || []).length,
      resolvedValidatorValues,
    },
  };
};

const applyGeneratedColumns = (worksheet, enrichedRows, validatorColumns = []) => {
  const headerRow = worksheet.getRow(1);
  const existingHeaders = new Map();
  headerRow.eachCell({ includeEmpty: false }, (cell, column) => {
    existingHeaders.set(normalizeHeader(cellToText(cell.value)), column);
  });

  let nextColumn = worksheet.columnCount + 1;
  const columnByName = {};

  [...GENERATED_COLUMNS, ...validatorColumns.map((item) => item.outputColumn)].forEach((columnName) => {
    const normalized = normalizeHeader(columnName);
    if (existingHeaders.has(normalized)) {
      columnByName[columnName] = existingHeaders.get(normalized);
    } else {
      columnByName[columnName] = nextColumn;
      headerRow.getCell(nextColumn).value = columnName;
      headerRow.getCell(nextColumn).font = { ...(headerRow.getCell(1).font || {}), bold: true };
      nextColumn += 1;
    }
  });

  enrichedRows.forEach((enriched) => {
    const row = worksheet.getRow(enriched.row_number);
    row.getCell(columnByName.NOMBRE_IDENTIFICADO).value = enriched.nombre_identificado || "";
    row.getCell(columnByName.FUENTE_PERSONA).value = enriched.fuente_persona || "";
    row.getCell(columnByName.TIPO_APOYO_DETECTADO).value = enriched.tipo_apoyo_detectado || "";
    row.getCell(columnByName.NOMBRE_APOYO_DETECTADO).value = enriched.nombre_apoyo_detectado || "";
    row.getCell(columnByName.APOYOS_OTROS_PERIODOS).value = enriched.apoyos_otros_periodos || "";
    row.getCell(columnByName.PERIODOS_APOYO_PREVIO).value = enriched.periodos_apoyo_previo || "";
    row.getCell(columnByName.PLANTILLAS_APOYO_PREVIO).value = enriched.plantillas_apoyo_previo || "";
    row.getCell(columnByName.ESTADO_CRUCE).value = enriched.estado_cruce || "";
    validatorColumns.forEach((validatorColumn) => {
      row.getCell(columnByName[validatorColumn.outputColumn]).value =
        enriched.validadores_resueltos?.[validatorColumn.outputColumn] || "";
    });
    row.commit();
  });

  Object.values(columnByName).forEach((columnIndex) => {
    worksheet.getColumn(columnIndex).width = Math.max(22, worksheet.getColumn(columnIndex).width || 0);
  });

  headerRow.commit();
};

const processFile = async (req) => {
  const periodId = req.body.period_id || req.body.periodId || null;
  const parsed = await readUploadedWorkbook(req.file);
  const validatorColumns = await buildValidatorColumns(parsed.headers, parsed.rows);
  const result = await buildEnrichedRows({
    rows: parsed.rows,
    fieldMap: parsed.fieldMap,
    periodId,
    validatorColumns,
  });

  return { ...parsed, ...result, validatorColumns };
};

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
    const result = await processFile(req);
    res.json({
      sheetName: result.worksheet.name,
      columnsAdded: [...GENERATED_COLUMNS, ...result.validatorColumns.map((item) => item.outputColumn)],
      validatorColumns: result.validatorColumns.map((item) => ({
        sourceField: item.sourceField,
        outputColumn: item.outputColumn,
        validatorName: item.validatorName,
        validatorColumn: item.validatorColumn,
        descriptionColumn: item.descriptionColumn,
      })),
      summary: result.summary,
      rows: result.enrichedRows.slice(0, 100),
    });
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || "No fue posible procesar la plantilla." });
  } finally {
    await cleanupFile(req.file);
  }
};

controller.download = async (req, res) => {
  try {
    const result = await processFile(req);
    applyGeneratedColumns(result.worksheet, result.enrichedRows, result.validatorColumns);

    const buffer = await result.workbook.xlsx.writeBuffer();
    const originalName = path.basename(req.file.originalname || "plantilla.xlsx", path.extname(req.file.originalname || ""));
    const filename = `${originalName}_cruzada_siga_iceberg.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (error) {
    res.status(error.status || 500).json({ message: error.message || "No fue posible generar la plantilla enriquecida." });
  } finally {
    await cleanupFile(req.file);
  }
};

module.exports = controller;
