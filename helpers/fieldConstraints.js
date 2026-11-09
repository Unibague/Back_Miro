const { applyTemplateValidationPolicy, isNoApplyField, isInternationalEntityField, isCountryCodeField, isCooperationFlag } = require('./templateValidationPolicy');

const normalizeText = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .trim();

const normalizeContentType = (value) => ({
  alfabetico: 'alphabetic',
  alphabetic: 'alphabetic',
  numerico: 'numeric',
  numeric: 'numeric',
  alfanumerico: 'alphanumeric',
  alphanumeric: 'alphanumeric',
}[normalizeText(value).toLowerCase()] || '');

// SNIES usa comentarios como "Obligatorio, alfabético (50).". El número
// entre paréntesis es la longitud máxima del campo, medida en caracteres.
const parseCommentConstraints = (comment = '') => {
  const match = normalizeText(comment).match(
    /\b(alfabetico|alfanumerico|numerico)\s*\(\s*(\d+)\s*\)/i
  );
  if (!match) return {};
  const maxLength = Number(match[2]);
  return {
    content_type: normalizeContentType(match[1]),
    ...(Number.isSafeInteger(maxLength) && maxLength > 0 ? { max_length: maxLength } : {}),
  };
};

const optionalNumber = (value) => {
  if (value === '' || value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const getFieldConstraints = (field = {}) => {
  const fromComment = parseCommentConstraints(field.comment);
  const maxLength = optionalNumber(field.max_length);
  const datatypeDefault = field.datatype === 'Texto Corto' ? 60 : (field.datatype === 'Texto Largo' ? 800 : undefined);
  return {
    content_type: normalizeContentType(field.content_type) || fromComment.content_type || '',
    max_length: Number.isSafeInteger(maxLength) && maxLength > 0
      ? maxLength
      : (fromComment.max_length || datatypeDefault),
    min_value: optionalNumber(field.min_value),
    max_value: optionalNumber(field.max_value),
    integer_only: Boolean(field.integer_only),
  };
};

const isStrictDate = (value) => {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  const text = String(value ?? '').trim();
  let year;
  let month;
  let day;
  let match = text.match(/^(\d{2})\/(\d{2})\/(\d{4}|\d{2})$/);
  if (match) {
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
    if (match[3].length === 2) year += 2000;
  } else {
    match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/);
    if (!match) return false;
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    && (!text.includes('T') || !Number.isNaN(Date.parse(text)));
};

const validateFieldValue = (field = {}, value, { hasDropdown = false } = {}) => {
  if (value === null || value === undefined || String(value).trim() === '') return [];
  field = applyTemplateValidationPolicy(field);
  const text = String(value).trim();
  if (isNoApplyField(field) && text === '0') return [];
  if (isCooperationFlag(field)) return /^[SN]$/.test(text) ? [] : ['solo admite S (Sí) o N (No)'];
  if (isCountryCodeField(field) && !/^\d+$/.test(text)
    && !(hasDropdown && /^\d+\s+-\s+\S/.test(text))) return ['debe contener únicamente dígitos'];
  // Las etiquetas de listas no están sujetas al largo o tipo del código SNIES.
  // Las reglas de negocio anteriores también se verifican si existe una lista.
  if (hasDropdown && field.datatype !== 'Fecha'
    && !(isInternationalEntityField(field) && text.toUpperCase() === 'N/A')) return [];
  if (field.datatype === 'Fecha') return isStrictDate(value) ? [] : ['debe ser una fecha válida en formato DD/MM/AAAA o DD/MM/AA'];
  const constraints = getFieldConstraints(field);
  const errors = [];

  if (constraints.max_length && text.length > constraints.max_length) {
    errors.push(`supera el máximo de ${constraints.max_length} caracteres`);
  }
  // Los textos admiten puntuación y símbolos, incluidas tildes descompuestas.
  // "Alfabético" conserva la restricción de no incluir números.
  if (constraints.content_type === 'alphabetic' && !/^[\p{L}\p{M}\p{P}\p{S}\s]+$/u.test(text)) {
    errors.push('debe contener letras, espacios o signos de puntuación, sin números');
  } else if (constraints.content_type === 'numeric' && !/^\d+$/.test(text)) {
    errors.push('debe contener únicamente dígitos');
  } else if (constraints.content_type === 'alphanumeric' && !/^[\p{L}\p{M}\p{N}\p{P}\p{S}\s]+$/u.test(text)) {
    errors.push('debe contener letras, números, espacios o signos de puntuación');
  }

  const datatype = String(field.datatype || '');
  if (datatype === 'Entero' && !/^-?\d+$/.test(text)) errors.push('debe ser un número entero');
  if (datatype === 'Decimal' || datatype === 'Porcentaje') {
    const number = typeof value === 'number' ? value : Number(text.replace(',', '.'));
    if (!Number.isFinite(number)) errors.push('debe ser un número válido');
    else {
      if (datatype === 'Porcentaje' && (number < 0 || number > 100)) errors.push('debe estar entre 0 y 100');
      if (constraints.integer_only && !Number.isInteger(number)) errors.push('debe ser un número entero');
      if (constraints.min_value !== undefined && number < constraints.min_value) errors.push(`debe ser mayor o igual a ${constraints.min_value}`);
      if (constraints.max_value !== undefined && number > constraints.max_value) errors.push(`debe ser menor o igual a ${constraints.max_value}`);
    }
  }
  if (datatype === 'Fecha' && !isStrictDate(value)) {
    errors.push('debe ser una fecha válida en formato DD/MM/AAAA');
  }
  if (datatype === 'Fecha Inicial / Fecha Final') {
    const dates = Array.isArray(value) ? value : [];
    if (dates.length !== 2 || !dates.every(isStrictDate)) {
      errors.push('debe contener una fecha inicial y una fecha final válidas');
    } else {
      const toTimestamp = (dateValue) => {
        if (dateValue instanceof Date) return dateValue.getTime();
        const parts = String(dateValue).split('/');
        if (parts.length === 3) return Date.UTC(Number(parts[2]) + (parts[2].length === 2 ? 2000 : 0), Number(parts[1]) - 1, Number(parts[0]));
        return new Date(dateValue).getTime();
      };
      if (toTimestamp(dates[0]) > toTimestamp(dates[1])) errors.push('debe tener la fecha inicial antes de la fecha final');
    }
  }
  if (datatype === 'Link' && !/^https?:\/\/\S+$/i.test(text)) {
    errors.push('debe ser un enlace http o https válido');
  }
  return [...new Set(errors)];
};

const normalizeKey = (value) => normalizeText(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
const isColombiaCode = (value) => {
  const match = String(value ?? '').trim().match(/^(\d+)(?:\s*[-.:)]\s+.*)?$/);
  return Boolean(match && Number(match[1]) === 170);
};

const validateDatasetRules = ({ templateName = '', fields = [], rows = [], sheetName } = {}) => {
  const results = [];
  const addError = (column, register, value, message) => {
    let result = results.find((item) => item.column === column);
    if (!result) {
      result = { status: false, column, errors: [], ...(sheetName ? { sheet_name: sheetName } : {}) };
      results.push(result);
    }
    result.errors.push({ register, value: value ?? 'Sin valor', message });
  };

  const groups = new Map();
  fields.forEach((field) => {
    const explicitGroup = String(field.percentage_group || '').trim();
    const autoGroup = normalizeKey(field.name).startsWith('PORCENTAJE_') ? '__PORCENTAJES__' : '';
    const group = explicitGroup || autoGroup;
    if (!group) return;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(field);
  });

  groups.forEach((groupFields) => {
    if (groupFields.length < 2) return;
    rows.forEach((row, index) => {
      let sum = 0;
      let hasValue = false;
      groupFields.forEach((field) => {
        const rawValue = row?.[field.name];
        if (rawValue === '' || rawValue === null || rawValue === undefined) return;
        const number = Number(String(rawValue).replace(',', '.'));
        if (!Number.isFinite(number)) return;
        hasValue = true;
        sum += number;
        if (!Number.isInteger(number)) {
          addError(field.name, index + 1, rawValue, `El porcentaje de "${field.name}" debe ser un número entero (fila ${index + 1})`);
        }
      });
      if (hasValue && sum > 100) {
        addError(groupFields[0].name, index + 1, sum, `La suma de porcentajes es ${sum} y no puede superar 100 (fila ${index + 1})`);
      }
    });
  });

  const fieldByKey = new Map(fields.map((field) => [normalizeKey(field.name), field]));
  const countryField = fieldByKey.get('ID_PAIS_EXTRANJERO');
  // El significado de ID_PAIS_EXTRANJERO no depende del nombre comercial de
  // la plantilla ni de si la hoja se llama MOV_ESTUD_HACIA_COLOMBIA.
  if (countryField) {
    rows.forEach((row, index) => {
      if (isColombiaCode(row?.[countryField.name])) {
        addError(countryField.name, index + 1, row[countryField.name], `El país 170 (Colombia) no es válido para movilidad internacional (fila ${index + 1})`);
      }
    });
  }

  const idField = fields.find((field) => ['NUM_DOCUMENTO', 'NUMERO_DOCUMENTO', 'DOCUMENTO', 'IDENTIFICACION'].includes(normalizeKey(field.name)));
  const typeField = fields.find((field) => ['ID_TIPO_DOCUMENTO', 'TIPO_DOCUMENTO', 'TIPO_DE_DOCUMENTO'].includes(normalizeKey(field.name)));
  if (idField && typeField) {
    const typeByIdentification = new Map();
    rows.forEach((row, index) => {
      const identification = String(row?.[idField.name] ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
      const documentType = String(row?.[typeField.name] ?? '').trim().toUpperCase().split(/\s+-\s+|\s+/)[0];
      if (!identification || !documentType) return;
      const previous = typeByIdentification.get(identification);
      if (previous && previous !== documentType) {
        addError(typeField.name, index + 1, documentType, `El documento ${identification} ya fue registrado con otro tipo de documento (fila ${index + 1})`);
      } else typeByIdentification.set(identification, documentType);
    });
  }

  return results;
};

module.exports = { getFieldConstraints, isStrictDate, normalizeContentType, parseCommentConstraints, validateDatasetRules, validateFieldValue };
