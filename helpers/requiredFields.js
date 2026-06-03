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

const isRequiredComment = (comment) => {
  const normalized = normalizeRequirementText(comment);
  if (!normalized.trim()) return false;

  return normalized.split('\n').some((line) => {
    const text = line.trim().replace(/\s+/g, ' ').toLowerCase();
    const compactText = text.replace(/[^a-z0-9]+/g, '');
    const requiredIndex = compactText.indexOf('obligatorio');
    if (requiredIndex < 0) return false;

    const beforeRequired = compactText.slice(0, requiredIndex);
    const afterRequired = compactText.slice(requiredIndex + 'obligatorio'.length);
    return !beforeRequired.endsWith('no') && !afterRequired.startsWith('si');
  });
};

const getEffectiveRequired = (field = {}) => {
  if (Boolean(field?.required)) return true;
  const comment = field?.comment;
  if (typeof comment === 'string' && comment.trim()) {
    return isRequiredComment(comment);
  }
  return false;
};

module.exports = {
  getEffectiveRequired,
  isRequiredComment,
};
