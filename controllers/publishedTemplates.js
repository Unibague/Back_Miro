const mongoose = require('mongoose');
const PublishedTemplate = require('../models/publishedTemplates.js');
const Template = require('../models/templates.js')
const SniesTemplate = require('../models/sniesTemplates');
const CnaTemplate = require('../models/cnaTemplates');
const Period = require('../models/periods.js')
const Dimension = require('../models/dimensions.js')
const Dependency = require('../models/dependencies.js')
const User = require('../models/users.js')
const PositionViewPermission = require('../models/positionViewPermissions.js')
const AccessProfile = require('../models/accessProfiles.js')
const Validator = require('./validators.js');
const Log = require('../models/logs');
const UserService = require('../services/users.js');
const Category = require('../models/categories.js');  
const ExcelJS = require("exceljs");
const auditLogger = require('../services/auditLogger');
const RemindersService = require('../services/reminders');
const { getEffectiveRequired } = require('../helpers/requiredFields');

const axios = require('axios');

const publTempController = {};

const validateWithToText = (validateWith) => {
  if (!validateWith) return '';
  if (typeof validateWith === 'string') return validateWith;
  if (typeof validateWith === 'object') return validateWith.name || validateWith.id || '';
  return String(validateWith);
};

const getFieldValidatorReference = (field = {}) =>
  validateWithToText(field.validate_with).trim() || String(field.name || '').trim();

// Recolecta todos los validators de una plantilla: campos top-level + todas las hojas de workbook
const collectValidatorsForTemplate = async (templateData, periodId) => {
  const topFields = templateData?.fields || [];
  const sheetFields = (templateData?.workbook_sheets || []).flatMap(s => s.fields || []);
  const allFields = [...topFields, ...sheetFields];
  const seen = new Set();
  const unique = allFields.filter(f => {
    const reference = getFieldValidatorReference(f);
    const key = reference.split(' - ')[0].trim().toLowerCase();
    if (!key) return false;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const results = await Promise.all(
    unique.map(f => Validator.giveValidatorToExcel(getFieldValidatorReference(f), periodId))
  );
  return results.filter(Boolean);
};

const validatorValueToPlain = (value) => {
  if (value && typeof value === 'object' && value.$numberInt !== undefined) return value.$numberInt;
  if (value && typeof value === 'object' && value.$numberDouble !== undefined) return value.$numberDouble;
  return value;
};

const validatorRowsFromColumns = (columns = []) => (
  (columns || []).reduce((acc, col) => {
    (col.values || []).forEach((value, index) => {
      if (!acc[index]) acc[index] = {};
      acc[index][col.name] = validatorValueToPlain(value);
    });
    return acc;
  }, [])
);

const splitValidateWithReference = (validateWith) => {
  const text = validateWithToText(validateWith);
  const parts = text.split(' - ');
  return {
    text,
    validatorName: (parts[0] || '').trim(),
    columnName: parts.slice(1).join(' - ').trim(),
  };
};

const normalizeValidatorText = (value = '') =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase();

const isValidatorDescriptionColumn = (columnName = '') => {
  const normalized = normalizeValidatorText(columnName);
  return normalized.includes('DESCRIPCION') || normalized.includes('NOMBRE') || normalized.startsWith('DESC');
};

const addValidatorToResponseMap = (validatorsMap, validator) => {
  if (!validator?.name || validatorsMap.has(validator.name)) return;
  validatorsMap.set(validator.name, {
    name: validator.name,
    columns: (validator.columns || []).map((column) => ({
      name: column.name,
      is_validator: Boolean(column.is_validator),
      type: column.type,
    })),
    values: validatorRowsFromColumns(validator.columns || []),
  });
};

const enrichFieldWithCurrentValidator = async (field, periodId, validatorsMap) => {
  const plainField = field?.toObject?.() || field;
  const { validatorName, columnName } = splitValidateWithReference(plainField?.validate_with);
  if (!validatorName) return plainField;

  const validator = await Validator.findValidatorByName(validatorName, periodId);
  if (!validator) return plainField;

  const column = (columnName
    ? (validator.columns || []).find(col => col.name === columnName)
    : null)
    || (validator.columns || []).find(col => col.is_validator)
    || (validator.columns || [])[0];

  if (!column) return plainField;

  addValidatorToResponseMap(validatorsMap, validator);

  const optName = column.name.trim().toLowerCase() === validator.name.trim().toLowerCase()
    ? validator.name
    : `${validator.name} - ${column.name}`;

  return {
    ...plainField,
    validate_with: {
      id: String(validator._id || validator.name),
      name: optName,
    },
    validator_values: (column.values || []).map(validatorValueToPlain),
    validator_type: column.type,
  };
};

const toPlainObject = (value) => value?.toObject?.() || value || {};

const UNCATEGORIZED_CATEGORY_FILTER = '__uncategorized__';
const normalizeCategoryName = (value = '') =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();

const escapeRegExp = (value = '') => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeCategoryForResponse = (category) => {
  const plainCategory = toPlainObject(category);
  const categoryId = plainCategory?._id || plainCategory?.id;
  const categoryName = plainCategory?.name;

  if (!categoryId && !categoryName) return { name: 'Sin categoría' };

  return {
    ...(categoryId && { _id: String(categoryId) }),
    name: categoryName || 'Sin categoría',
  };
};

const resolveCategoryFilter = async (filterByCategory = '') => {
  const rawFilter = String(filterByCategory || '').trim();
  if (!rawFilter) return null;

  if (rawFilter === UNCATEGORIZED_CATEGORY_FILTER) {
    return { uncategorized: true };
  }

  let category = null;
  if (mongoose.Types.ObjectId.isValid(rawFilter)) {
    category = await Category.findById(rawFilter).select('_id name').lean();
  }

  if (!category) {
    category = await Category.findOne({
      name: { $regex: new RegExp(`^${escapeRegExp(rawFilter)}$`, 'i') },
    }).select('_id name').lean();
  }

  if (!category) {
    return { id: rawFilter, name: rawFilter };
  }

  return { id: String(category._id), name: category.name };
};

const matchesCategoryFilter = (publishedTemplate, categoryFilter) => {
  if (!categoryFilter) return true;

  const category = normalizeCategoryForResponse(
    publishedTemplate?.template?.category || publishedTemplate?.category
  );
  const categoryId = category?._id ? String(category._id) : '';
  const categoryName = category?.name || '';
  const isUncategorized = !categoryId && (!categoryName || categoryName === 'Sin categoría');

  if (categoryFilter.uncategorized) return isUncategorized;

  return (
    (categoryFilter.id && categoryId === categoryFilter.id) ||
    (categoryFilter.name && normalizeCategoryName(categoryName) === normalizeCategoryName(categoryFilter.name))
  );
};

const enrichPublishedTemplateWithLiveTemplate = async (publishedTemplate) => {
  const templateId = publishedTemplate?.template?._id || publishedTemplate?.template?.id;
  const originalTemplate = templateId
    ? await Template.findById(templateId)
        .populate({
          path: 'category',
          model: 'categories',
          select: 'name templates',
        })
        .lean()
    : null;

  return {
    ...publishedTemplate,
    template: {
      ...publishedTemplate.template,
      fields: originalTemplate?.fields || publishedTemplate.template?.fields || [],
      workbook_sheets: originalTemplate?.workbook_sheets || publishedTemplate.template?.workbook_sheets || [],
      allows_qr: originalTemplate?.allows_qr ?? publishedTemplate.template?.allows_qr ?? false,
      notify_producers: originalTemplate?.notify_producers ?? publishedTemplate.template?.notify_producers ?? false,
      shared: originalTemplate?.shared ?? publishedTemplate.template?.shared ?? false,
      responsible_producers: originalTemplate?.responsible_producers || publishedTemplate.template?.responsible_producers || [],
      category: normalizeCategoryForResponse(
        originalTemplate?.category || publishedTemplate.template?.category || publishedTemplate.category
      ),
    },
  };
};

const enrichQrDraftsWithDependencyInfo = async (qrDraftData = []) => {
  const plainDrafts = (qrDraftData || []).map(toPlainObject);
  const dependencyCodes = [...new Set(plainDrafts.map(draft => draft.dependency).filter(Boolean))];

  if (!dependencyCodes.length) return plainDrafts;

  const dependencies = await Dependency.find(
    { dep_code: { $in: dependencyCodes } },
    'dep_code name'
  ).lean();
  const dependencyByCode = new Map(dependencies.map(dep => [dep.dep_code, dep]));

  return plainDrafts.map((draft) => {
    const dependency = dependencyByCode.get(draft.dependency);
    const sender = toPlainObject(draft.send_by);

    return {
      ...draft,
      dependency_code: draft.dependency,
      dependency_name: dependency?.name || draft.dependency,
      sender_name: sender.full_name || sender.name || sender.email || 'QR publico',
      sender_email: sender.email || null,
    };
  });
};

const replaceDraftDataForDependency = (publishedTemplate, producerEntry) => {
  const existingDrafts = Array.isArray(publishedTemplate.qr_draft_data)
    ? publishedTemplate.qr_draft_data
    : [];

  publishedTemplate.qr_draft_data = existingDrafts
    .filter(draft => draft.dependency !== producerEntry.dependency);
  publishedTemplate.qr_draft_data.push(producerEntry);
  publishedTemplate.markModified('qr_draft_data');
};

const isBlankOptionalValue = (value) => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return Number.isNaN(value);
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((item) => isBlankOptionalValue(item));
  }

  const normalized = String(value).trim().toLowerCase();
  return normalized === '' || normalized === 'null' || normalized === 'nan';
};

const resolveLatestTemplateSnapshot = async (templateSnapshot) => {
  const templateId = templateSnapshot?._id;
  if (!templateId) return null;

  const latestTemplate =
    await Template.findById(templateId).lean() ||
    await SniesTemplate.findById(templateId).lean() ||
    await CnaTemplate.findById(templateId).lean();

  return latestTemplate || null;
};

const refreshPublishedTemplateSnapshot = async (publishedTemplate) => {
  if (!publishedTemplate?.template?._id) return publishedTemplate;

  const latestTemplate = await resolveLatestTemplateSnapshot(publishedTemplate.template);
  if (!latestTemplate) return publishedTemplate;

  const currentTemplateId = String(publishedTemplate.template._id);
  const latestTemplateId = String(latestTemplate._id);
  const currentFields = JSON.stringify(publishedTemplate.template.fields || []);
  const latestFields = JSON.stringify(latestTemplate.fields || []);
  const currentWorkbookSheets = JSON.stringify(publishedTemplate.template.workbook_sheets || []);
  const latestWorkbookSheets = JSON.stringify(latestTemplate.workbook_sheets || []);

  if (
    currentTemplateId !== latestTemplateId ||
    currentFields !== latestFields ||
    currentWorkbookSheets !== latestWorkbookSheets ||
    String(publishedTemplate.template.original_workbook_base64 || "") !== String(latestTemplate.original_workbook_base64 || "") ||
    Boolean(publishedTemplate.template.shared) !== Boolean(latestTemplate.shared) ||
    Boolean(publishedTemplate.template.allows_qr) !== Boolean(latestTemplate.allows_qr) ||
    Boolean(publishedTemplate.template.notify_producers) !== Boolean(latestTemplate.notify_producers) ||
    JSON.stringify(publishedTemplate.template.responsible_producers || []) !== JSON.stringify(latestTemplate.responsible_producers || []) ||
    JSON.stringify(publishedTemplate.template.producers || []) !== JSON.stringify(latestTemplate.producers || []) ||
    JSON.stringify(publishedTemplate.template.dimensions || []) !== JSON.stringify(latestTemplate.dimensions || [])
  ) {
    publishedTemplate.template = latestTemplate;
    publishedTemplate.notify_producers = latestTemplate.notify_producers ?? false;
    await publishedTemplate.save();
  }

  return publishedTemplate;
};

const uploadNotificationsEnabled = (publishedTemplate) => (
  Boolean(publishedTemplate?.notify_producers ?? publishedTemplate?.template?.notify_producers ?? false)
);

const getAllProducerIds = (publishedTemplate) => {
  const rawProducers = publishedTemplate?.producers?.length > 0
    ? publishedTemplate.producers
    : publishedTemplate?.template?.producers;

  return [...new Set((rawProducers || [])
    .map((item) => {
      const value = item && typeof item === 'object' && item._id ? item._id : item;
      return String(value || '');
    })
    .filter((id) => mongoose.Types.ObjectId.isValid(id)))];
};

