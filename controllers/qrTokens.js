const crypto = require('crypto');
const QrToken = require('../models/qrTokens');
const PublishedTemplate = require('../models/publishedTemplates');
const Template = require('../models/templates');
const Dependency = require('../models/dependencies');
const User = require('../models/users');
const Validator = require('./validators');

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
  const parts = String(value || '').split(' - ');
  return {
    validatorName: (parts[0] || '').trim(),
    columnName: parts.slice(1).join(' - ').trim(),
  };
};

const toPlainField = (field) => field?.toObject?.() || field;

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

// POST /qr/generate  — el productor genera un token para su plantilla
qrController.generateToken = async (req, res) => {
  const { pubTemId, email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

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
    const plainField = toPlainField(field);
    if (!plainField.validate_with || typeof plainField.validate_with !== 'string') return plainField;

    try {
      const { validatorName, columnName } = parseValidateWith(plainField.validate_with);
      if (!validatorName) return plainField;

      let validator = await Validator.findValidatorByName(validatorName, periodId);
      if (!validator && columnName) {
        validator = await Validator.findValidatorByName(columnName, periodId);
      }

      if (validator) {
        const col = findValidatorColumn(validator, columnName || validatorName);
        if (col) {
          const dropdownOptions = buildDropdownOptions(validator, col);
          return {
            ...plainField,
            validate_with: {
              id: String(validator._id || validator.id || validator.name),
              name: `${validator.name} - ${col.name}`,
            },
            dropdown_options: dropdownOptions.length ? dropdownOptions : plainField.dropdown_options,
          };
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
    let sheets = [];
    if (wbSheets.length) {
      const accessible = wbSheets.filter(sheet => {
        if (!sheet.producers?.length || sheet.shared) return true;
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
    const buildFilledData = (fields, rows) =>
      (fields || []).map((field) => ({
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
            filled_data = filled_data.concat(buildFilledData(sheetFields, rows));
            continue;
          }
        }
        // Hoja no encontrada o sin campos propios → usar campos de nivel superior
        const topFields2 = templateData.fields || [];
        if (topFields2.length) {
          filled_data = filled_data.concat(buildFilledData(topFields2, rows));
        }
      }
    }

    // Fallback legacy o si el loop de sheets no produjo datos
    if (!filled_data.length) {
      const allFields = templateData.fields?.length
        ? templateData.fields
        : (wbSheets[0]?.fields || []);
      filled_data = buildFilledData(allFields, data || sheetsData?.[0]?.data || []);
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
    };

    if (!pubTem.qr_draft_data) pubTem.qr_draft_data = [];
    const existingIdx = pubTem.qr_draft_data.findIndex(d => d.dependency === qrToken.dependency);
    if (existingIdx > -1) {
      pubTem.qr_draft_data[existingIdx] = producerEntry;
    } else {
      pubTem.qr_draft_data.push(producerEntry);
    }

    await pubTem.save();
    return res.status(200).json({ status: 'Información guardada. El productor deberá confirmar el envío.' });
  } catch (error) {
    console.error('Error submitting QR form data:', error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports = qrController;
