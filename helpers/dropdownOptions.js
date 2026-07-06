const normalizeOptionKey = (value) =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const collapseRepeatedCompositeOption = (value) => {
  const option = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!option) return '';

  const dashParts = option.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (dashParts.length >= 4 && dashParts.length % 2 === 0) {
    const midpoint = dashParts.length / 2;
    const left = dashParts.slice(0, midpoint).join(' - ');
    const right = dashParts.slice(midpoint).join(' - ');

    if (normalizeOptionKey(left) === normalizeOptionKey(right)) {
      return left;
    }
  }

  return option;
};

const toOptionText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if (value.$numberInt !== undefined) return String(value.$numberInt).trim();
    if (value.value !== undefined) return String(value.value).trim();
    if (value.id !== undefined) return String(value.id).trim();
    if (value.label !== undefined) return String(value.label).trim();
    if (value.name !== undefined) return String(value.name).trim();
  }
  return String(value).trim();
};

const cleanOptionCandidate = (value, { preserveLeadingCodes = false } = {}) => {
  let option = String(value ?? '')
    .replace(/^\s*(?:[-*]|\u2022)\s*/, '')
    .trim();

  option = collapseRepeatedCompositeOption(option
    .replace(/^"+|"+$/g, '')
    .replace(/\s+/g, ' ')
    .trim());

  if (!preserveLeadingCodes) {
    option = option
      .replace(/^\s*\d+[\).\-\s:]+/, '')
      .replace(/^\s*[A-Za-z][\).\-\s:]+/, '')
      .trim();
  }

  return option
    .replace(/\s+/g, ' ')
    .trim();
};

const uniqueOptionTexts = (values, options = {}) => {
  const seen = new Set();

  return (values || []).flatMap((value) => {
    const option = cleanOptionCandidate(toOptionText(value), options);
    const key = normalizeOptionKey(option);
    if (!option || seen.has(key)) return [];

    seen.add(key);
    return [option];
  });
};

const splitOptionCandidates = (value, includeSingle = false, options = {}) => {
  const text = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return [];

  const hasSeparators = /[\n;,|/]/.test(text);
  if (!hasSeparators) return includeSingle ? uniqueOptionTexts([text], options) : [];

  return uniqueOptionTexts(text.split(/\n|;|,|\||\//g), options);
};

const normalizeMarker = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

const isOptionsMarker = (line) => {
  const marker = normalizeMarker(line);
  const markerLabel = marker.includes(':') ? marker.slice(0, marker.indexOf(':') + 1) : marker;
  const hasValueWord =
    markerLabel.includes('VALORES') ||
    markerLabel.includes('VALOSR') ||
    markerLabel.includes('VALOSRES');

  return (
    marker.includes(':') &&
    hasValueWord &&
    (
      markerLabel.includes('VALIDOS') ||
      markerLabel.includes('POSIBLES') ||
      markerLabel.includes('PERMITIDOS')
    )
  );
};

const extractDropdownOptionsFromComment = (comment, optionsConfig = {}) => {
  const text = String(comment || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return [];

  const options = [];
  const lines = text.split('\n');
  let inOptionsSection = false;
  let hasStartedOptions = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (inOptionsSection && !hasStartedOptions) continue;
      if (inOptionsSection) break;
      continue;
    }

    if (!inOptionsSection && isOptionsMarker(trimmed)) {
      inOptionsSection = true;
      const inlineText = trimmed.slice(trimmed.indexOf(':') + 1);
      const inlineOptions = splitOptionCandidates(inlineText, true, optionsConfig);
      options.push(...inlineOptions);
      hasStartedOptions = inlineOptions.length > 0;
      continue;
    }

    if (inOptionsSection) {
      hasStartedOptions = true;
      options.push(trimmed.replace(/\s+/g, ' '));
    }
  }

  return uniqueOptionTexts(options, optionsConfig);
};

// preserveLeadingCodes: true porque los códigos iniciales (ej. "1", "CC") son
// parte del valor semántico del campo (ej. ID_TIPO_MOV_DOC_EXTERIOR), no viñetas.
// Prioridad (sin combinar): comentario primero; si no trae lista, se usan
// dropdown_options/excel_validation_options/validator_options ya almacenadas.
const getFieldDropdownOptions = (field = {}) => {
  const fromComment = extractDropdownOptionsFromComment(field.comment, { preserveLeadingCodes: true });
  if (fromComment.length > 0) {
    return uniqueOptionTexts(fromComment, { preserveLeadingCodes: true });
  }

  return uniqueOptionTexts([
    ...(Array.isArray(field.excel_validation_options) ? field.excel_validation_options : []),
    ...(Array.isArray(field.validator_options) ? field.validator_options : []),
    ...(Array.isArray(field.dropdown_options) ? field.dropdown_options : []),
  ], { preserveLeadingCodes: true });
};

const getOptionAliases = (option) => {
  const text = collapseRepeatedCompositeOption(toOptionText(option));
  const aliases = [text];

  // Match "CODE - description" (separator: dash, colon, equals, etc.)
  const leadingCode = text.match(/^\s*([A-Za-z0-9]+)\s*(?:[-:=)]|\.)\s+.+$/);
  if (leadingCode?.[1]) {
    aliases.push(leadingCode[1]);
  } else {
    // Match "CODE description" (space-only, short code ≤6 chars + longer description)
    const spaceCode = text.match(/^\s*([A-Za-z0-9]{1,6})\s+\S.+$/);
    if (spaceCode?.[1]) {
      const code = spaceCode[1];
      const rest = text.slice(text.indexOf(' ')).trim();
      if (rest.length > code.length) {
        aliases.push(code);
        aliases.push(`${code} - ${rest}`);
      }
    }
  }

  return uniqueOptionTexts(aliases);
};

const buildAcceptedDropdownOptionSet = (options = []) => {
  const accepted = new Set();
  getFieldDropdownOptions({ dropdown_options: options }).forEach((option) => {
    getOptionAliases(option).forEach((alias) => {
      const key = normalizeMarker(alias);
      if (key) accepted.add(key);
    });
  });
  return accepted;
};

module.exports = {
  buildAcceptedDropdownOptionSet,
  collapseRepeatedCompositeOption,
  extractDropdownOptionsFromComment,
  getFieldDropdownOptions,
  normalizeOptionKey,
  uniqueOptionTexts,
};