const notifyResponsibleProducersOnUpload = (publishedTemplate, user, userDependencies = []) => {
  if (!uploadNotificationsEnabled(publishedTemplate)) return;

  const responsibleIds = getAllProducerIds(publishedTemplate);
  if (responsibleIds.length === 0) return;

  const templateName = publishedTemplate.name;
  const uploaderEmail = user.email;
  const uploaderName = user.full_name || user.name || user.email;
  const uploaderDependency = userDependencies.find((dep) => dep.dep_code === user.dep_code) || userDependencies[0];
  const uploaderDependencyName = uploaderDependency?.name || user.dep_code;

  setImmediate(async () => {
    try {
      const responsibleDeps = await Dependency.find(
        { _id: { $in: responsibleIds } },
        'dep_code name'
      ).lean();
      const responsibleDepCodes = responsibleDeps.map((dep) => dep.dep_code).filter(Boolean);
      if (responsibleDepCodes.length === 0) return;

      const recipients = await User.find({
        isActive: true,
        roles: 'Productor',
        email: { $ne: uploaderEmail },
        $or: [
          { dep_code: { $in: responsibleDepCodes } },
          { additional_dependencies: { $in: responsibleDepCodes } },
        ],
      }, 'email name full_name').lean();

      const sentTo = new Set();
      for (const recipient of recipients) {
        if (!recipient.email || sentTo.has(recipient.email)) continue;
        sentTo.add(recipient.email);

        await RemindersService.sendUploadNotificationEmail(
          recipient.email,
          recipient.full_name || recipient.name || recipient.email,
          templateName,
          uploaderDependencyName,
          uploaderName,
          new Date()
        ).catch((error) => {
          console.error(`[UPLOAD-NOTIFY] Error enviando a ${recipient.email}:`, error.message);
        });
      }
    } catch (error) {
      console.error('[UPLOAD-NOTIFY] Error preparando notificaciones:', error.message);
    }
  });
};

// Mapeo de códigos alfa-2 de países a IDs numéricos
const countryCodeToId = {
  'AD': '20', 'AE': '784', 'AF': '4', 'AG': '28', 'AI': '660', 'AL': '8', 'AM': '51', 'AN': '530',
  'AO': '24', 'AQ': '10', 'AR': '32', 'AS': '16', 'AT': '40', 'AU': '36', 'AW': '533', 'AX': '248',
  'AZ': '31', 'BA': '70', 'BB': '52', 'BD': '50', 'BE': '56', 'BF': '854', 'BG': '100', 'BH': '48',
  'BI': '108', 'BJ': '204', 'BL': '652', 'BM': '60', 'BN': '96', 'BO': '68', 'BR': '76', 'BS': '44',
  'BT': '64', 'BV': '74', 'BW': '72', 'BY': '112', 'BZ': '84', 'CA': '124', 'CC': '166', 'CD': '180',
  'CF': '140', 'CG': '178', 'CH': '756', 'CI': '384', 'CK': '184', 'CL': '152', 'CM': '120', 'CN': '156',
  'CO': '170', 'CR': '188', 'CU': '192', 'CV': '132', 'CW': '531', 'CX': '162', 'CY': '196', 'CZ': '203',
  'DE': '276', 'DJ': '262', 'DK': '208', 'DM': '212', 'DO': '214', 'DZ': '12', 'EC': '218', 'EE': '233',
  'EG': '818', 'EH': '732', 'ER': '232', 'ES': '724', 'ET': '231', 'FI': '246', 'FJ': '242', 'FK': '238',
  'FM': '583', 'FO': '234', 'FR': '250', 'GA': '266', 'GB': '826', 'GD': '308', 'GE': '268', 'GF': '254',
  'GG': '831', 'GH': '288', 'GI': '292', 'GL': '304', 'GM': '270', 'GN': '324', 'GP': '312', 'GQ': '226',
  'GR': '300', 'GS': '239', 'GT': '320', 'GU': '316', 'GW': '624', 'GY': '328', 'HK': '344', 'HM': '334',
  'HN': '340', 'HR': '191', 'HT': '332', 'HU': '348', 'ID': '360', 'IE': '372', 'IL': '376', 'IM': '833',
  'IN': '356', 'IO': '86', 'IQ': '368', 'IR': '364', 'IS': '352', 'IT': '380', 'JE': '832', 'JM': '388',
  'JO': '400', 'JP': '392', 'KE': '404', 'KG': '417', 'KH': '116', 'KI': '296', 'KM': '174', 'KN': '659',
  'KP': '408', 'KR': '410', 'KW': '414', 'KY': '136', 'KZ': '398', 'LA': '418', 'LB': '422', 'LC': '662',
  'LI': '438', 'LK': '144', 'LR': '430', 'LS': '426', 'LT': '440', 'LU': '442', 'LV': '428', 'LY': '434',
  'MA': '504', 'MC': '492', 'MD': '498', 'ME': '499', 'MF': '663', 'MG': '450', 'MH': '584', 'MK': '807',
  'ML': '466', 'MM': '104', 'MN': '496', 'MO': '446', 'MP': '580', 'MQ': '474', 'MR': '478', 'MS': '500',
  'MT': '470', 'MU': '480', 'MV': '462', 'MW': '454', 'MX': '484', 'MY': '458', 'MZ': '508', 'NA': '516',
  'NC': '540', 'NE': '562', 'NF': '574', 'NG': '566', 'NI': '558', 'NL': '528', 'NO': '578', 'NP': '524',
  'NR': '520', 'NU': '570', 'NZ': '554', 'OM': '512', 'PA': '591', 'PE': '604', 'PF': '258', 'PG': '598',
  'PH': '608', 'PK': '586', 'PL': '616', 'PM': '666', 'PN': '612', 'PR': '630', 'PS': '275', 'PT': '620',
  'PW': '585', 'PY': '600', 'QA': '634', 'RE': '638', 'RO': '642', 'RS': '688', 'RU': '643', 'RW': '646',
  'SA': '682', 'SB': '90', 'SC': '690', 'SD': '729', 'SE': '752', 'SG': '702', 'SH': '654', 'SI': '705',
  'SJ': '744', 'SK': '703', 'SL': '694', 'SM': '674', 'SN': '686', 'SO': '706', 'SR': '740', 'SS': '728',
  'ST': '678', 'SV': '222', 'SX': '534', 'SY': '760', 'SZ': '748', 'TC': '796', 'TD': '148', 'TF': '260',
  'TG': '768', 'TH': '764', 'TJ': '762', 'TK': '772', 'TL': '626', 'TM': '795', 'TN': '788', 'TO': '776',
  'TR': '792', 'TT': '780', 'TV': '798', 'TW': '158', 'TZ': '834', 'UA': '804', 'UG': '800', 'UM': '581',
  'US': '840', 'UY': '858', 'UZ': '860', 'VA': '336', 'VC': '670', 'VE': '862', 'VG': '92', 'VI': '850',
  'VN': '704', 'VU': '548', 'WF': '876', 'WS': '882', 'YE': '887', 'YT': '175', 'ZA': '710', 'ZM': '894',
  'ZW': '716', 'NA': '0'
};

// Función para convertir códigos de país a IDs
const convertCountryCodeToId = (value) => {
  if (typeof value === 'string') {
    const upperValue = value.toUpperCase().trim();
    return countryCodeToId[upperValue] || value;
  }
  return value;
};

// Mapeo de IDs a valores descriptivos
const idToDescriptiveValue = {
  // Sexo biológico
  'sexo_biologico': { '1': 'Masculino', '2': 'Femenino' },
  'genero': { '1': 'Masculino', '2': 'Femenino', '3': 'Otro', '4': 'Prefiero no decir' },
  'estado_civil': { '1': 'Soltero', '2': 'Casado', '3': 'Divorciado', '4': 'Viudo', '5': 'Unión libre' },
  'tipo_documento': { '1': 'Cédula de ciudadanía', '2': 'Tarjeta de identidad', '3': 'Cédula de extranjería', '4': 'Pasaporte' },
  'nivel_educativo': { '1': 'Primaria', '2': 'Secundaria', '3': 'Técnico', '4': 'Tecnológico', '5': 'Universitario', '6': 'Especialización', '7': 'Maestría', '8': 'Doctorado' },
  'estrato': { '1': 'Estrato 1', '2': 'Estrato 2', '3': 'Estrato 3', '4': 'Estrato 4', '5': 'Estrato 5', '6': 'Estrato 6' },
  'tipo_vinculacion': { '1': 'Planta', '2': 'Contrato', '3': 'Cátedra', '4': 'Ocasional' },
  'modalidad': { '1': 'Presencial', '2': 'Virtual', '3': 'Mixta' },
  'jornada': { '1': 'Diurna', '2': 'Nocturna', '3': 'Fin de semana' },
  'semestre': { '1': 'I', '2': 'II', '3': 'III', '4': 'IV', '5': 'V', '6': 'VI', '7': 'VII', '8': 'VIII', '9': 'IX', '10': 'X' },
  'si_no': { '1': 'Sí', '2': 'No', '0': 'No', 'true': 'Sí', 'false': 'No' },
  'activo_inactivo': { '1': 'Activo', '2': 'Inactivo', '0': 'Inactivo' },
  'aprobado_reprobado': { '1': 'Aprobado', '2': 'Reprobado', '0': 'Reprobado' },
  // Campos específicos con ID_
  'id_sexo_biologico': { '1': 'Masculino', '2': 'Femenino' },
  'id_estado_civil': { '1': 'Soltero', '2': 'Casado', '3': 'Divorciado', '4': 'Viudo', '5': 'Unión libre' },
  'id_tipo_documento': { '1': 'Cédula de ciudadanía', '2': 'Tarjeta de identidad', '3': 'Cédula de extranjería', '4': 'Pasaporte' },
  'nacional_internacional': { '1': 'Nacional', '2': 'Internacional' },
  'tipo_movilidad': { '1': 'Entrante', '2': 'Saliente' },
  'movilidad_por_convenio': { 'S': 'Sí', 'N': 'No' },
  'id_fuente_nacional_investig': { '1': 'Colciencias', '2': 'Universidad', '3': 'Empresa privada', '4': 'Otro', '20': 'Otra fuente' },
  'id_fuente_internacional': { '1': 'Gobierno extranjero', '2': 'Organización internacional', '3': 'Universidad extranjera', '4': 'Otro', '9': 'Fundación internacional' },
  'estrategia': { '1': 'Opción 1', '2': 'Opción 2', '15': 'Estrategia específica' },
  'enfoques': { '1': 'Enfoque 1', '2': 'Enfoque 2', '4': 'Enfoque interdisciplinario' },
  'impacto': { '1': 'Alto', '2': 'Medio', '3': 'Bajo', '15': 'Impacto significativo' },
  'nacional': { '1': 'Nacional', '2': 'Internacional' },
  'internacional': { '1': 'Nacional', '2': 'Internacional' },
  'promueve': { 'S': 'Sí', 'N': 'No' },
  'desarrolla': { 'S': 'Sí', 'N': 'No' }
};

// Función para convertir IDs a valores descriptivos
const convertIdToDescriptive = async (fieldName, value, templateField = null, periodId = null) => {
  if (!fieldName || !value) return value;
  
  const fieldNameLower = fieldName.toLowerCase();
  const stringValue = String(value).trim();
  

  
  // 1. PRIMERO buscar en mapeos estáticos (más rápido y confiable)
  // Solo convertir si el campo es exactamente uno de los campos conocidos o tiene patrón específico
  for (const [key, mapping] of Object.entries(idToDescriptiveValue)) {
    // Verificar coincidencia exacta o patrones específicos
    const isExactMatch = fieldNameLower === key;
    const isIdPattern = fieldNameLower.startsWith('id_') && fieldNameLower.includes(key.replace('id_', ''));
    const isSpecificPattern = (
      (key === 'modalidad' && fieldNameLower === 'modalidad') ||
      (key === 'tipo_movilidad' && fieldNameLower === 'tipo_movilidad') ||
      (key === 'nacional_internacional' && fieldNameLower === 'nacional_internacional') ||
      (key === 'movilidad_por_convenio' && fieldNameLower === 'movilidad_por_convenio') ||
      (key === 'promueve' && fieldNameLower.startsWith('promueve_')) ||
      (key === 'desarrolla' && fieldNameLower.startsWith('desarrolla_')) ||
      (key === 'impacto' && fieldNameLower.includes('impacto_de_la_movilidad'))
    );
    
    if (isExactMatch || isIdPattern || isSpecificPattern) {
      const result = mapping[stringValue];
      if (result && result !== value) {
        return result;
      }
    }
  }
  
  // 2. Si no encuentra en mapeos estáticos, verificar validador externo
  if (templateField && templateField.validate_with) {
    try {
      const validateWithText = typeof templateField.validate_with === 'string'
        ? templateField.validate_with
        : (templateField.validate_with?.name || '');
      const [validatorName, columnName] = validateWithText.split(' - ');
      const validator = await Validator.findValidatorByName(validatorName, periodId);

      if (validator) {
        const column = (columnName
          ? validator.columns.find(col => col.name === columnName)
          : null)
          || validator.columns.find(col => col.is_validator)
          || validator.columns[0];
        if (column && column.values) {
          const foundIndex = column.values.findIndex(val =>
            String(validatorValueToPlain(val?.id || val?.value || val)).trim() === stringValue
          );
          const foundValue = foundIndex >= 0 ? column.values[foundIndex] : null;
          if (foundIndex >= 0) {
            const descriptionColumn = (validator.columns || []).find((col) => (
              col.name !== column.name && isValidatorDescriptionColumn(col.name)
            ));
            const descriptionValue = descriptionColumn?.values?.[foundIndex];
            const result = descriptionValue !== undefined && descriptionValue !== null
              ? validatorValueToPlain(descriptionValue)
              : (foundValue.name || foundValue.label || foundValue.text || validatorValueToPlain(foundValue));

            return result;
          }
        }
      }
    } catch (error) {
      console.warn('Error al buscar validador:', error.message);
    }
  }
  

  return value;
};

