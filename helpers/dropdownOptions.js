const normalizeOptionKey = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

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

const cleanOptionCandidate = (value) =>
  String(value || '')
    .replace(/^\s*(?:[-*]|\u2022)\s*/, '')
    .replace(/^\s*\d+[\).\-\s:]+/, '')
    .replace(/^\s*[A-Za-z][\).\-\s:]+/, '')
    .replace(/^"+|"+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const uniqueOptionTexts = (values) => {
  const seen = new Set();

  return (values || []).flatMap((value) => {
    const option = cleanOptionCandidate(toOptionText(value));
    const key = normalizeOptionKey(option);
    if (!option || seen.has(key)) return [];

    seen.add(key);
    return [option];
  });
};

const splitOptionCandidates = (value, includeSingle = false) => {
  const text = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) return [];

  const hasSeparators = /[\n;,|/]/.test(text);
  if (!hasSeparators) return includeSingle ? uniqueOptionTexts([text]) : [];

  return uniqueOptionTexts(text.split(/\n|;|,|\||\//g));
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
  const hasValueWord =
    marker.includes('VALORES') ||
    marker.includes('VALOSR') ||
    marker.includes('VALOSRES');

  return (
    marker.endsWith(':') &&
    hasValueWord &&
    (
      marker.includes('VALIDOS') ||
      marker.includes('POSIBLES') ||
      marker.includes('PERMITIDOS')
    )
  );
};

const extractDropdownOptionsFromComment = (comment) => {
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
      const inlineOptions = splitOptionCandidates(inlineText, true);
      options.push(...inlineOptions);
      hasStartedOptions = inlineOptions.length > 0;
      continue;
    }

    if (inOptionsSection) {
      hasStartedOptions = true;
      options.push(trimmed.replace(/\s+/g, ' '));
    }
  }

  return uniqueOptionTexts(options);
};

const getFieldDropdownOptions = (field = {}) => uniqueOptionTexts([
  ...(Array.isArray(field.excel_validation_options) ? field.excel_validation_options : []),
  ...(Array.isArray(field.dropdown_options) ? field.dropdown_options : []),
  ...extractDropdownOptionsFromComment(field.comment),
]);

const getOptionAliases = (option) => {
  const text = toOptionText(option);
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
  extractDropdownOptionsFromComment,
  getFieldDropdownOptions,
  normalizeOptionKey,
  uniqueOptionTexts,
};
