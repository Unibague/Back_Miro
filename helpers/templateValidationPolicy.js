const { getEffectiveRequired } = require('./requiredFields');

// Reglas de negocio compartidas por las plantillas nuevas y sus snapshots publicados.
const fieldKey = (name) => String(name || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toUpperCase()
  .replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');

const isInternationalEntityField = (field) => ['NOMBRE_ENTIDAD_FTE_INTERNAC', 'NOMBRE_ENTIDAD_FTE_INTERNACIONAL'].includes(fieldKey(field.name));
const isNoApplyField = (field) => fieldKey(field.name) === 'ID_PAIS_FINANCIADOR' || isInternationalEntityField(field);
const isNoApplyValue = (field, value) => (isNoApplyField(field) && String(value ?? '').trim() === '0')
  || (isInternationalEntityField(field) && String(value ?? '').trim().toUpperCase() === 'N/A');
const isCountryCodeField = (field) => /^ID_PAIS_(FINANCIADOR|INSTITUCION_ASOCIADA|EXTRANJERO)$/.test(fieldKey(field.name));
const isCooperationFlag = (field) => fieldKey(field.name) === 'OTRAS_ACTIVIDADES_COOPERACION';
const isYesNoField = (field) => isCooperationFlag(field)
  || /\bS\s*\/\s*N\b/i.test(String(field.comment || ''));
const isActivityDate = (field) => ['FECHA_INICIO', 'FECHA_FINAL'].includes(fieldKey(field.name));

const applyTemplateValidationPolicy = (field = {}) => {
  const normalized = { ...(field.toObject?.() || field) };
  const requiredHint = getEffectiveRequired(field) ? 'Obligatorio. ' : '';
  if (isActivityDate(field)) {
    normalized.datatype = 'Fecha';
    normalized.content_type = '';
    normalized.validate_with = '';
    normalized.dropdown_options = [];
    normalized.excel_validation_options = [];
    normalized.validator_options = [];
    normalized.comment = `${requiredHint}Fecha en formato DD/MM/AAAA (también se admite DD/MM/AA).`;
  }
  if (fieldKey(field.name) === 'DESCRIPCION_ACTIVIDAD') {
    normalized.content_type = 'alphanumeric';
    normalized.comment = String(field.comment || '').replace(/alfab[eé]tico/gi, 'alfanumérico');
  }
  if (fieldKey(field.name) === 'CODIGO_CONVENIO') {
    const configuredMax = Number(field.max_length);
    const commentMax = String(field.comment || '').match(/\b(?:alfab[eé]tico|alfanum[eé]rico|num[eé]rico)\s*\(\s*(\d+)\s*\)/i);
    normalized.datatype = 'Texto Corto';
    normalized.content_type = 'alphanumeric';
    normalized.max_length = Number.isSafeInteger(configuredMax) && configuredMax > 0
      ? configuredMax : (Number(commentMax?.[1]) || 30);
    normalized.comment = String(field.comment || '').trim()
      ? String(field.comment).replace(/\b(?:alfab[eé]tico|num[eé]rico)\b/gi, 'alfanumérico')
      : `Alfanumérico (${normalized.max_length}). Código o número del convenio.`;
  }
  if (isCountryCodeField(field)) {
    normalized.content_type = 'numeric';
    normalized.comment = String(field.comment || '').replace(/alfab[eé]tico|alfanum[eé]rico/gi, 'numérico');
  }
  if (isInternationalEntityField(field)) {
    normalized.content_type = 'alphanumeric';
    normalized.comment = String(field.comment || '').replace(/alfab[eé]tico/gi, 'alfanumérico');
  }
  if (isYesNoField(field)) {
    normalized.datatype = 'Texto Corto';
    normalized.content_type = 'alphabetic';
    normalized.max_length = 1;
    normalized.multiple = false;
    normalized.validate_with = '';
    normalized.dropdown_options = ['S', 'N'];
    normalized.excel_validation_options = ['S', 'N'];
    normalized.validator_options = ['S', 'N'];
    normalized.comment = isCooperationFlag(field)
      ? `${requiredHint}Seleccione únicamente S (Sí) o N (No), opciones S/N.\nValores permitidos:\nS\nN`
      : `${String(field.comment || '').split('\nValores permitidos:')[0]}\nValores permitidos:\nS\nN`;
  }
  return normalized;
};

module.exports = { applyTemplateValidationPolicy, fieldKey, isNoApplyField, isNoApplyValue, isInternationalEntityField, isCountryCodeField, isCooperationFlag, isYesNoField, isActivityDate };