// Función para enriquecer datos de beneficiarios desde API externa
const enrichBeneficiariosData = async (data) => {
  try {
    console.log('🔍 Consultando API de roles para enriquecer datos...');
    
    // Obtener datos de la API externa
    const response = await axios.get(process.env.ROLES_ENDPOINT);
    if (!response.data.success) {
      console.warn('⚠️ API de roles no disponible, continuando sin enriquecimiento');
      return data;
    }

    const rolesData = response.data.roles;
    console.log(`📊 API devolvió ${rolesData.length} registros de roles`);
    
    // Crear mapa de identificación -> datos del usuario
    const userMap = {};
    rolesData.forEach(role => {
      if (!userMap[role.identification]) {
        userMap[role.identification] = {
          user_name: role.user_name,
          email: role.email,
          username: role.username,
          roles: []
        };
      }
      userMap[role.identification].roles.push(role.profile_name);
    });

    console.log(`👥 Procesados ${Object.keys(userMap).length} usuarios únicos`);
    
    // DEBUG: Mostrar algunas cédulas de ejemplo de la API
    const sampleIds = Object.keys(userMap).slice(0, 10);
    console.log('🔍 Ejemplos de cédulas en la API:', sampleIds);

    // DEBUG: Mostrar estructura de la primera fila para debugging
    if (data.length > 0) {
      console.log('🔍 DEBUG - Campos disponibles en la primera fila:');
      console.log('Campos:', Object.keys(data[0]));
      console.log('Primera fila completa:', data[0]);
    }

    // Enriquecer cada fila de datos
    const enrichedData = data.map((row, index) => {
      // Buscar identificación en diferentes posibles nombres de campo
      const possibleIdFields = [
        'NUM_DOCUMENTO', 'IDENTIFICACION', 'CEDULA', 'ID', 'NUMERO_IDENTIFICACION', 'DOCUMENTO',
        'num_documento', 'identificacion', 'cedula', 'id', 'numero_identificacion', 'documento',
        'Num_Documento', 'Identificacion', 'Cedula', 'Id', 'Numero_Identificacion', 'Documento'
      ];
      
      let identification = null;
      let fieldUsed = null;
      
      // Buscar en todos los posibles campos
      for (const field of possibleIdFields) {
        if (row[field] && row[field] !== '') {
          identification = String(row[field]).trim();
          fieldUsed = field;
          break;
        }
      }
      
      // Si no encuentra en campos específicos, buscar en cualquier campo que contenga números
      if (!identification) {
        for (const [key, value] of Object.entries(row)) {
          if (value && typeof value === 'string' && /^\d{6,12}$/.test(value.trim())) {
            identification = value.trim();
            fieldUsed = key;
            break;
          }
        }
      }
      
      if (index < 5) { // Solo mostrar debug para las primeras 5 filas
        console.log(`🔍 Fila ${index + 1}: Campo usado: ${fieldUsed}, Cédula: ${identification}`);
      }
      
      if (identification && userMap[identification]) {
        const userData = userMap[identification];
        if (index < 5) {
          console.log(`✅ Enriqueciendo datos para cédula: ${identification}`);
        }
        
        return {
          ...row,
          ROLES_DISPONIBLES: userData.roles.join(', ')
        };
      } else {
        if (index < 5) {
          console.log(`❌ No se encontraron datos para cédula: ${identification}`);
        }
        return {
          ...row,
          ROLES_DISPONIBLES: 'Externo' // Valor por defecto si no se encuentra
        };
      }
    });

    console.log(`🎉 Enriquecimiento completado para ${enrichedData.length} filas`);
    return enrichedData;
    
  } catch (error) {
    console.error('❌ Error enriqueciendo datos de beneficiarios:', error.message);
    return data; // Devolver datos originales si hay erro
  }
};

// Función para normalizar nombres de campos para Excel (preservando tildes)
const normalizeFieldName = (fieldName) => {
  return fieldName
    .toUpperCase()
    .replace(/[^A-ZÁÉÍÓÚÑÜ0-9]/g, '_') // Preservar letras con tilde y Ñ
    .replace(/_+/g, '_') // Reemplazar múltiples guiones bajos con uno solo
    .replace(/^_|_$/g, ''); // Eliminar guiones bajos al inicio y final
};

// Función para convertir hipervínculos de Excel a texto
const convertHyperlinkToText = (value) => {
  let result;
  
  // Manejar valores null, undefined o proxy revocados
  if (value === null || value === undefined) {
    return '';
  }
  
  // Detectar proxy revocado
  try {
    if (typeof value === 'object' && value.toString() === '[object Object]') {
      // Intentar acceder a una propiedad para detectar proxy revocado
      Object.keys(value);
    }
  } catch (e) {
    console.log('   ⚠️ Detected revoked proxy, returning empty string');
    return '';
  }
  
  if (value && typeof value === 'object') {
    // Si es un array, manejar arrays anidados
    if (Array.isArray(value)) {
      // Si es un array anidado como [['15']], aplanar
      const flattened = value.flat(Infinity);
      result = flattened.length > 0 ? String(flattened[0]) : '';
    }
    // Si es un hipervínculo de Excel
    else if (value.hyperlink || value.text) {
      result = value.text || value.hyperlink || String(value);
    }
    // Si es un objeto MongoDB
    else if ('$numberInt' in value || '$numberDouble' in value) {
      result = value.$numberInt || value.$numberDouble;
    }
    // Si tiene propiedades como richText, formula, etc. (objetos de Excel)
    else if (value.richText) {
      result = value.richText.map(rt => rt.text || '').join('');
    }
    else if (value.formula) {
      result = value.result || value.formula;
    }
    else if (value.result !== undefined) {
      result = value.result;
    }
    // Si es un objeto con valor directo
    else if (value.value !== undefined) {
      result = value.value;
    }
    else {
      // Intentar extraer cualquier propiedad que parezca texto
      const possibleTextProps = ['text', 'value', 'result', 'displayText', 'content'];
      for (const prop of possibleTextProps) {
        if (value[prop] !== undefined) {
          result = value[prop];
          break;
        }
      }
      // Si es otro tipo de objeto, convertir a string
      if (result === undefined) {
        result = String(value);
      }
    }
  } else {
    result = value ?? '';
  }
  
  // Limpiar saltos de línea y caracteres especiales que rompen Excel
  if (typeof result === 'string') {
    // Eliminar comillas que rodean todo el contenido
    result = result.replace(/^"(.*)"$/g, '$1');
    
    // Reemplazar múltiples saltos de línea con punto y coma para separar URLs/valores
    result = result.replace(/[\r\n]+/g, '; ')
                   .replace(/[\t]/g, ' ')
                   .replace(/""/g, '"') // Desescapar comillas dobles
                   .replace(/;\s*;/g, ';') // Eliminar punto y coma duplicados
                   .replace(/^;\s*|\s*;$/g, '') // Eliminar punto y coma al inicio/final
                   .replace(/\s+/g, ' ') // Reemplazar múltiples espacios con uno solo
                   .trim();
  }
  
  return result;
};

const isMeaningfulMergedValue = (value) => {
  const cleanValue = convertHyperlinkToText(value);
  if (String(cleanValue).trim() === '[object Object]') return false;
  return !isBlankOptionalValue(cleanValue);
};

const hasLoadedDataValues = (loadedData) =>
  Array.isArray(loadedData?.filled_data) &&
  loadedData.filled_data.some((fieldData) =>
    Array.isArray(fieldData?.values) && fieldData.values.some((value) => isMeaningfulMergedValue(value))
  );

const getEntryDependencyCode = (entry = {}) => entry.dependency || entry.dependency_code || '';

const getFieldDataSheetName = (fieldData = {}) =>
  fieldData.sheet_name || fieldData.sheet || fieldData.sheetName || null;

const normalizeFilledEntry = (entry) => {
  const plainEntry = toPlainObject(entry);
  return {
    ...plainEntry,
    dependency: getEntryDependencyCode(plainEntry),
    send_by: toPlainObject(plainEntry.send_by),
    filled_data: Array.isArray(plainEntry.filled_data)
      ? plainEntry.filled_data.map(toPlainObject)
      : [],
  };
};

const getLoadedDataIncludingQrDrafts = (publishedTemplate) => {
  const loadedData = (publishedTemplate?.loaded_data || [])
    .map(normalizeFilledEntry)
    .filter(entry => entry.dependency);
  const loadedDependencies = new Set(loadedData.map(entry => entry.dependency));

  const qrDraftData = (publishedTemplate?.qr_draft_data || [])
    .map(normalizeFilledEntry)
    .filter(entry => entry.dependency && !loadedDependencies.has(entry.dependency));

  return [...loadedData, ...qrDraftData];
};

const getAllTemplateFields = (templateData = {}) => {
  const fieldMap = new Map();
  const addField = (field) => {
    const plainField = field?.toObject?.() || field;
    if (plainField?.name && !fieldMap.has(plainField.name)) {
      fieldMap.set(plainField.name, plainField);
    }
  };

  (templateData.fields || []).forEach(addField);
  (templateData.workbook_sheets || []).forEach((sheet) => {
    (sheet.fields || []).forEach(addField);
  });

  return Array.from(fieldMap.values());
};

const buildRowsFromFilledFields = (filledFields = [], rowBase = {}) => {
  const maxLen = Math.max(...filledFields.map(field => field.values?.length || 0), 1);

  return Array.from({ length: maxLen }, (_, rowIndex) => {
    const row = { ...rowBase };

    filledFields.forEach((fieldData) => {
      row[fieldData.field_name] = fieldData.values?.[rowIndex] ?? null;
    });

    return row;
  });
};

const hasMergedRowInformation = (row = {}) =>
  Object.entries(row).some(([key, value]) => key !== 'Dependencia' && isMeaningfulMergedValue(value));

datetime_now = () => {
  const now = new Date();

  const offset = -5; // GMT-5
  return new Date(now.getTime() + offset * 60 * 60 * 1000);
}

publTempController.publishTemplate = async (req, res) => {
  const template_id = req.body.template_id
  const email = req.body.user_email

  try {
    const template = await Template.findById(template_id)
    if (!template) {
      return res.status(404).json({ status: 'Template not found' })
    }

    const user = await UserService.findUserByEmailAndRole(email, 'Administrador');

    // Ensure user has all required fields
    const userForPublish = {
      ...user.toObject(),
      position: user.position || 'Administrador',
      identification: user.identification || 0
    };

    const category = template.category;  

    const fechaFinal = req.body.fecha_final || req.body.deadline || template.fecha_final || null;
    const newPublTemp = new PublishedTemplate({
      name: req.body.name || template.name,
      published_by: userForPublish,
      template: template,
      period: req.body.period_id,
      deadline: fechaFinal,
      fecha_inicio: req.body.fecha_inicio || template.fecha_inicio || null,
      fecha_final_productores: req.body.fecha_final_productores || template.fecha_final_productores || null,
      fecha_final_responsables: req.body.fecha_final_responsables || template.fecha_final_responsables || null,
      fecha_final: fechaFinal,
      responsible_producers: template.responsible_producers || [],
      notify_producers: template.notify_producers || false,
      published_date: datetime_now(),
      category: category
    })

    await newPublTemp.save()

    // Audit log
    await auditLogger.logCreate(req, user, 'publishedTemplate', {
      publishedTemplateId: newPublTemp._id,
      templateName: newPublTemp.name,
      templateId: template_id,
      periodId: req.body.period_id
    });

    return res.status(201).json({ status: 'Template published successfully' })
  } catch (error) {
    console.error('Error in publishTemplate:', error);
    return res.status(500).json({ status: error.message })
  }
}


