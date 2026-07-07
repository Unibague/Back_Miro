const crypto = require('crypto');
const QrToken = require('../models/qrTokens');
const PublishedTemplate = require('../models/publishedTemplates');
const Template = require('../models/templates');
const Dependency = require('../models/dependencies');
const User = require('../models/users');
const Validator = require('./validators');
const { getEffectiveRequired } = require('../helpers/requiredFields');
const { getFieldDropdownOptions } = require('../helpers/dropdownOptions');

const qrController = {};

const datetime_now = () => {
  const now = new Date();
  const offset = -5 * 60;
  const localTime = new Date(now.getTime() + offset * 60000);
  return localTime.toISOString().replace('Z', '-05:00');
};

const normalizeLookupText = (value = '') => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toUpperCase();

const parseValidateWith = (value = '') => {
  const text = typeof value === 'string'
    ? value
    : (value?.name || value?.id || '');
  const parts = String(text || '').split(' - ');
  return {
    validatorName: (parts[0] || '').trim(),
    columnName: parts.slice(1).join(' - ').trim(),
  };
};

const toPlainField = (field) => field?.toObject?.() || field;

const withEffectiveRequired = (field) => {
  const plainField = toPlainField(field) || {};
  return {
    ...plainField,
    required: getEffectiveRequired(plainField),
  };
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

const isDescriptionColumn = (columnName = '') => {
  const normalized = normalizeLookupText(columnName);
  return normalized.includes('DESCRIPCION') || normalized.includes('NOMBRE') || normalized.startsWith('DESC');
};

const findValidatorColumn = (validator, columnName) => {
  const columns = validator?.columns || [];
  if (!columns.length) return null;

  if (columnName) {
    const exactColumn = columns.find((column) => (
      normalizeLookupText(column.name) === normalizeLookupText(columnName)
    ));
    if (exactColumn) return exactColumn;
  }

  return columns.find((column) => column.is_validator) || columns[0];
};

const buildDropdownOptions = (validator, valueColumn) => {
  const values = Array.isArray(valueColumn?.values) ? valueColumn.values : [];
  const descriptionColumn = (validator?.columns || []).find((column) => (
    column.name !== valueColumn.name && isDescriptionColumn(column.name)
  ));
  const seen = new Set();
  const options = [];

  values.forEach((value, index) => {
    const idText = toOptionText(value);
    if (!idText) return;

    const descriptionText = toOptionText(descriptionColumn?.values?.[index]);
    const optionText = descriptionText && normalizeLookupText(descriptionText) !== normalizeLookupText(idText)
      ? `${idText} - ${descriptionText}`
      : idText;
    const key = normalizeLookupText(optionText);
    if (seen.has(key)) return;

    seen.add(key);
    options.push(optionText);
  });

  return options;
};

const toPlainDraftFieldData = (fieldData = {}) => fieldData?.toObject?.() || fieldData || {};

const draftFieldKey = (fieldData = {}) => {
  const plainFieldData = toPlainDraftFieldData(fieldData);
  return `${plainFieldData.sheet_name || plainFieldData.sheet || plainFieldData.sheetName || ''}::${plainFieldData.field_name || ''}`;
};

const mergeDraftFilledData = (currentFilledData = [], incomingFilledData = []) => {
  const merged = (currentFilledData || []).map((fieldData) => {
    const plainFieldData = toPlainDraftFieldData(fieldData);
    return {
      ...plainFieldData,
      values: Array.isArray(plainFieldData.values) ? [...plainFieldData.values] : [],
    };
  });
  const indexByField = new Map(merged.map((fieldData, index) => [draftFieldKey(fieldData), index]));

  (incomingFilledData || []).forEach((fieldData) => {
    const plainFieldData = toPlainDraftFieldData(fieldData);
    const key = draftFieldKey(plainFieldData);
    const values = Array.isArray(plainFieldData.values) ? plainFieldData.values : [];
    const existingIndex = indexByField.get(key);

    if (existingIndex !== undefined) {
      merged[existingIndex].values.push(...values);
      return;
    }

    indexByField.set(key, merged.length);
    merged.push({
      ...plainFieldData,
      values: [...values],
    });
  });

  return merged;
};

// POST /qr/generate  — el productor genera un token para su plantilla
qrController.generateToken = async (req, res) => {
  const { pubTemId, email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    // Verificar que la plantilla publicada permite QR
    const pubTem = await PublishedTemplate.findById(pubTemId).populate('template');
    if (!pubTem) return res.status(404).json({ error: 'Plantilla publicada no encontrada' });
    const snapshotId = pubTem.template?._id || pubTem.template?.id;
    const liveTemplate = snapshotId ? await Template.findById(snapshotId) : null;
    const allowsQr = liveTemplate?.allows_qr ?? pubTem.template?.allows_qr ?? false;
    if (!allowsQr) {
      return res.status(403).json({ error: 'Esta plantilla no tiene habilitada la generación de código QR.' });
    }

    // Verificar que el usuario esté autorizado: productor encargado o dependencia
    // incluida explícitamente en qr_authorized_producers.
    const responsibleIds = (liveTemplate?.responsible_producers ?? pubTem.template?.responsible_producers ?? [])
      .map(id => id.toString());
    const qrAuthorizedIds = (liveTemplate?.qr_authorized_producers ?? pubTem.template?.qr_authorized_producers ?? [])
      .map(id => id.toString());
    const userDependency = await Dependency.findOne({ dep_code: user.dep_code });
    const userDepId = userDependency?._id?.toString();
    const isAuthorized = Boolean(userDepId) && (responsibleIds.includes(userDepId) || qrAuthorizedIds.includes(userDepId));
    if (!isAuthorized) {
      return res.status(403).json({ error: 'No tienes autorización para generar el código QR de esta plantilla.' });
    }

    // Reusar token activo si ya existe para esta dependencia + plantilla
    const existing = await QrToken.findOne({
      publishedTemplateId: pubTemId,
      dependency: user.dep_code,
      active: true,
    });
    if (existing) return res.status(200).json({ token: existing.token });

    const token = crypto.randomUUID();
    await QrToken.create({
      token,
      publishedTemplateId: pubTemId,
      dependency: user.dep_code,
      createdBy: email,
    });

    return res.status(201).json({ token });
  } catch (error) {
    console.error('Error generating QR token:', error);
    return res.status(500).json({ error: error.message });
  }
};

// Helper: enriquecer campos con IDs de validadores
// Nota: no filtramos por locked — en el formulario QR todos los campos son editables
const enrichFields = async (fields, periodId) => {
  const editable = fields || [];
  return Promise.all(editable.map(async (field) => {
    const plainField = withEffectiveRequired(field);

    // Si el campo ya trae sus propias opciones (comentario o dropdown_options),
    // esas tienen prioridad y no deben sobreescribirse con un validador.
    const ownOptions = getFieldDropdownOptions(plainField);
    if (ownOptions.length > 0) {
      return { ...plainField, dropdown_options: ownOptions };
    }

    try {
      let validatorName, columnName;

      if (plainField.validate_with) {
        const parsed = parseValidateWith(plainField.validate_with);
        validatorName = parsed.validatorName;
        columnName = parsed.columnName;
      }
      
      // Si no encontró validador por validate_with, intentar por nombre del campo
      // Sin requerir que tenga dropdown_options
      if (!validatorName) {
        validatorName = plainField.name;
        columnName = null;
      }

      if (!validatorName) return plainField;

      let validator = await Validator.findValidatorByName(validatorName, periodId);
      if (!validator && columnName) {
        validator = await Validator.findValidatorByName(columnName, periodId);
      }

      if (validator) {
        const col = findValidatorColumn(validator, columnName || validatorName);
        if (col) {
          const dropdownOptions = buildDropdownOptions(validator, col);
          if (dropdownOptions.length) {
            return {
              ...plainField,
              validate_with: `${validator.name} - ${col.name}`, // Retornar como string, no como objeto
              dropdown_options: dropdownOptions,
            };
          }
        }
      }
    } catch (_) { /* ignore */ }
    return plainField;
  }));
};

// GET /qr/form/:token  — página pública obtiene datos del formulario
qrController.getFormData = async (req, res) => {
  const { token } = req.params;
  try {
    const qrToken = await QrToken.findOne({ token, active: true });
    if (!qrToken) return res.status(404).json({ error: 'Enlace no válido o expirado' });

    const pubTem = await PublishedTemplate.findById(qrToken.publishedTemplateId)
      .populate('period')
      .populate('template');
    if (!pubTem) return res.status(404).json({ error: 'Plantilla no encontrada' });

    const now = new Date();
    const deadline = new Date(pubTem.deadline);
    deadline.setHours(23, 59, 59, 999);
    if (deadline < now) return res.status(403).json({ error: 'El plazo de esta plantilla ya cerró' });

    const dep = await Dependency.findOne({ dep_code: qrToken.dependency });
    const depId = dep?._id?.toString();
    const periodId = pubTem.period?._id || pubTem.period;

    // Intentar usar la versión viva de la plantilla (igual que getTemplateById)
    const snapshotId = pubTem.template?._id || pubTem.template?.id;
    const liveTemplate = snapshotId ? await Template.findById(snapshotId) : null;
    const templateData = liveTemplate || pubTem.template?._doc || pubTem.template || {};

    const wbSheets = templateData.workbook_sheets || [];
    const topLevelFields = templateData.fields || [];

    console.log('[QR getFormData] wbSheets:', wbSheets.length,
      'topLevelFields:', topLevelFields.length,
      'sheetFieldCounts:', wbSheets.map(s => `${s.name}:${(s.fields||[]).length}`));

    // Enriquecer campos de nivel superior (no-locked) una sola vez
    const enrichedTop = topLevelFields.length
      ? await enrichFields(topLevelFields, periodId)
      : [];

    // Construir hojas accesibles para esta dependencia
    const templateShared = templateData.shared || false;
    let sheets = [];
    if (wbSheets.length) {
      const accessible = wbSheets.filter(sheet => {
        if (!sheet.producers?.length || sheet.shared || templateShared) return true;
        return sheet.producers.some(p => p.toString() === depId);
      });
      for (const sheet of accessible) {
        if (!sheet.fields?.length) continue; // sin campos → solo admin, no mostrar en QR
        const enriched = await enrichFields(sheet.fields, periodId);
        const fields = enriched.length ? enriched : enrichedTop;
        if (!fields.length) continue;
        sheets.push({ name: sheet.name, fields });
      }
    }

    // Si todos los sheets tienen exactamente los mismos campos (top-level fallback),
    // colapsar en un solo sheet para no repetir el mismo formulario N veces
    if (sheets.length > 1 && enrichedTop.length) {
      const allUseTop = sheets.every(s => s.fields === enrichedTop);
      if (allUseTop) {
        sheets = [{ name: pubTem.name, fields: enrichedTop }];
      }
    }

    // Último fallback: ni sheets ni top-level tienen campos
    if (!sheets.length) {
      sheets = [{ name: pubTem.name, fields: enrichedTop }];
    }

    return res.status(200).json({
      name: pubTem.name,
      dependency: dep?.name || qrToken.dependency,
      deadline: pubTem.deadline,
      periodId,
      periodName: pubTem.period?.name || null,
      sheets,
    });
  } catch (error) {
    console.error('Error fetching QR form data:', error);
    return res.status(500).json({ error: error.message });
  }
};

// POST /qr/submit/:token  — envío público de datos
qrController.submitFormData = async (req, res) => {
  const { token } = req.params;
  // sheetsData: [{ name, data: rows[] }]  ó  data: rows[] (legacy)
  const { sheetsData, data } = req.body;

  try {
    const qrToken = await QrToken.findOne({ token, active: true });
    if (!qrToken) return res.status(404).json({ error: 'Enlace no válido o expirado' });

    const pubTem = await PublishedTemplate.findById(qrToken.publishedTemplateId)
      .populate('period')
      .populate('template');
    if (!pubTem) return res.status(404).json({ error: 'Plantilla no encontrada' });

    const now = new Date();
    const deadline = new Date(pubTem.deadline);
    deadline.setHours(23, 59, 59, 999);
    if (deadline < now) return res.status(403).json({ error: 'El plazo de esta plantilla ya cerró' });

    const dep = await Dependency.findOne({ dep_code: qrToken.dependency });
    const depId = dep?._id?.toString();

    const snapshotId = pubTem.template?._id || pubTem.template?.id;
    const liveTemplate = snapshotId ? await Template.findById(snapshotId) : null;
    const templateData = liveTemplate || pubTem.template?._doc || pubTem.template || {};
    const wbSheets = templateData.workbook_sheets || [];

    // Resolver hojas con sus fields (filtrando por dependencia)
    const buildFilledData = (fields, rows, sheetName = null) =>
      (fields || []).map((field) => ({
        ...(sheetName ? { sheet_name: sheetName } : {}),
        field_name: field.name,
        values: (rows || []).map((row) => {
          let val = row[field.name] ?? null;
          if (typeof val === 'string' && ['null', 'nan'].includes(val.trim().toLowerCase())) val = null;
          return val;
        }),
      }));

    let filled_data = [];

    if (sheetsData?.length && wbSheets.length) {
      for (const { name, data: rows } of sheetsData) {
        const sheet = wbSheets.find(s => s.name === name);
        if (sheet) {
          // Hoja conocida: verificar acceso y usar sus campos
          if (sheet.producers?.length && !sheet.shared) {
            const hasAccess = sheet.producers.some(p => p.toString() === depId);
            if (!hasAccess) continue;
          }
          const sheetFields = sheet.fields || [];
          if (sheetFields.length) {
            filled_data = filled_data.concat(buildFilledData(sheetFields, rows, sheet.name));
            continue;
          }
        }
        // Hoja no encontrada o sin campos propios → usar campos de nivel superior
        const topFields2 = templateData.fields || [];
        if (topFields2.length) {
          filled_data = filled_data.concat(buildFilledData(topFields2, rows, name || null));
        }
      }
    }

    // Fallback legacy o si el loop de sheets no produjo datos
    if (!filled_data.length) {
      const allFields = templateData.fields?.length
        ? templateData.fields
        : (wbSheets[0]?.fields || []);
      filled_data = buildFilledData(allFields, data || sheetsData?.[0]?.data || [], templateData.fields?.length ? null : wbSheets[0]?.name);
    }

    // Usar el usuario que generó el QR como remitente (igual que edición en línea)
    let send_by = { name: 'QR público', email: 'qr@miro' };
    if (qrToken.createdBy) {
      const creator = await User.findOne({ email: qrToken.createdBy });
      if (creator) send_by = creator;
    }

    const producerEntry = {
      dependency: qrToken.dependency,
      send_by,
      filled_data,
      loaded_date: datetime_now(),
      source: 'qr',
      sender_email: send_by.email || null,
      sender_name: send_by.full_name || send_by.name || null,
    };

    if (!pubTem.qr_draft_data) pubTem.qr_draft_data = [];
    const existingIdx = pubTem.qr_draft_data.findIndex(d => d.dependency === qrToken.dependency);
    if (existingIdx > -1) {
      pubTem.qr_draft_data[existingIdx] = {
        ...producerEntry,
        filled_data: mergeDraftFilledData(pubTem.qr_draft_data[existingIdx].filled_data, filled_data),
      };
    } else {
      pubTem.qr_draft_data.push(producerEntry);
    }
    pubTem.markModified('qr_draft_data');

    await pubTem.save();
    return res.status(200).json({ status: 'Información guardada. El productor deberá confirmar el envío.' });
  } catch (error) {
    console.error('Error submitting QR form data:', error);
    return res.status(500).json({ error: error.message });
  }
};

// GET /qr/has-qr/template/:templateId — verifica si la plantilla tiene QR activos
qrController.hasActiveQrForTemplate = async (req, res) => {
  const { templateId } = req.params;
  try {
    const pubTems = await PublishedTemplate.find({}, { _id: 1, template: 1 }).lean();
    const matchingIds = pubTems
      .filter(pt => {
        const tmplId = pt.template?._id || pt.template?.id;
        return tmplId && tmplId.toString() === templateId;
      })
      .map(pt => pt._id);

    if (!matchingIds.length) return res.status(200).json({ hasQr: false });

    const count = await QrToken.countDocuments({
      publishedTemplateId: { $in: matchingIds },
      active: true,
    });
    return res.status(200).json({ hasQr: count > 0 });
  } catch (error) {
    console.error('Error checking QR for template:', error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports = qrController;
