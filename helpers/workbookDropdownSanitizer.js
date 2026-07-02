const fs = require("fs");
const ExcelJS = require("exceljs");
const {
  collapseRepeatedCompositeOption,
  normalizeOptionKey,
} = require("./dropdownOptions");

const normalizeComparableName = (value = "") =>
  String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

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

const splitBase64Value = (value = "") => {
  const text = String(value || "").trim();
  const dataUrlMatch = text.match(/^(data:[^,]+;base64,)([\s\S]+)$/i);

  if (dataUrlMatch) {
    return {
      prefix: dataUrlMatch[1],
      payload: dataUrlMatch[2],
    };
  }

  return {
    prefix: "",
    payload: text,
  };
};

const cleanRepeatedDropdownOptionsInWorkbookBase64 = async (value) => {
  if (typeof value !== "string" || !value.trim()) return value;

  try {
    const { prefix, payload } = splitBase64Value(value);
    const sourceBuffer = Buffer.from(payload, "base64");
    const cleanedBuffer = await cleanRepeatedDropdownOptionsInWorkbook(sourceBuffer);

    if (Buffer.compare(sourceBuffer, cleanedBuffer) === 0) {
      return value;
    }

    return `${prefix}${cleanedBuffer.toString("base64")}`;
  } catch (error) {
    return value;
  }
};

const normalizeDropdownOptionArray = (value) => {
  if (!Array.isArray(value)) return [];

  const seen = new Set();

  return value.flatMap((option) => {
    const normalizedOption = typeof option === "string"
      ? collapseRepeatedCompositeOption(option)
      : option;
    if (typeof normalizedOption === "string" && !normalizedOption.trim()) return [];

    const key = typeof normalizedOption === "string"
      ? normalizeOptionKey(normalizedOption)
      : JSON.stringify(normalizedOption);
    if (!key || seen.has(key)) return [];

    seen.add(key);
    return [normalizedOption];
  });
};

const sanitizeFieldDropdownOptions = (field) => {
  if (!field || typeof field !== "object") return field;

  return {
    ...field,
    dropdown_options: normalizeDropdownOptionArray(field.dropdown_options),
    excel_validation_options: normalizeDropdownOptionArray(field.excel_validation_options),
    validator_options: normalizeDropdownOptionArray(field.validator_options),
  };
};

const sanitizeTemplateDropdownPayload = async (template = {}) => {
  if (!template || typeof template !== "object") return template;

  const plainTemplate = typeof template.toObject === "function" ? template.toObject() : template;
  const sanitizedTemplate = { ...plainTemplate };

  if (Array.isArray(plainTemplate.fields)) {
    sanitizedTemplate.fields = plainTemplate.fields.map(sanitizeFieldDropdownOptions);
  }

  if (Array.isArray(plainTemplate.workbook_sheets)) {
    sanitizedTemplate.workbook_sheets = plainTemplate.workbook_sheets.map((sheet) => ({
      ...sheet,
      fields: Array.isArray(sheet?.fields)
        ? sheet.fields.map(sanitizeFieldDropdownOptions)
        : sheet?.fields,
    }));
  }

  if (plainTemplate.original_workbook_base64 !== undefined) {
    sanitizedTemplate.original_workbook_base64 = await cleanRepeatedDropdownOptionsInWorkbookBase64(
      plainTemplate.original_workbook_base64
    );
  }

  return sanitizedTemplate;
};

module.exports = {
  cleanRepeatedDropdownOptionsInWorkbook,
  cleanRepeatedDropdownOptionsInWorkbookBase64,
  normalizeDropdownOptionArray,
  sanitizeTemplateDropdownPayload,
};