publTempController.getPublishedTemplatesDimension = async (req, res) => {
  const email = req.query.email;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || '';
  const periodId = req.query.periodId || null;
  const filterByUserScope = req.query.filterByUserScope;
  const userRole = req.query.userRole;
  const skip = (page - 1) * limit;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ status: 'User not found' });
    }

    const activeRole = user.activeRole;

    let query = {
      name: { $regex: search, $options: 'i' },
      ...(periodId && { period: periodId }),
    };
    
    // Filtrado específico cuando filterByUserScope=true
    if (filterByUserScope === 'true') {
      if (userRole === 'Productor') {
        const userDependency = await Dependency.findOne({
          members: { $elemMatch: { email: email } }
        });
        
        const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
        const dependenciesByCode = await Dependency.find({ dep_code: { $in: allUserDependencies } });
        
        if (userDependency) {
          query['template.producers'] = userDependency._id;
        } else if (dependenciesByCode.length > 0) {
          const dependencyIds = dependenciesByCode.map(dep => dep._id);
          query['template.producers'] = { $in: dependencyIds };
        } else {
          return res.status(200).json({ templates: [], total: 0, page, pages: 0 });
        }
      } else if (userRole === 'Responsable') {
        const orConditions = [];
        
        const userDependencies = await Dependency.find({ responsible: email });
        const userDependencyIds = userDependencies.map(dep => dep._id);
        const dimensions = await Dimension.find({ responsible: { $in: userDependencyIds } });
        
        if (dimensions.length > 0) {
          const dimensionIds = dimensions.map(dim => dim._id);
          orConditions.push({ 'template.dimensions': { $in: dimensionIds } });
        }
        
        const allUserDependencies = await Dependency.find({
          $or: [{ responsible: email }, { visualizers: email }]
        });
        
        if (allUserDependencies.length > 0) {
          const dependencyIds = allUserDependencies.map(dep => dep._id);
          orConditions.push({ 'template.producers': { $in: dependencyIds } });
        }
        
        if (orConditions.length > 0) {
          query.$or = orConditions;
        } else {
          return res.status(200).json({ templates: [], total: 0, page, pages: 0 });
        }
      }
    }
    else if (activeRole !== 'Administrador') {
      const orConditions = [];
      
      const userDependencies = await Dependency.find({ responsible: email });
      const userDependencyIds = userDependencies.map(dep => dep._id);
      
      const dimensions = await Dimension.find({ responsible: { $in: userDependencyIds } });
      if (dimensions.length > 0) {
        const dimensionIds = dimensions.map(dim => dim._id);
        orConditions.push({ 'template.dimensions': { $in: dimensionIds } });
      }
      
      const allUserDependencies = await Dependency.find({
        $or: [{ responsible: email }, { visualizers: email }]
      });
      
      if (allUserDependencies.length > 0) {
        const dependencyIds = allUserDependencies.map(dep => dep._id);
        orConditions.push({ 'template.producers': { $in: dependencyIds } });
      }
      
      if (orConditions.length > 0) {
        query.$or = orConditions;
      }
    }

    // Aplicar filtro de dependencias permitidas por el perfil del usuario
    const userPosition = (user.position || '').trim() || 'Sin cargo';
    const profilesWithPos = await AccessProfile.find({ positions: userPosition }).lean();
    const profilePositionNames = profilesWithPos.flatMap(p => (p.positions || []).map(pos => (pos || '').trim() || 'Sin cargo'));
    const allPositionNames = Array.from(new Set([userPosition, ...profilePositionNames]));
    const permDocs = await PositionViewPermission.find({ position: { $in: allPositionNames } });

    // Si todos los docs tienen allowed_dependencies específicas (ninguna vacía), aplicar filtro
    const hasSpecificDepFilter = permDocs.length > 0 && permDocs.every(doc => (doc.allowed_dependencies || []).length > 0);
    if (hasSpecificDepFilter) {
      const allowedDepIds = Array.from(new Set(permDocs.flatMap(doc => (doc.allowed_dependencies || []).map(id => String(id)))));
      const allowedObjectIds = allowedDepIds.map(id => new mongoose.Types.ObjectId(id));
      // Combinar con el query existente usando $and para no sobreescribir filtros ya aplicados
      const baseQuery = { ...query };
      delete query.$or;
      Object.keys(baseQuery).forEach(k => delete query[k]);
      query.$and = [
        baseQuery,
        { 'template.producers': { $in: allowedObjectIds } }
      ];
    }

    const published_templates = await PublishedTemplate.find(query)
      .collation({ locale: 'es', strength: 1 })
      .skip(skip)
      .limit(limit)
      .populate('period')
      .populate({
        path: 'template',
        populate: 
        [
          { path: 'dimensions', model: 'dimensions' },
        ]
      });


    const total = await PublishedTemplate.countDocuments(query);
    
    const updated_templates = await Promise.all(published_templates.map(async template => {
      template = template.toObject();
      template.validators = await collectValidatorsForTemplate(
        template.template,
        template.period?._id || template.period
      );

      const dependencies = await Dependency.find(
        { dep_code: { $in: template.producers_dep_code } },
        'name -_id'
      );
      template.producers_dep_code = dependencies.map(dep => dep.name);
      
      template.loaded_data = await Promise.all(template.loaded_data.map(async data => {
        const loadedDependency = await Dependency.findOne(
          { dep_code: data.dependency },
          'name -_id'
        );
        data.dependency = loadedDependency ? loadedDependency.name : data.dependency;
        
        // Aplicar conversión de hipervínculos y códigos de país a los datos cargados
        if (data.filled_data) {
          data.filled_data = await Promise.all(data.filled_data.map(async fieldData => {
            // Verificar si el campo es de país
            const isCountryField = fieldData.field_name && 
              (fieldData.field_name.toLowerCase().includes('pais') || 
               fieldData.field_name.toLowerCase().includes('país') ||
               fieldData.field_name.toLowerCase().includes('country'));
            
            const processedValues = await Promise.all(fieldData.values.map(async value => {
              let processedValue = convertHyperlinkToText(value);
              if (isCountryField) {
                processedValue = convertCountryCodeToId(processedValue);
              }
              // Convertir IDs a valores descriptivos
              processedValue = await convertIdToDescriptive(fieldData.field_name, processedValue);
              return processedValue;
            }));
            
            return {
              ...fieldData,
              values: processedValues
            };
          }));
        }
        
        return data;
      }));
      
      return template;
    }));
    
    res.status(200).json({
      templates: updated_templates,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};


publTempController.getAssignedTemplatesToProductor = async (req, res) => {
  const email = req.query.email;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || '';
  const skip = (page - 1) * limit;

  try {
    const user = await User.findOne({ email });
    if (!user || !user.activeRole === 'Productor') {
      return res.status(404).json({ status: 'User not found' });
    }

    const query = {
      name: { $regex: search, $options: 'i' }
    };

    let templates = await PublishedTemplate.find(query)
      .collation({ locale: 'es', strength: 1 })
      .skip(skip)
      .limit(limit)
      .populate('period')
      .populate({
        path: 'template',
        populate: {
          path: 'dimension',
          model: 'dimensions'
        }
      })
      .populate({
        path: 'template.producers',
        model: 'dependencies',
        match: { members: user.email } 
      })
      

    console.log(templates)

    templates = templates.filter(t => t.template.producers.length > 0);

    const total = await PublishedTemplate.countDocuments(query);

    const updatedTemplatesPromises = templates.map(async t => {
      t = t.toObject();
      t.validators = await collectValidatorsForTemplate(
        t.template,
        t.period?._id || t.period
      );
  
      let uploaded = false;
    
      // Filtrar loaded_data según dep_code
      const filteredLoadedData = t.loaded_data.filter(ld => {
        if (ld.send_by.dep_code === user.dep_code) {
          uploaded = true;
        }
        return ld.dependency === user.dep_code;
      });

      // Transformar filteredLoadedData en un formato similar al método getFilledDataMergedForResponsible
      const transformedLoadedData = filteredLoadedData.map(ld => {
        const filledData = ld.filled_data.reduce((acc, item) => {
          item.values.forEach((value, index) => {
            if (!acc[index]) {
              acc[index] = { Dependencia: ld.dependency };
            }
            // Fix para datos existentes con '[object Object]'
            if (typeof value === 'string' && value === '[object Object]') {
              acc[index][item.field_name] = '';
            } else {
              let processedValue = convertHyperlinkToText(value);
              
              // Verificar si el campo es de país y convertir código a ID
              const isCountryField = item.field_name && 
                (item.field_name.toLowerCase().includes('pais') || 
                 item.field_name.toLowerCase().includes('país') ||
                 item.field_name.toLowerCase().includes('country'));
              
              if (isCountryField) {
                processedValue = convertCountryCodeToId(processedValue);
              }
              
              // Convertir IDs a valores descriptivos (sin await aquí para mantener compatibilidad)
              // processedValue = await convertIdToDescriptive(item.field_name, processedValue);
              
              acc[index][item.field_name] = processedValue;
            }
          });
          return acc;
        }, []);
    
        return filledData;
      }).flat();



      return {
        ...t,
        loaded_data: transformedLoadedData,
        uploaded
      };
    });

    const updatedTemplates = await Promise.all(updatedTemplatesPromises);

    res.status(200).json({
      templates: updatedTemplates,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

publTempController.feedOptionsToPublishTemplate = async (req, res) => {
  const email = req.query.email;

  try {
      await UserService.findUserByEmailAndRole(email, 'Administrador');

      // Get active periods
      const periods = await Period.find({
        is_active: true,
        producer_end_date: { $gte: datetime_now() }
      })
      .sort({ updatedAt: -1 })

      // Get dependencie producers
      const producers = await Dependency.find();

      res.status(200).json({ periods, producers });

  } catch (error) {
      console.log(error.message);
      res.status(500).json({ status: 'Internal server error', details: error.message });
  }
}


publTempController.exportPendingTemplates = async (req, res) => {
  const {periodId} = req.params

  try{

    const templates = await PublishedTemplate.find({period: periodId})

    const allPending = [];

    for (const template of templates){
      const producers = template.template?.producers || []

      const loadedDependencyCode = (template.loaded_data || []).
      filter(d => d?.dependency).map(d => d.dependency) 

      // Buscar nombres de dependencias
      const dependencies = await Dependency.find({ _id: { $in: producers } });

      dependencies.forEach ( dep => {
        const depCode = dep.dep_code;
        const hasLoaded = loadedDependencyCode.includes(depCode)
        if (!hasLoaded){
          allPending.push({
            template: template.name,
            dependency: dep.name
          })
        }
      })

    }

 // Generar Excel con ExcelJS
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Pendientes');

    worksheet.columns = [
      { header: 'Dependencia', key: 'dependency', width: 40 },
      { header: 'Nombre de la Plantilla', key: 'template', width: 40 },
    ];

    worksheet.addRows(
  allPending.sort((a, b) => a.dependency.localeCompare(b.dependency))
);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=pendientes_templates.xlsx");

    // Audit log para exportación de pendientes
    const user = await User.findOne({ email: req.query.email || 'system' });
    if (user) {
      await auditLogger.logRead(req, user, 'exportPendingTemplates', {
        periodId: periodId,
        totalPending: allPending.length
      });
    }

    await workbook.xlsx.write(res);
    

  } catch (error) {
    console.error("Error al exportar pendientes:", error);
    res.status(500).json({ message: error.message || "Error interno al exportar pendientes." });
  }

}

publTempController.loadProducerData = async (req, res) => {
  const { email, pubTem_id, data, sheetsData, edit, asDraft, bypassValidation } = req.body;



  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ status: 'User not found' });
    }

    const pubTem = await PublishedTemplate.findById(pubTem_id)
      .populate('period')
      .populate({
        path: 'template',
        populate: { path: 'producers', model: 'dependencies' }
      });

    if (!pubTem) {
      return res.status(404).json({ status: 'Published template not found' });
    }

    await refreshPublishedTemplateSnapshot(pubTem);

    const saveAsDraft = asDraft === true || asDraft === 'true';

    // allUserDependencies se necesita tanto en borradores como en envíos definitivos
    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
    const userDependencies = await Dependency.find({ dep_code: { $in: allUserDependencies } });
    const userDependencyIds = userDependencies.map(dep => dep._id.toString());

    // Las verificaciones de fecha y permisos solo aplican a envíos definitivos, no a borradores
    if (!saveAsDraft) {
      const now = new Date(datetime_now());

      // Verificar fecha_inicio: el productor no puede enviar antes de esta fecha
      if (pubTem.fecha_inicio) {
        const fechaInicio = new Date(pubTem.fecha_inicio);
        fechaInicio.setHours(0, 0, 0, 0);
        if (now < fechaInicio) {
          return res.status(403).json({ status: 'El período de carga aún no ha comenzado' });
        }
      }

      // Verificar fecha límite para productores (fecha_final_productores > fecha_final > deadline)
      const fechaLimiteProductores = pubTem.fecha_final_productores || pubTem.fecha_final || pubTem.deadline;
      const fechaLimite = new Date(fechaLimiteProductores);
      fechaLimite.setHours(23, 59, 59, 999);
      if (fechaLimite < now) {
        return res.status(403).json({ status: 'The period is closed' });
      }

      const canSubmit = pubTem.template?.producers.some(p => userDependencyIds.includes(p._id.toString()));
      if (!canSubmit) {
        return res.status(403).json({ status: 'User is not assigned to this published template' });
      }
    }

    if (!pubTem.published_date) {
      pubTem.published_date = datetime_now();
    }

    // VALIDACIÓN PREVIA: Verificar que las columnas del Excel coincidan
    const workbookSheets = pubTem.template?.workbook_sheets || [];
    const incomingSheetsData = Array.isArray(sheetsData) ? sheetsData : [];
    const isSheetSubmission = incomingSheetsData.length > 0 && workbookSheets.length > 0;
    const rowsForLoad = Array.isArray(data) ? data : [];
    const toPlainField = (field, sheetName = null) => ({
      ...(field?.toObject?.() || field || {}),
      ...(sheetName ? { sheet_name: sheetName } : {}),
    });
    const fieldsForLoad = isSheetSubmission
      ? incomingSheetsData.flatMap(({ name }) => {
          const sheet = workbookSheets.find((item) => item.name === name);
          return (sheet?.fields || []).map((field) => toPlainField(field, sheet?.name));
        })
      : ((pubTem.template.fields?.length ? pubTem.template.fields : workbookSheets.flatMap((sheet) => (
          (sheet.fields || []).map((field) => toPlainField(field, sheet.name))
        ))) || []);

    const applyEffectiveRequired = (field) => {
      if (!field) return field;
      field.required = getEffectiveRequired(field);
      return field;
    };
    fieldsForLoad.forEach(applyEffectiveRequired);
    (pubTem.template.fields || []).forEach(applyEffectiveRequired);
    (pubTem.template.workbook_sheets || []).forEach((sheet) => {
      (sheet.fields || []).forEach(applyEffectiveRequired);
    });

    const normalizeProducerValue = (rawValue, field) => {
      let val = rawValue;

      if (typeof val === 'object' && val !== null) {
        val = convertHyperlinkToText(val);
      }

      if (typeof val === 'string' && val === '[object Object]') {
        console.warn(`Campo ${field.name} contiene '[object Object]' - problema en el frontend`);
        val = null;
      }

      if (Array.isArray(val)) {
        let normalizedVal = val;
        while (Array.isArray(normalizedVal) && normalizedVal.length === 1) {
          normalizedVal = normalizedVal[0];
        }

        if (typeof normalizedVal === 'string' && normalizedVal.startsWith('[') && normalizedVal.endsWith(']')) {
          try {
            const parsed = JSON.parse(normalizedVal);
            if (Array.isArray(parsed) && parsed.length === 1) {
              normalizedVal = parsed[0];
            }
          } catch (_) {}
        }

        val = normalizedVal;
      }

      if (typeof val === 'string' && ['null', 'nan'].includes(val.trim().toLowerCase())) {
        val = null;
      }

      if (!field.required && isBlankOptionalValue(val)) {
        val = null;
      }

      if (field.multiple) {
        if (!field.required && isBlankOptionalValue(val)) return [];
        if (val === null || val === undefined) return [];

        const rawString = val.toString();
        if (!rawString.includes(',')) {
          return [rawString.trim()];
        }

        return rawString.split(',').map(v => v.trim());
      }

      return val;
    };

    // Para borradores, guardar sin validación de columnas ni de datos
    if (saveAsDraft) {
      let result;
      if (isSheetSubmission) {
        result = fieldsForLoad.map((field) => ({
          sheet_name: field.sheet_name,
          field_name: field.name,
          values: (incomingSheetsData.find(({ name }) => name === field.sheet_name)?.data || [])
            .map(row => normalizeProducerValue(row[field.name], field)),
        }));
      } else {
        const fieldsToMap = pubTem.template.fields?.length
          ? pubTem.template.fields
          : fieldsForLoad;
        result = fieldsToMap.map((field) => ({
          field_name: field.name,
          values: rowsForLoad.map(row => normalizeProducerValue(row[field.name], field)),
        }));
      }

      const producersData = {
        dependency: user.dep_code,
        send_by: user,
        filled_data: result,
        loaded_date: datetime_now(),
      };

      replaceDraftDataForDependency(pubTem, producersData);
      await pubTem.save();

      const recordsLoaded = isSheetSubmission
        ? incomingSheetsData.reduce((total, sheet) => total + (sheet.data?.length || 0), 0)
        : rowsForLoad.length;

      return res.status(200).json({
        status: 'Draft saved successfully',
        recordsLoaded,
        draft: true,
      });
    }

    if (!isSheetSubmission && rowsForLoad.length > 0) {
      const excelColumns = Object.keys(rowsForLoad[0]);
      const templateColumns = fieldsForLoad.map(f => f.name);
      
      // Solo considerar como faltantes las columnas que son obligatorias (required = true)
      const missingColumns = fieldsForLoad
        .filter(field => getEffectiveRequired(field) && !excelColumns.includes(field.name))
        .map(field => field.name);
      const extraColumns = excelColumns.filter(col => !templateColumns.includes(col));
      
      if (missingColumns.length > 0 || extraColumns.length > 0) {
        const errorDetails = [];
        
        if (missingColumns.length > 0) {
          errorDetails.push({
            column: "Columnas faltantes",
            errors: missingColumns.map(col => ({
              register: 1,
              value: "No encontrada",
              message: `La columna '${col}' no se encontró en el archivo Excel. Sus columnas actuales: [${excelColumns.join(', ')}]. Debe ser exactamente: '${col}'`
            }))
          });
        }
        
        if (extraColumns.length > 0) {
          extraColumns.forEach(col => {
            errorDetails.push({
              column: `Columna desconocida (${col})`,
              errors: [{
                register: 1,
                value: col,
                message: `La columna '${col}' no pertenece a esta plantilla. Elimine esta columna. Columnas válidas: [${templateColumns.join(', ')}]`
              }]
            });
          });
        }
        
        return res.status(400).json({ 
          status: 'Column mismatch error', 
          details: errorDetails,
          message: 'Las columnas del archivo Excel no coinciden con la plantilla esperada'
        });
      }
    }

// Construcción robusta de `result` considerando `multiple
    if (isSheetSubmission) {
      // Construir mapa de comments desde todas las fuentes disponibles
      const commentByFieldName = new Map();
      const addToMap = (fields) => (fields || []).forEach(f => {
        if (f.name && f.comment && !commentByFieldName.has(f.name))
          commentByFieldName.set(f.name, f.comment);
      });
      // Fuente 1: template.fields principal (snapshot)
      addToMap(pubTem.template.fields);
      // Fuente 2: workbook_sheets del snapshot
      (pubTem.template.workbook_sheets || []).forEach(s => addToMap(s.fields));
      // Fuente 3: template live de BD (más actualizado)
      const templateId = pubTem.template?._id;
      if (templateId) {
        const liveT = await Template.findById(templateId).lean();
        if (liveT) {
          addToMap(liveT.fields);
          (liveT.workbook_sheets || []).forEach(s => addToMap(s.fields));
        }
      }

      fieldsForLoad.forEach(field => {
        // Usar el comment del campo o buscarlo en el mapa
        const comment = field.comment || commentByFieldName.get(field.name) || '';
        if (!field.comment && comment) field.comment = comment;
        field.required = getEffectiveRequired(field);
      });

      const result = fieldsForLoad.map((field) => {
        const sheetRows = incomingSheetsData.find(({ name }) => name === field.sheet_name)?.data || [];
        return {
          sheet_name: field.sheet_name,
          field_name: field.name,
          values: sheetRows.map(row => normalizeProducerValue(row[field.name], field)),
        };
      });

      const validations = result.map(async fieldData => {
        const templateField = fieldsForLoad.find(field => (
          field.name === fieldData.field_name && field.sheet_name === fieldData.sheet_name
        ));
        if (!templateField) {
          throw new Error(`Field ${fieldData.field_name} not found in template`);
        }

        if (templateField.validate_with) {
          const validateWithText = typeof templateField.validate_with === 'string'
            ? templateField.validate_with
            : (templateField.validate_with?.name || '');
          const [validatorName, columnName] = validateWithText.split(" - ");
          const validator = await Validator.findValidatorByName(validatorName, pubTem.period?._id || pubTem.period);

          if (validator) {
            const validatorColumn = (columnName
              ? validator.columns.find(c => c.name === columnName)
              : null)
              || validator.columns.find(c => c.is_validator)
              || validator.columns[0];
            if (validatorColumn) {
              templateField.validator_values = validatorColumn.values;
              templateField.validator_type = validatorColumn.type;
            }
          }
        }

        templateField.required = getEffectiveRequired(templateField);
        templateField.values = fieldData.values;
        // Si bypassValidation=true (carga desde Excel), saltar validación de opciones del validador
        if (bypassValidation) {
          return { status: true, sheet_name: templateField.sheet_name };
        }
        const validationResult = await Validator.validateColumn(templateField, pubTem.period?._id || pubTem.period);
        return {
          ...validationResult,
          sheet_name: templateField.sheet_name,
        };
      });

      const validationResults = await Promise.all(validations);
      const validationErrors = validationResults.filter(v => v.status === false);

      if (validationErrors.length > 0) {
        const sanitizedErrors = validationErrors.map(err => ({
          sheet_name: err.sheet_name,
          column: err.column ?? "Campo desconocido",
          errors: (err.errors ?? []).map(e => ({
            register: e.register ?? 1,
            value: e.value ?? "Sin valor",
            message: e.message ?? "Error desconocido"
          }))
        }));

        await Log.create({
          user: user,
          published_template: pubTem._id,
          date: datetime_now(),
          errors: sanitizedErrors
        });

        return res.status(400).json({ status: 'Validation error', details: sanitizedErrors });
      }

      const producersData = {
        dependency: user.dep_code,
        send_by: user,
        filled_data: result,
        loaded_date: datetime_now()
      };

      const recordsLoaded = incomingSheetsData.reduce((total, sheet) => total + (sheet.data?.length || 0), 0);

      if (saveAsDraft) {
        replaceDraftDataForDependency(pubTem, producersData);
        await pubTem.save();

        return res.status(200).json({
          status: 'Draft saved successfully',
          recordsLoaded,
          draft: true,
        });
      }

      const existingDataIndex = pubTem.loaded_data.findIndex(d => d.dependency === user.dep_code);
      if (existingDataIndex > -1) {
        pubTem.loaded_data[existingDataIndex] = producersData;
      } else {
        pubTem.loaded_data.push(producersData);
      }

      if (pubTem.qr_draft_data?.length) {
        pubTem.qr_draft_data = pubTem.qr_draft_data.filter(
          d => !allUserDependencies.includes(d.dependency)
        );
      }

      await pubTem.save();

      await auditLogger.logCreate(req, user, 'publishedTemplateData', {
        publishedTemplateId: pubTem_id,
        templateName: pubTem.name,
        dependency: user.dep_code,
        recordsLoaded
      });

      notifyResponsibleProducersOnUpload(pubTem, user, userDependencies);

      return res.status(200).json({
        status: 'Data loaded successfully',
        recordsLoaded
      });
    }

const result = pubTem.template.fields.map((field) => {
  const values = data.map(row => {
    let val = row[field.name];
    
    // FIX: Manejar objetos de Excel (hipervínculos, etc.)
    if (typeof val === 'object' && val !== null) {
      val = convertHyperlinkToText(val);
    }
    
    // FIX TEMPORAL: Detectar [object Object] strings del frontend
    if (typeof val === 'string' && val === '[object Object]') {
      console.warn(`⚠️  Campo ${field.name} contiene '[object Object]' - problema en el frontend`);
      val = null; // Convertir a null para que se maneje como valor vacío
    }
    
    // FIX: Manejar arrays que vienen del frontend (incluyendo arrays anidados)
    if (Array.isArray(val)) {
      console.log(`DEBUG - Campo ${field.name}: Array detectado:`, val);
      
      // Normalizar arrays anidados
      let normalizedVal = val;
      while (Array.isArray(normalizedVal) && normalizedVal.length === 1) {
        normalizedVal = normalizedVal[0];
      }
      
      // Si después de normalizar es un string JSON, parsearlo
      if (typeof normalizedVal === 'string' && normalizedVal.startsWith('[') && normalizedVal.endsWith(']')) {
        try {
          const parsed = JSON.parse(normalizedVal);
          if (Array.isArray(parsed) && parsed.length === 1) {
            normalizedVal = parsed[0];
          }
        } catch (e) {
          // Si no se puede parsear, mantener el valor
        }
      }
      
      val = normalizedVal;
      console.log(`DEBUG - Campo ${field.name}: Valor final normalizado:`, val);
    }
    
    // Limpiar valores: convertir string "null" a null real
    if (typeof val === 'string' && ['null', 'nan'].includes(val.trim().toLowerCase())) {
      val = null;
    }
    
    // Limpiar valores vacíos para campos no obligatorios
    if (!field.required && isBlankOptionalValue(val)) {
      val = null;
    }

if (field.multiple) {
  if (!field.required && isBlankOptionalValue(val)) return [];
  if (val === null || val === undefined) return [];

  // Forzamos a string y separamos por coma
  const rawString = val.toString();

  // Si no hay coma, igual devolvemos el valor como único
  if (!rawString.includes(',')) {
    return [rawString.trim()];
  }

  return rawString.split(',').map(v => v.trim());
}

    return val;
  });

  return {
    field_name: field.name,
    values
  };
});




    // Validación con valores externos si hay validate_with
    const validations = result.map(async field => {
      const templateField = pubTem.template.fields.find(f => f.name === field.field_name);
      if (!templateField) {
        throw new Error(`Field ${field.field_name} not found in template`);
      }

      // 🚀 NUEVO: si tiene validate_with, traer valores válidos
      if (templateField.validate_with) {
        const validateWithText = typeof templateField.validate_with === 'string'
          ? templateField.validate_with
          : (templateField.validate_with?.name || '');
        const [validatorName, columnName] = validateWithText.split(" - ");
        const validator = await Validator.findValidatorByName(validatorName, pubTem.period?._id || pubTem.period);

        if (validator) {
          const validatorColumn = (columnName
            ? validator.columns.find(c => c.name === columnName)
            : null)
            || validator.columns.find(c => c.is_validator)
            || validator.columns[0];
          if (validatorColumn) {
            templateField.validator_values = validatorColumn.values;
            templateField.validator_type = validatorColumn.type;
          }
        }
      }

      templateField.required = getEffectiveRequired(templateField);
      templateField.values = field.values;

      const validationResult = await Validator.validateColumn(templateField, pubTem.period?._id || pubTem.period);
      return validationResult;
    });

    const validationResults = await Promise.all(validations);
    const validationErrors = validationResults.filter(v => v.status === false);



    if (validationErrors.length > 0) {
      const sanitizedErrors = validationErrors.map(err => ({
        column: err.column ?? "Campo desconocido",
        errors: (err.errors ?? []).map(e => ({
          register: e.register ?? 1,
          value: e.value ?? "Sin valor",
          message: e.message ?? "Error desconocido"
        }))
      }));

      // Guardar el log
      await Log.create({
        user: user,
        published_template: pubTem._id,
        date: datetime_now(),
        errors: sanitizedErrors
      });

      // Enviar al frontend
      return res.status(400).json({ status: 'Validation error', details: sanitizedErrors });
    }

    const producersData = {
      dependency: user.dep_code,
      send_by: user,
      filled_data: result,
      loaded_date: datetime_now()
    };

    if (saveAsDraft) {
      replaceDraftDataForDependency(pubTem, producersData);
      await pubTem.save();

      return res.status(200).json({
        status: 'Draft saved successfully',
        recordsLoaded: data.length,
        draft: true,
      });
    }

    // Verificar si ya existe data para esta dependencia
    const existingDataIndex = pubTem.loaded_data.findIndex(d => d.dependency === user.dep_code);

    if (existingDataIndex > -1) {
      // Si ya existe, actualizar los datos existentes
      pubTem.loaded_data[existingDataIndex] = producersData;
    } else {
      // Si no existe, agregar nuevos datos
      pubTem.loaded_data.push(producersData);
    }

    // Limpiar borrador QR para todas las dependencias del usuario
    if (pubTem.qr_draft_data?.length) {
      pubTem.qr_draft_data = pubTem.qr_draft_data.filter(
        d => !allUserDependencies.includes(d.dependency)
      );
    }

    await pubTem.save();

    // Audit log
    await auditLogger.logCreate(req, user, 'publishedTemplateData', {
      publishedTemplateId: pubTem_id,
      templateName: pubTem.name,
      dependency: user.dep_code,
      recordsLoaded: data.length
    });

    notifyResponsibleProducersOnUpload(pubTem, user, userDependencies);

    return res.status(200).json({
      status: 'Data loaded successfully',
      recordsLoaded: data.length
    });

  } catch (error) {
    console.log(error.message);
    return res.status(500).json({ status: 'Internal server error', details: error.message });
  }
};


publTempController.submitEmptyData = async (req, res) => {
  const { pubTemId, email } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      throw new Error('User not found');
    }
    const pubTem = await PublishedTemplate
      .findById(pubTemId)
      .populate('period')
      .populate({
        path: 'template',
        populate: {
          path: 'producers',
          model: 'dependencies'
        }
      })

    if (!pubTem) {
      throw new Error('Published template not found');
    }

    // Solo el productor responsable puede enviar en ceros
    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
    const userDependencies = await Dependency.find({ dep_code: { $in: allUserDependencies } });
    const userDependencyIds = userDependencies.map(dep => dep._id.toString());

    const rawResponsibleSubmit = pubTem.responsible_producers?.length > 0
      ? pubTem.responsible_producers
      : pubTem.template?.responsible_producers;
    const responsibleProducers = (rawResponsibleSubmit || []).map(id => id.toString());
    if (responsibleProducers.length > 0) {
      const isResponsible = userDependencyIds.some(id => responsibleProducers.includes(id));
      if (!isResponsible) {
        return res.status(403).json({ status: 'Solo el productor responsable puede enviar información en esta plantilla' });
      }
    }

    const producersData = {
      dependency: user.dep_code,
      send_by: user,
      loaded_date: datetime_now(),  // Agregar la fecha de carga
      filled_data: []
    };

    const existingDataIndex = pubTem.loaded_data.findIndex(
      data => data.dependency === user.dep_code
    );

    if (existingDataIndex > -1) {
      throw new Error('Data already exists');
    } else {
      pubTem.loaded_data.push(producersData);
    }

    await pubTem.save();
    
    // Audit log
    await auditLogger.logCreate(req, user, 'publishedTemplateEmptyData', {
      publishedTemplateId: pubTemId,
      templateName: pubTem.name,
      dependency: user.dep_code
    });

    notifyResponsibleProducersOnUpload(pubTem, user, userDependencies);
    
    return res.status(200).json({ status: 'Data loaded successfully' });
  } catch (error) {
    console.log(error.message);
    return res.status(500).json({ status: 'Internal server error', details: error.message });
  }
}

