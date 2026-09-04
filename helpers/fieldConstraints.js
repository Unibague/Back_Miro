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
  let match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    day = Number(match[1]); month = Number(match[2]); year = Number(match[3]);
  } else {
    match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
    if (!match) return false;
    year = Number(match[1]); month = Number(match[2]); day = Number(match[3]);
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};

const validateFieldValue = (field = {}, value) => {
  if (value === null || value === undefined || String(value).trim() === '') return [];
  const constraints = getFieldConstraints(field);
  const text = String(value).trim();
  const errors = [];

  if (constraints.max_length && text.length > constraints.max_length) {
    errors.push(`supera el máximo de ${constraints.max_length} caracteres`);
  }
  if (constraints.content_type === 'alphabetic' && !/^[\p{L}\s'-]+$/u.test(text)) {
    errors.push('debe contener únicamente letras');
  } else if (constraints.content_type === 'numeric' && !/^\d+$/.test(text)) {
    errors.push('debe contener únicamente dígitos');
  } else if (constraints.content_type === 'alphanumeric' && !/^[\p{L}\p{N}\s]+$/u.test(text)) {
    errors.push('debe contener únicamente letras y números');
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
        if (parts.length === 3) return Date.UTC(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
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

const normalizeKey = (value) => normalizeText(value).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const getCode = (value) => String(value ?? '').trim().split(/\s+-\s+|\s+/)[0].replace(/\D/g, '');

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
  if (countryField && normalizeKey(templateName).includes('MOVILIDAD')) {
    rows.forEach((row, index) => {
      if (getCode(row?.[countryField.name]) === '170') {
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
