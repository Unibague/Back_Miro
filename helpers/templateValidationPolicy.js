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
  if (isCountryCodeField(field)) {
    normalized.content_type = 'numeric';
    normalized.comment = String(field.comment || '').replace(/alfab[eé]tico|alfanum[eé]rico/gi, 'numérico');
  }
  if (isInternationalEntityField(field)) {
    normalized.content_type = 'alphanumeric';
    normalized.comment = String(field.comment || '').replace(/alfab[eé]tico/gi, 'alfanumérico');
  }
  if (isCooperationFlag(field)) {
    normalized.datatype = 'Texto Corto';
    normalized.content_type = 'alphabetic';
    normalized.max_length = 1;
    normalized.multiple = false;
    normalized.validate_with = '';
    normalized.dropdown_options = ['S', 'N'];
    normalized.comment = `${requiredHint}Seleccione únicamente S (Sí) o N (No), opciones S/N.\nValores permitidos:\nS\nN`;
  }
  return normalized;
};

module.exports = { applyTemplateValidationPolicy, fieldKey, isNoApplyField, isNoApplyValue, isInternationalEntityField, isCountryCodeField, isCooperationFlag, isActivityDate };