publTempController.deleteLoadedDataDependency = async (req, res) => {
  const { pubTem_id, email } = req.query

  try {
    const user = await User.findOne({ email })
    if (!user) { return res.status(404).json({ status: 'User not found' }) }

    const pubTem = await PublishedTemplate.findById(pubTem_id)
      .populate({
        path: 'template',
        populate: { path: 'producers', model: 'dependencies' }
      })

    if (!pubTem) { return res.status(404).json({ status: 'Published template not found' }) }

    // Verificar si el usuario puede eliminar datos desde alguna de sus dependencias
    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
    const userDependencies = await Dependency.find({ dep_code: { $in: allUserDependencies } });
    const userDependencyIds = userDependencies.map(dep => dep._id.toString());
    
    const canDelete = pubTem.template?.producers.some(p => userDependencyIds.includes(p._id.toString()));
    if (!canDelete) {
      return res.status(403).json({ status: 'User is not assigned to this published template' })
    }

    // Buscar datos de cualquiera de las dependencias del usuario
    const index = pubTem.loaded_data.findIndex(data => allUserDependencies.includes(data.dependency))
    if (index === -1) { return res.status(404).json({ status: 'Data not found' }) }

    const deletedData = pubTem.loaded_data[index];
    pubTem.loaded_data.splice(index, 1);

    // Si estaba enviado al SNIES, resetear el estado para que vuelva a ser enviado
    if (pubTem.final_submitted) {
      pubTem.final_submitted = false;
      pubTem.final_submitted_by = null;
      pubTem.final_submitted_date = null;
    }

    await pubTem.save();

    // Audit log
    console.log('🔍 Executing audit log for publishedTemplateData deletion');
    await auditLogger.logDelete(req, user, 'publishedTemplateData', {
      publishedTemplateId: pubTem_id,
      templateName: pubTem.name,
      dependency: deletedData.dependency
    });
    console.log('✅ Audit log completed for publishedTemplateData deletion');

    return res.status(200).json({ status: 'Data deleted successfully' })
  } catch (error) {
    console.log(error.message)
    return res.status(500).json({ status: 'Internal server error', details: error.message })
  }
};


