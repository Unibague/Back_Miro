const normalizeRequirementText = (value) => {
  if (value === null || value === undefined) return '';

  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
};

const checkLineForRequired = (line) => {
  const compact = line.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (const word of ['obligatorio', 'obligatario']) {
    const idx = compact.indexOf(word);
    if (idx >= 0 && !compact.slice(0, idx).endsWith('no') && !compact.slice(idx + word.length).startsWith('si')) return true;
  }
  return false;
};

const isRequiredComment = (comment) => {
  const str = String(comment ?? '');
  if (!str.trim()) return false;

  // First: check using NFC normalization (handles standard Spanish accents)
  if (str.normalize('NFC').split(/[\r\n]+/).some(checkLineForRequired)) return true;

  // Fallback: full NFD normalization + diacritic removal
  const normalized = normalizeRequirementText(comment);
  return normalized.trim() ? normalized.split('\n').some(checkLineForRequired) : false;
};

const getEffectiveRequired = (field = {}) => {
  if (Boolean(field?.required)) return true;
  const comment = field?.comment;
  if (typeof comment !== 'string' || !comment.trim()) return false;
  // Simple direct check for standard Spanish text
  const lower = comment.toLowerCase();
  for (const w of ['obligatorio', 'obligatario']) {
    if (lower.includes(w) && !lower.includes(`no ${w}`) && !new RegExp(`${w}\\s+si\\b`).test(lower)) return true;
  }
  // Fallback with full normalization
  return isRequiredComment(comment);
};

module.exports = {
  getEffectiveRequired,
  isRequiredComment,
};