publTempController.getFilledDataMergedForDimension = async (req, res) => {
  const { pubTem_id, email, filterByUserDependency, userRole } = req.query;

  const user = await User.findOne({ email });

  if(!user) {
    return res.status(404).json({status: 'User not available'});
  }
  
  if (!pubTem_id) {
    return res.status(400).json({ status: 'Missing pubTem_id' });
  }

  try {
    const template = await PublishedTemplate.findById(pubTem_id).populate('template');

    if (!template) {
      return res.status(404).json({ status: 'Published template not found' });
    }
    
    // Audit log para descarga de datos combinados
    await auditLogger.logRead(req, user, 'publishedTemplateMergedData', {
      publishedTemplateId: pubTem_id,
      templateName: template.name
    });

    const allTemplateFields = getAllTemplateFields(template.template || {});

    // Filtrar datos por dependencia del usuario si se solicita. Incluye borradores QR
    // sin carga confirmada para que tambien aparezcan en las descargas.
    let filteredLoadedData = getLoadedDataIncludingQrDrafts(template);
    
    if (filterByUserDependency === 'true' && (userRole === 'Productor' || userRole === 'Responsable')) {
      // Obtener todas las dependencias del usuario
      const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
      
      // Filtrar solo los datos de las dependencias del usuario
      filteredLoadedData = filteredLoadedData.filter(data => 
        allUserDependencies.includes(data.dependency)
      );
    }

    filteredLoadedData = filteredLoadedData.filter(hasLoadedDataValues);

    const dependencies = await Dependency.find({ dep_code: { $in: filteredLoadedData.map(data => data.dependency) } });

    const depCodeToNameMap = dependencies.reduce((acc, dep) => {
      acc[dep.dep_code] = dep.name;
      return acc;
    }, {});

    let data = await Promise.all(filteredLoadedData.map(async data => {

      // Detectar si no hay datos cargados
      if (!Array.isArray(data.filled_data) || data.filled_data.length === 0) {
  const emptyRow = {
    Dependencia: depCodeToNameMap[data.dependency] || data.dependency,
  };

  // Añadir todas las columnas vacías según template.fields
  allTemplateFields.forEach(field => {
    const cleanFieldName = normalizeFieldName(field.name);
    emptyRow[cleanFieldName] = "";
  });

  return [emptyRow];
      }

      const filledData = await Promise.all(
        data.filled_data.map(async (item) => {
          const processedValues = await Promise.all(
            item.values.map(async (value, index) => {
              // Aplicar conversión de hipervínculos
              let cleanValue = convertHyperlinkToText(value);
              
              // Verificar si el campo es de país y convertir código a ID
              const isCountryField = item.field_name && 
                (item.field_name.toLowerCase().includes('pais') || 
                 item.field_name.toLowerCase().includes('país') ||
                 item.field_name.toLowerCase().includes('country'));
              
              if (isCountryField) {
                cleanValue = convertCountryCodeToId(cleanValue);
              }
              
              // Convertir IDs a valores descriptivos (buscar campo en template para validadores)
              const templateField = allTemplateFields.find(f => f.name === item.field_name) || null;
              cleanValue = await convertIdToDescriptive(item.field_name, cleanValue, templateField, template.period?._id || template.period);
              
              return { value: cleanValue, index };
            })
          );
          
          return { item, processedValues };
        })
      );
      
      // Reconstruir el formato original
      const finalData = [];
      filledData.forEach(({ item, processedValues }) => {
        processedValues.forEach(({ value, index }) => {
          if (!finalData[index]) {
            finalData[index] = { Dependencia: depCodeToNameMap[data.dependency] || data.dependency };
          }
          const fieldName = normalizeFieldName(item.field_name);
          finalData[index][fieldName] = isBlankOptionalValue(value) ? "" : value;
        });
      });


       console.log('INFO CARGADA', finalData);
    
      return finalData.filter(hasMergedRowInformation);
    }));
    
    data = data.flat().filter(hasMergedRowInformation);

    // Detectar si es plantilla de beneficiarios y enriquecer datos
    const templateName = template.name ? template.name.toUpperCase().replace(/\s+/g, '_') : '';
    const isBeneficiariosTemplate = templateName.includes('BENEFICIARIO_BIENESTAR_CULTURAL');
    
    if (isBeneficiariosTemplate) {
      console.log(`🎆 Detectada plantilla de beneficiarios: "${template.name}"`);
      console.log('🔄 Iniciando enriquecimiento de datos con API externa...');
      data = await enrichBeneficiariosData(data);
      console.log('✅ Datos de beneficiarios enriquecidos exitosamente');
    } else {
      console.log(`📄 Plantilla regular: "${template.name}" - sin enriquecimiento`);
    }

    res.status(200).json({ data });
  } catch (error) {
     console.log('LA PLANTILLA', error);
    res.status(500).json({ error: 'Error al obtener los datos de la plantilla' });
  }
}


publTempController.getUploadedTemplatesByProducer = async (req, res) => {
  const email = req.query.email;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || '';
  const periodId = req.query.periodId;
  const filterByDependency = req.query.filterByDependency;
  const filterByCategory = req.query.filterByCategory;
  const skip = (page - 1) * limit;

  try {
    console.log('== DEBUG getUploadedTemplatesByProducer ===');
    console.log('Email:', email);
    console.log('FilterByDependency:', filterByDependency);
    console.log('FilterByCategory:', filterByCategory);
    console.log('All query params:', req.query);
    
    const user = await User.findOne({ email });
    console.log('User found:', user ? 'YES' : 'NO');
    
    if (!user) {
      console.log('ERROR: User not found');
      return res.status(404).json({ status: 'User not found' });
    }

    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
    console.log('All user dependencies:', allUserDependencies);
    
    // Si hay filtro por dependencia, convertir nombre a dep_code si es necesario
    let dependenciesToQuery = allUserDependencies;
    if (filterByDependency) {
      console.log('FilterByDependency received:', filterByDependency);
      
      const dependencyByCode = await Dependency.findOne({ dep_code: filterByDependency });
      const dependencyByName = await Dependency.findOne({ name: { $regex: new RegExp(`^${filterByDependency}$`, 'i') } });
      
      if (dependencyByCode) {
        dependenciesToQuery = [filterByDependency];
        console.log('Filtering by dep_code:', filterByDependency);
      } else if (dependencyByName) {
        dependenciesToQuery = [dependencyByName.dep_code];
        console.log('Filtering by name, converted to dep_code:', dependencyByName.dep_code);
      } else {
        console.log('Dependency not found, using all user dependencies');
      }
    }
    console.log('Dependencies to query:', dependenciesToQuery);
    console.log('🔍 CRITICAL: Is filterByDependency being processed?', !!filterByDependency);
    
    // Obtener IDs de las dependencias para filtrar por template.producers
    const dependencies = await Dependency.find({ dep_code: { $in: dependenciesToQuery } });
    const dependencyIds = dependencies.map(dep => dep._id);
    console.log('Dependency IDs for producers filter:', dependencyIds);
    
    const query = {
      'template.producers': { $in: dependencyIds },
      'loaded_data.dependency': { $in: dependenciesToQuery },
      name: { $regex: search, $options: 'i' }
    };
    
    if (periodId) {
      query.period = periodId;
    }

    const templates = await PublishedTemplate.find(query)
      .collation({ locale: 'es', strength: 1 })
      .populate('period')
      .populate({
        path: 'template',
        populate: [
          { path: 'dimensions', model: 'dimensions' },
          { path: 'producers', model: 'dependencies' }
        ]
      });

    // Filtrar solo plantillas asignadas que tienen información cargada
    const templatesWithData = templates.filter(template => {
      const hasDataForDependencies = template.loaded_data.some(data => 
        dependenciesToQuery.includes(data.dependency) && 
        data.filled_data !== undefined
      );
      console.log(`\n🔍 Template '${template.name}':`);
      console.log('  - loaded_data dependencies:', template.loaded_data.map(ld => ld.dependency));
      console.log('  - dependenciesToQuery:', dependenciesToQuery);
      console.log('  - hasDataForDependencies:', hasDataForDependencies);
      return hasDataForDependencies;
    });

    const normalizedTemplatesWithData = templatesWithData.map((template) => {
      const templateObject = template.toObject();
      templateObject.loaded_data = (templateObject.loaded_data || []).filter((data) =>
        dependenciesToQuery.includes(data.dependency)
      );
      return templateObject;
    });

    const categoryFilter = await resolveCategoryFilter(filterByCategory);
    const templatesWithCurrentCategories = await Promise.all(
      normalizedTemplatesWithData.map(enrichPublishedTemplateWithLiveTemplate)
    );
    const categoryFilteredTemplates = templatesWithCurrentCategories.filter((template) =>
      matchesCategoryFilter(template, categoryFilter)
    );

    // Obtener IDs de dependencias del usuario para calcular isEncargado
    const userDeps = await Dependency.find({ dep_code: { $in: dependenciesToQuery } }).select('_id').lean();
    const userDepIds = userDeps.map(d => d._id.toString());

    const templatesWithValidators = await Promise.all(
      categoryFilteredTemplates.slice(skip, skip + limit).map(async (template) => {
        template.validators = await collectValidatorsForTemplate(
          template.template,
          template.period?._id || template.period
        );
        const rawResponsible = template.responsible_producers?.length > 0
          ? template.responsible_producers
          : template.template?.responsible_producers;
        const responsibleIds = (rawResponsible || []).map(id => id.toString());
        template.isEncargado = responsibleIds.length > 0 && userDepIds.some(id => responsibleIds.includes(id));
        return template;
      })
    );

    // Contar total real después del filtrado
    const totalWithData = categoryFilteredTemplates.length;

    res.status(200).json({
      templates: templatesWithValidators,
      total: totalWithData,
      page,
      pages: Math.ceil(totalWithData / limit),
    });
  } catch (error) {
    console.error('=== ERROR in getUploadedTemplatesByProducer ===');
    console.error('Error message:', error.message);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};

publTempController.getAvailableTemplatesToProductor = async (req, res) => {
  const { email, periodId, page = 1, limit = 10, search = '', filterByDependency = '', filterByCategory = '' } = req.query;
  const pageNumber = Number(page) || 1;
  const limitNumber = Number(limit) || 10;
  const skip = (pageNumber - 1) * limitNumber;

  try {
    console.log('=== DEBUG getAvailableTemplatesToProductor ===');
    console.log('Email:', email);
    console.log('FilterByCategory:', filterByCategory);
    
    // Find user productor
    const user = await UserService.findUserByEmailAndRole(email, 'Productor');
    if (!user) {
      return res.status(404).json({ error: 'User not found or not a producer' });
    }
    
    console.log('User dep_code:', user.dep_code);
    console.log('User additional_dependencies:', user.additional_dependencies);

    // Obtener todas las dependencias del usuario (principal + adicionales)l + adicionales)
    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
    console.log('All user dependencies:', allUserDependencies);
    
    // Si hay filtro por dependencia, usar solo esa dependencia
    const dependenciesToQuery = filterByDependency ? [filterByDependency] : allUserDependencies;
    console.log('Dependencies to query:', dependenciesToQuery);
    
    // Obtener IDs de las dependencias a consulta
    const dependencies = await Dependency.find({ dep_code: { $in: dependenciesToQuery } });
    console.log('Found dependencies:', dependencies.map(d => ({ code: d.dep_code, name: d.name })));
    const dependencyIds = dependencies.map(dep => dep._id);
    console.log('Dependency IDs:', dependencyIds);

    // Build query for PublishedTemplates
    const query = { 
      name: { $regex: search, $options: 'i' },
      'template.producers': { $in: dependencyIds },
      'template.active': true
    };

    if (periodId) query.period = periodId;

    console.log('Query for templates:', JSON.stringify(query, null, 2));
    
    // Fetch templates with initial population
    const templates = await PublishedTemplate.find(query)
      .collation({ locale: 'es', strength: 1 })
      .populate('period')
      .populate({
        path: 'template',
        populate: [
          { path: 'dimensions', model: 'dimensions' },
          { path: 'producers', model: 'dependencies' }
        ]
      }).lean();

    // Manually fetch categories
    const templatesWithCategories = await Promise.all(
      templates.map(enrichPublishedTemplateWithLiveTemplate)
    );

    const categoryFilter = await resolveCategoryFilter(filterByCategory);
    const categoryFilteredTemplates = templatesWithCategories.filter((template) =>
      matchesCategoryFilter(template, categoryFilter)
    );

      // Custom sorting logic
      const sortedTemplates = categoryFilteredTemplates.sort((a, b) => {
        // First, prioritize templates with categories
        const hasCategA = !!a.template.category.name && a.template.category.name !== 'Sin categoría';
        const hasCategB = !!b.template.category.name && b.template.category.name !== 'Sin categoría';
        
        // If one template has a category and the other doesn't, prioritize the one with category
        if (hasCategA !== hasCategB) {
          return hasCategB - hasCategA;
        }
        
        // If both have categories, sort by category name
        const categoryComparison = (a.template.category.name || '').localeCompare(
          b.template.category.name || ''
        );
        
        if (categoryComparison !== 0) return categoryComparison;

        return (a.name || '').localeCompare(b.name || '');
      });

    // Filter templates without loaded data for queried dependencies
    const filteredTemplates = sortedTemplates.filter(
      (template) => {
        const hasLoadedData = template.loaded_data?.some((data) => dependenciesToQuery.includes(data.dependency));
        if (hasLoadedData) {
          console.log(`Template '${template.name}' filtered out - already has data from dependencies:`, 
            template.loaded_data.filter(d => dependenciesToQuery.includes(d.dependency)).map(d => d.dependency)
          );
        }
        return !hasLoadedData;
      }
    );
    
    console.log(`Templates after filtering: ${filteredTemplates.length} of ${sortedTemplates.length}`);

    const total = filteredTemplates.length;
    const paginatedTemplates = filteredTemplates.slice(skip, skip + limitNumber);

    // Get validators for filtered templates + marcar si el usuario es productor encargado
    const userDepIds = dependencies.map(d => d._id.toString());
    const templatesWithValidators = await Promise.all(
      paginatedTemplates.map(async (template) => {
        const validators = await collectValidatorsForTemplate(
          template.template,
          template.period?._id || template.period
        );
        const rawResponsible = template.responsible_producers?.length > 0
          ? template.responsible_producers
          : template.template?.responsible_producers;
        const responsibleIds = (rawResponsible || []).map(id => id.toString());
        const isEncargado = responsibleIds.length > 0 && userDepIds.some(id => responsibleIds.includes(id));
        return { ...template, validators, isEncargado };
      })
    );

    res.status(200).json({
      templates: templatesWithValidators,
      total,
      page: pageNumber,
      pages: Math.ceil(total / limitNumber),
    });
  } catch (error) {
    console.error('Error fetching available templates:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};


publTempController.getTemplateById = async (req, res) => {
  const templateId = req.params.id;

  try {
    const publishedTemplate = await PublishedTemplate.findById(templateId)
      .populate('period')
      .populate({
        path: 'template',
        populate: [
          { path: 'dimensions', model: 'dimensions' },
          { path: 'producers', model: 'dependencies' },
        ]
      })


    if (!publishedTemplate) {
      return res.status(404).json({ status: 'Template not found' });
    }

    await refreshPublishedTemplateSnapshot(publishedTemplate);

    const validatorsMap = new Map();
    const periodId = publishedTemplate.period?._id || publishedTemplate.period;
    const withEffectiveRequired = (field) => {
      const plainField = toPlainObject(field);
      return {
        ...plainField,
        required: getEffectiveRequired(plainField),
      };
    };

    const fieldsWithValidatorIds = await Promise.all((publishedTemplate.template.fields || []).map(async (field) => {
      try {
        return withEffectiveRequired(await enrichFieldWithCurrentValidator(field, periodId, validatorsMap));
      } catch (err) {
        console.error(`Error during validator lookup: ${err.message}`);
        return withEffectiveRequired(field);
      }
    }));

    const snapshotId = publishedTemplate.template?._id || publishedTemplate.template?.id;
    const liveTemplate = snapshotId ? await Template.findById(snapshotId) : null;
    const templateDoc = liveTemplate || publishedTemplate.template?._doc || publishedTemplate.template || {};

    // Enriquecer campos de workbook_sheets con IDs de validadores (igual que los campos top-level)
    const rawSheets = templateDoc.workbook_sheets || [];
    const enrichedSheets = await Promise.all(rawSheets.map(async (sheet) => {
      const enrichedFields = await Promise.all((sheet.fields || []).map(async (field) => {
        try {
          return withEffectiveRequired(await enrichFieldWithCurrentValidator(field, periodId, validatorsMap));
        } catch (_) {
          return withEffectiveRequired(field);
        }
      }));
      return { ...sheet.toObject?.() || sheet, fields: enrichedFields };
    }));

    const getProducerRefId = (producerRef) => {
      const plainProducer = toPlainObject(producerRef);
      const explicitId = plainProducer?._id || plainProducer?.id;
      if (explicitId) return String(explicitId);
      if (typeof producerRef === 'string') return producerRef;
      const fallbackId = producerRef?.toString?.() || '';
      return fallbackId === '[object Object]' ? '' : fallbackId;
    };

    const sheetProducerIds = [...new Set(
      enrichedSheets
        .flatMap(sheet => sheet.producers || [])
        .map(getProducerRefId)
        .filter(Boolean)
    )];
    const sheetDependencies = sheetProducerIds.length
      ? await Dependency.find({ _id: { $in: sheetProducerIds } }, '_id dep_code').lean()
      : [];
    const depCodeByProducerId = new Map(
      sheetDependencies.map(dep => [String(dep._id), dep.dep_code])
    );
    const resolveProducerDepCode = (producerRef) => {
      const plainProducer = toPlainObject(producerRef);
      if (plainProducer?.dep_code) return plainProducer.dep_code;
      return depCodeByProducerId.get(getProducerRefId(producerRef));
    };

    // Recopilar datos ya enviados por otros productores (siempre, independiente del flag shared).
    const templateShared = liveTemplate?.shared || publishedTemplate.template?.shared || false;
    const sharedSheetsData = {};
    const allProducerEntries = getLoadedDataIncludingQrDrafts(publishedTemplate);
    const allEntriesDepCodes = [...new Set(allProducerEntries.map(e => getEntryDependencyCode(e)).filter(Boolean))];
    const entriesDeps = allEntriesDepCodes.length
      ? await Dependency.find({ dep_code: { $in: allEntriesDepCodes } }, 'dep_code name').lean()
      : [];
    const depNameByCode = new Map(entriesDeps.map(d => [d.dep_code, d.name]));
    for (const sheet of enrichedSheets) {
      if (!sheet.fields?.length) continue;
      const sheetFieldNames = new Set((sheet.fields || []).map(f => f.name));
      const sheetProducerCodes = new Set(
        (sheet.producers || []).map(resolveProducerDepCode).filter(Boolean)
      );
      const rows = [];
      for (const entry of allProducerEntries) {
        const entryDependency = getEntryDependencyCode(entry);
        if (sheetProducerCodes.size > 0 && !sheetProducerCodes.has(entryDependency)) continue;

        const relevantFields = (entry.filled_data || []).filter(f => (
          getFieldDataSheetName(f)
            ? getFieldDataSheetName(f) === sheet.name
            : sheetFieldNames.has(f.field_name)
        ));
        if (relevantFields.length === 0) continue;
        const sendBy = entry.send_by || {};
        const origin = {
          code: entryDependency,
          depName: depNameByCode.get(entryDependency) || entryDependency,
          senderName: sendBy.full_name || sendBy.name || sendBy.email || entryDependency,
          senderEmail: sendBy.email || null,
        };
        const builtRows = buildRowsFromFilledFields(relevantFields)
          .filter(row => Object.values(row).some(value => isMeaningfulMergedValue(value)));
        builtRows.forEach(row => { row.__origin__ = origin; });
        rows.push(...builtRows);
      }
      if (rows.length > 0) sharedSheetsData[sheet.name] = rows;
    }

    const qrDraftData = await enrichQrDraftsWithDependencyInfo(publishedTemplate.qr_draft_data || []);

    // Enriquecer loaded_data para asegurar que send_by tenga todos los campos necesarios
    const enrichedLoadedData = await Promise.all((publishedTemplate.loaded_data || []).map(async (entry) => {
      const plainEntry = toPlainObject(entry);
      const sender = plainEntry.send_by || {};
      
      // Si send_by no tiene email, intentar obtener del usuario
      let enrichedSender = { ...sender };
      if (!enrichedSender.email && sender._id) {
        const user = await User.findById(sender._id).lean();
        if (user) {
          enrichedSender = {
            _id: user._id,
            email: user.email,
            full_name: user.full_name || user.name,
            position: user.position,
            dep_code: user.dep_code,
          };
        }
      }
      
      return {
        ...plainEntry,
        send_by: enrichedSender,
      };
    }));

    const response = {
      name: publishedTemplate.name,
      template: {
        ...(publishedTemplate.template?.toObject?.() || publishedTemplate.template?._doc || publishedTemplate.template || {}),
        workbook_sheets: enrichedSheets,
        fields: fieldsWithValidatorIds,
        validators: Array.from(validatorsMap.values()),
        shared: templateShared,
        producers: publishedTemplate.template?.producers && publishedTemplate.template.producers.length > 0
          ? await Promise.all((publishedTemplate.template.producers || []).map(async (producerId) => {
              const producer = await Dependency.findById(producerId).lean();
              return {
                _id: producer?._id,
                dep_code: producer?.dep_code,
                name: producer?.name,
                responsible: producer?.responsible,
                visualizers: producer?.visualizers || []
              };
            }))
          : [],
      },
      publishedTemplate: {
        ...toPlainObject(publishedTemplate),
        loaded_data: enrichedLoadedData,
      },
      qr_draft_data: qrDraftData,
      shared_sheets_data: sharedSheetsData,
    };

    res.status(200).json(response);
  } catch (error) {
    console.error('Error fetching template by ID:', error);
    res.status(500).json({ status: 'Internal Server Error', error: error.message });
  }
};

publTempController.getUploadedTemplateDataByProducer = async (req, res) => {
  const { id_template } = req.params;
  const { email } = req.query;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ status: 'User not found' });
    }

    // Obtener todas las dependencias del usuario
    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);

    // Busca la plantilla publicada donde alguna de las dependencias del usuario haya enviado datos
    const template = await PublishedTemplate.findOne({
      _id: id_template,
      'loaded_data.dependency': { $in: allUserDependencies },
    });

    if (!template) {
      return res.status(404).json({ status: 'Template not found' });
    }

    // Encuentra los datos enviados por cualquiera de las dependencias del usuario
    const producerData = template.loaded_data.find(
      (data) => allUserDependencies.includes(data.dependency)
    );

    if (!producerData) {
      return res.status(404).json({ status: 'No data found for dependency' });
    }

    // Aplicar conversión de hipervínculos y códigos de país a los datos
    const processedData = await Promise.all(producerData.filled_data.map(async item => {
      // Verificar si el campo es de país
      const isCountryField = item.field_name && 
        (item.field_name.toLowerCase().includes('pais') || 
         item.field_name.toLowerCase().includes('país') ||
         item.field_name.toLowerCase().includes('country'));
      
      const processedValues = await Promise.all(item.values.map(async value => {
        let processedValue = convertHyperlinkToText(value);
        if (isCountryField) {
          processedValue = convertCountryCodeToId(processedValue);
        }
        // Convertir IDs a valores descriptivos
        processedValue = await convertIdToDescriptive(item.field_name, processedValue);
        return processedValue;
      }));
      
      return {
        ...item,
        values: processedValues
      };
    }));
    
    res.status(200).json({ data: processedData });
  } catch (error) {
    console.error('Error fetching template data:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

//Only deletes if there's no loaded data
publTempController.deletePublishedTemplate = async (req, res) => {
  const { id, email } = req.query;

  try {
    const user = await UserService.findUserByEmailAndRole(email, 'Administrador');

    const template = await PublishedTemplate.findById(id);
    if (!template) {
      throw new Error('Template not found');
    }

    if (template.loaded_data?.length > 0) {
      throw new Error('Template has loaded data');
    }

    await PublishedTemplate.findByIdAndDelete(id);
    
    // Audit log
    console.log('🔍 Executing audit log for publishedTemplate deletion');
    await auditLogger.logDelete(req, user, 'publishedTemplate', {
      templateId: id,
      templateName: template.name
    });
    console.log('✅ Audit log completed for publishedTemplate deletion');
    
    res.status(200).json({ status: 'Template deleted successfully' });
  } catch (error) {
    console.error('Error deleting template:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

publTempController.updateDeadlines = async (req, res) => {
  try {
    const { email, templateIds, deadline, fecha_inicio, fecha_final_productores, fecha_final_responsables, fecha_final } = req.body;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const user = await User.findOne({ email });

    const fechaFinal = fecha_final || deadline || null;
    const updateFields = {
      ...(fechaFinal && { deadline: fechaFinal, fecha_final: fechaFinal }),
      ...(fecha_inicio && { fecha_inicio }),
      ...(fecha_final_productores && { fecha_final_productores }),
      ...(fecha_final_responsables && { fecha_final_responsables }),
    };

    for (const id of templateIds) {
      const template = await PublishedTemplate.findByIdAndUpdate(id, updateFields);

      // Audit log para cada plantilla actualizada
      await auditLogger.logUpdate(req, user, 'publishedTemplateDeadline', {
        publishedTemplateId: id,
        templateName: template?.name || 'Unknown',
        newDeadline: fechaFinal
      });
    }

    return res.status(200).json({ message: "Fechas actualizadas exitosamente." });
  } catch (error) {
    console.error("Error al actualizar deadlines:", error);
    return res.status(500).json({ error: error.message });
  }
};

publTempController.cleanObjectObjectData = async (req, res) => {
  try {
    const { email } = req.query;
    
    // Verificar que sea administrador
    await UserService.findUserByEmailAndRole(email, 'Administrador');
    
    const { cleanObjectObjectData } = require('../scripts/cleanObjectObjectData');
    const result = await cleanObjectObjectData();
    
    res.status(200).json(result);
  } catch (error) {
    console.error('Error cleaning object data:', error);
    res.status(500).json({ error: error.message });
  }
};

publTempController.cleanHyperlinkData = async (req, res) => {
  try {
    const { email } = req.query;
    
    // Verificar que sea administrador
    await UserService.findUserByEmailAndRole(email, 'Administrador');
    
    console.log('🧹 Iniciando limpieza de hipervínculos en todas las plantillas...');
    
    const templates = await PublishedTemplate.find({});
    let totalCleaned = 0;
    let templatesProcessed = 0;
    
    for (const template of templates) {
      let templateModified = false;
      
      for (const loadedData of template.loaded_data) {
        for (const fieldData of loadedData.filled_data) {
          for (let i = 0; i < fieldData.values.length; i++) {
            const originalValue = fieldData.values[i];
            const cleanedValue = convertHyperlinkToText(originalValue);
            
            if (originalValue !== cleanedValue) {
              fieldData.values[i] = cleanedValue;
              totalCleaned++;
              templateModified = true;
            }
          }
        }
      }
      
      if (templateModified) {
        await template.save();
        templatesProcessed++;
        console.log(`✅ Plantilla limpiada: ${template.name}`);
      }
    }
    
    console.log(`🎉 Limpieza completada: ${totalCleaned} valores limpiados en ${templatesProcessed} plantillas`);
    
    res.status(200).json({
      message: 'Limpieza de hipervínculos completada',
      totalCleaned,
      templatesProcessed,
      totalTemplates: templates.length
    });
  } catch (error) {
    console.error('Error cleaning hyperlink data:', error);
    res.status(500).json({ error: error.message });
  }
};




// Envío final al SNIES — solo el productor responsable puede ejecutarlo
publTempController.confirmFinalSubmit = async (req, res) => {
  const { pubTem_id, email } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ status: 'User not found' });
    }

    const pubTem = await PublishedTemplate.findById(pubTem_id)
      .populate('period')
      .populate({ path: 'template', populate: { path: 'producers', model: 'dependencies' } });

    if (!pubTem) {
      return res.status(404).json({ status: 'Published template not found' });
    }

    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
    const userDependencies = await Dependency.find({ dep_code: { $in: allUserDependencies } });
    const userDependencyIds = userDependencies.map(dep => dep._id.toString());

    // Verificar que sea productor asignado
    const canSubmit = pubTem.template?.producers.some(p => userDependencyIds.includes(p._id.toString()));
    if (!canSubmit) {
      return res.status(403).json({ status: 'User is not assigned to this published template' });
    }

    // Verificar que sea productor responsable
    const rawResponsibleFinal = pubTem.responsible_producers?.length > 0
      ? pubTem.responsible_producers
      : pubTem.template?.responsible_producers;
    const responsibleProducers = (rawResponsibleFinal || []).map(id => id.toString());
    if (responsibleProducers.length > 0) {
      const isResponsible = userDependencyIds.some(id => responsibleProducers.includes(id));
      if (!isResponsible) {
        return res.status(403).json({ status: 'Solo el productor responsable puede realizar el envío final' });
      }
    }

    // Confirmar borradores pendientes: mover qr_draft_data → loaded_data para deps sin datos confirmados
    const draftEntries = Array.isArray(pubTem.qr_draft_data) ? pubTem.qr_draft_data : [];
    if (draftEntries.length > 0) {
      const loadedDeps = new Set((pubTem.loaded_data || []).map(d => d.dependency));
      const draftsToCommit = draftEntries.filter(d => !loadedDeps.has(d.dependency));
      if (draftsToCommit.length > 0) {
        pubTem.loaded_data.push(...draftsToCommit);
        pubTem.qr_draft_data = draftEntries.filter(d => loadedDeps.has(d.dependency));
        pubTem.markModified('loaded_data');
        pubTem.markModified('qr_draft_data');
      }
    }

    // Verificar que haya datos cargados por los productores antes del envío final
    if (!pubTem.loaded_data || pubTem.loaded_data.length === 0) {
      return res.status(400).json({ status: 'No hay datos cargados para enviar' });
    }

    // Marcar la plantilla como enviada al SNIES
    pubTem.final_submitted = true;
    pubTem.final_submitted_by = user;
    pubTem.final_submitted_date = datetime_now();
    await pubTem.save();

    await auditLogger.logCreate(req, user, 'finalSubmitToSnies', {
      publishedTemplateId: pubTem_id,
      templateName: pubTem.name,
      dependency: user.dep_code,
      totalProducers: pubTem.loaded_data.length
    });

    return res.status(200).json({ status: 'Envío final realizado exitosamente' });
  } catch (error) {
    console.log(error.message);
    return res.status(500).json({ status: 'Internal server error', details: error.message });
  }
};

publTempController.hasData = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;

    const pubTem = await PublishedTemplate.findById(id, 'loaded_data');
    if (!pubTem) {
      return res.status(404).json({ status: 'Published template not found' });
    }

    if (!email) {
      // Sin email, responder si hay algún dato cargado en la plantilla
      return res.json({ hasData: pubTem.loaded_data.length > 0 });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ status: 'User not found' });
    }

    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
    const hasData = pubTem.loaded_data.some(d => allUserDependencies.includes(d.dependency));

    return res.json({ hasData });
  } catch (error) {
    return res.status(500).json({ status: 'Internal server error', message: error.message });
  }
};

publTempController.getPublishedByTemplateId = async (req, res) => {
  const { templateId } = req.params;
  const { periodId } = req.query;
  try {
    // template._id puede estar guardado como ObjectId o como string, buscar ambos
    const idAsObjectId = mongoose.Types.ObjectId.isValid(templateId)
      ? new mongoose.Types.ObjectId(templateId)
      : null;

    const idConditions = idAsObjectId
      ? [{ 'template._id': idAsObjectId }, { 'template._id': templateId }]
      : [{ 'template._id': templateId }];

    const baseQuery = periodId
      ? { $or: idConditions, period: periodId }
      : { $or: idConditions };

    const published = await PublishedTemplate.findOne(baseQuery).lean();
    if (!published) {
      return res.status(200).json({ found: false, loaded_data: [] });
    }
    return res.status(200).json({ found: true, loaded_data: published.loaded_data || [] });
  } catch (error) {
    return res.status(500).json({ status: 'Internal server error', message: error.message });
  }
};

module.exports = publTempController;
