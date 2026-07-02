const { register } = require('module');
const User = require('../models/users')
const Validator = require('../models/validators');
const Period = require('../models/periods');
const Student = require('../models/students');
const { all } = require('../routes/users');
const auditLogger = require('../services/auditLogger');
const mongoose = require('mongoose');
const {
    buildAcceptedDropdownOptionSet,
    collapseRepeatedCompositeOption,
    getFieldDropdownOptions,
    normalizeOptionKey: normalizeDropdownOptionKey,
} = require('../helpers/dropdownOptions');
const { getEffectiveRequired } = require('../helpers/requiredFields');

const validatorController = {}

const hasPeriodId = (periodId) => periodId !== null && periodId !== undefined && String(periodId).trim() !== '';

const getRequestPeriodId = (req) => req.body?.periodId || req.query?.periodId || null;

const createHttpError = (statusCode, message) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};

const getPeriodOrThrow = async (periodId) => {
    if (!hasPeriodId(periodId)) return null;

    if (!mongoose.Types.ObjectId.isValid(String(periodId))) {
        throw createHttpError(400, "Valid period ID is required");
    }

    const period = await Period.findById(periodId);
    if (!period) {
        throw createHttpError(404, "Period not found");
    }

    if (!period.screenshot) {
        period.screenshot = {};
    }

    if (!Array.isArray(period.screenshot.validators)) {
        period.screenshot.validators = [];
    }

    return period;
};

const toPlainValidator = (validator) => {
    if (!validator) return null;
    return typeof validator.toObject === 'function' ? validator.toObject() : validator;
};

const getPeriodValidators = (period) => (period?.screenshot?.validators || []).map(toPlainValidator);

const normalizeValidatorLookup = (value = '') => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const normalizeValidatorNameKey = (value = '') => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');

const sameValidatorName = (a = '', b = '') => (
    String(a).trim().toLowerCase() === String(b).trim().toLowerCase() ||
    normalizeValidatorNameKey(a) === normalizeValidatorNameKey(b)
);

const validateWithToText = (validateWith) => {
    if (!validateWith) return '';
    if (typeof validateWith === 'string') return validateWith.trim();
    if (typeof validateWith === 'object') {
        return String(validateWith.name || validateWith.id || '').trim();
    }
    return String(validateWith).trim();
};

const splitValidateWithReference = (validateWith) => {
    const text = validateWithToText(validateWith);
    const parts = text.split(' - ');
    return {
        text,
        validatorName: (parts[0] || '').trim(),
        columnName: parts.slice(1).join(' - ').trim(),
    };
};

const findValidatorColumn = (validator, columnName = '') => {
    const columns = validator?.columns || [];
    if (!columns.length) return null;

    if (columnName) {
        const normalizedColumnName = normalizeValidatorLookup(columnName);
        const exact = columns.find((column) => normalizeValidatorLookup(column?.name) === normalizedColumnName);
        if (exact) return exact;
    }

    return columns.find((column) => column?.is_validator) || columns[0];
};

const validatorValueToPlain = (value) => {
    if (value && typeof value === 'object' && value.$numberInt !== undefined) return value.$numberInt;
    if (value && typeof value === 'object' && value.$numberDouble !== undefined) return value.$numberDouble;
    if (value && typeof value === 'object' && value.value !== undefined) return value.value;
    return value;
};

const cleanValidatorValue = (value) => {
    const plainValue = validatorValueToPlain(value);
    if (typeof plainValue !== 'string') return plainValue;
    return collapseRepeatedCompositeOption(plainValue);
};

const cleanValidatorDisplayText = (value) => {
    const cleanValue = cleanValidatorValue(value);
    if (cleanValue === null || cleanValue === undefined) return '';
    return String(cleanValue).trim();
};

const isValidatorCodeColumn = (columnName = '') => {
    const normalized = normalizeValidatorLookup(columnName).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    return normalized === 'ID' || normalized.startsWith('ID_') || normalized.includes('CODIGO') || normalized === 'CODIGO';
};

const formatValidatorDisplayOption = (code, description) => {
    const codeText = cleanValidatorDisplayText(code);
    const descriptionText = cleanValidatorDisplayText(description);
    if (codeText && descriptionText) {
        if (normalizeValidatorLookup(codeText) === normalizeValidatorLookup(descriptionText)) {
            return codeText;
        }

        if (descriptionText.startsWith(`${codeText} - `)) {
            return descriptionText;
        }

        return collapseRepeatedCompositeOption(`${codeText} - ${descriptionText}`);
    }
    return codeText || descriptionText;
};

const getValidatorDisplayPair = (columns = []) => {
    const descriptionColumn = (columns || []).find((column) => isDescriptionColumn(column?.name));
    if (!descriptionColumn) return null;

    const codeColumn =
        (columns || []).find((column) => column !== descriptionColumn && column?.is_validator && !isDescriptionColumn(column?.name)) ||
        (columns || []).find((column) => column !== descriptionColumn && isValidatorCodeColumn(column?.name)) ||
        (columns || []).find((column) => column !== descriptionColumn && !isDescriptionColumn(column?.name));

    if (!codeColumn) return null;
    return { codeColumn, descriptionColumn };
};

const getValidatorDisplayValuesForColumn = (columns = [], column = {}) => {
    const pair = getValidatorDisplayPair(columns);
    if (!pair) return (column.values || []).map(cleanValidatorValue);

    const isDisplayColumn = [pair.codeColumn?.name, pair.descriptionColumn?.name]
        .some((name) => normalizeValidatorLookup(name) === normalizeValidatorLookup(column?.name));
    if (!isDisplayColumn) return (column.values || []).map(cleanValidatorValue);

    const maxLength = Math.max(
        pair.codeColumn?.values?.length || 0,
        pair.descriptionColumn?.values?.length || 0
    );

    return Array.from({ length: maxLength }, (_, index) => (
        formatValidatorDisplayOption(
            pair.codeColumn?.values?.[index],
            pair.descriptionColumn?.values?.[index]
        )
    ));
};

const findValidatorInPeriod = (period, idOrName) => {
    const lookup = String(idOrName || '').trim();
    if (!lookup) return null;

    return (period?.screenshot?.validators || []).find((validator) => (
        String(validator?._id || '') === lookup || sameValidatorName(validator?.name, lookup)
    ));
};

const pickValidatorPayload = (body = {}) => {
    const payload = {};
    if (body.name !== undefined) payload.name = body.name;
    if (body.columns !== undefined) payload.columns = body.columns;
    return payload;
};

const filterValidators = (validators, search = '') => {
    const normalizedSearch = String(search || '').trim().toLowerCase();
    if (!normalizedSearch) return validators;

    return validators.filter((validator) => {
        const validatorName = String(validator?.name || '').toLowerCase();
        const columnNames = (validator?.columns || [])
            .map((column) => String(column?.name || '').toLowerCase())
            .join(' ');

        return validatorName.includes(normalizedSearch) || columnNames.includes(normalizedSearch);
    });
};

const findGlobalValidatorByName = async (validatorName = '') => {
    const lookup = String(validatorName || '').trim();
    if (!lookup) return null;

    const escaped = lookup.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exact = await Validator.findOne({ name: new RegExp(`^${escaped}$`, 'i') });
    if (exact) return exact;

    const normalizedLookup = normalizeValidatorNameKey(lookup);
    if (!normalizedLookup) return null;

    const validators = await Validator.find({});
    return validators.find((validator) => normalizeValidatorNameKey(validator?.name) === normalizedLookup) || null;
};

validatorController.findValidatorByName = async (name, periodId = null) => {
    const validatorName = String(name || '').trim();
    if (!validatorName) return null;

    if (hasPeriodId(periodId)) {
        if (!mongoose.Types.ObjectId.isValid(String(periodId))) return null;
        const period = await Period.findById(periodId).select('screenshot.validators');
        const periodValidator = toPlainValidator(findValidatorInPeriod(period, validatorName));
        if (periodValidator) return periodValidator;
    }

    return findGlobalValidatorByName(validatorName);
};

validatorController.listValidatorsByPeriod = async (periodId = null) => {
    if (hasPeriodId(periodId)) {
        if (!mongoose.Types.ObjectId.isValid(String(periodId))) return [];
        const period = await Period.findById(periodId).select('screenshot.validators');
        return getPeriodValidators(period);
    }

    return Validator.find({});
};

const isBlankValue = (value) => {
    if (value === null || value === undefined) return true;
    if (typeof value === 'number') return Number.isNaN(value);
    const normalized = String(value).trim();
    return normalized === '' || normalized.toLowerCase() === 'null' || normalized.toLowerCase() === 'nan';
};

const hasMeaningfulValue = (value) => {
    if (Array.isArray(value)) {
        return value.some((item) => hasMeaningfulValue(item));
    }

    return !isBlankValue(value);
};

const normalizeComparableText = (value) => {
    if (value === null || value === undefined) return '';

    return String(value)
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .toUpperCase();
};

const isDescriptionColumn = (columnName = '') => {
    const normalized = normalizeComparableText(columnName);
    return normalized.includes('DESCRIPCION') || normalized.includes('NOMBRE') || normalized.startsWith('DESC');
};

const buildAcceptedValidatorStringSet = (validator, columnToValidate) => {
    const acceptedValues = new Set();

    if (!columnToValidate?.values) {
        return acceptedValues;
    }

    const addAcceptedValue = (value) => {
        const normalizedText = normalizeComparableText(cleanValidatorDisplayText(value));
        if (!normalizedText) return;

        acceptedValues.add(normalizedText);

        const rawText = normalizedText.replace(/^\d+[).:\-\s]+\s*/, '').trim();
        if (!rawText) return;

        // "CC Cédula de ciudadanía" or "1 Posdoctorado" → accept only "CC" / "1"
        // Plain text like "Término indefinido" → accept as-is
        const codeMatch = /^([A-Z0-9]{1,6})\s+.+$/.exec(rawText);
        acceptedValues.add(codeMatch ? codeMatch[1] : rawText);
    };

    columnToValidate.values.forEach(addAcceptedValue);
    getValidatorDisplayValuesForColumn(validator?.columns || [], columnToValidate)
        .forEach(addAcceptedValue);

    return acceptedValues;
};

const allowedDataTypes = {
    "Entero": (value) => {
        const num = Number(value);
        const isValid = Number.isInteger(num);
        return {
            isValid,
            message: isValid ? null : "El valor no es un entero."
        };
    },
    "Decimal": (value) => {
        const isValid = typeof value === 'number' && !Number.isNaN(value);
        return {
            isValid,
            message: isValid ? null : "El valor no es un decimal."
        };
    },
    "Porcentaje": (value) => {
        const isValid = typeof value === 'number' && value >= 0 && value <= 100;
        return {
            isValid,
            message: isValid ? null : "El valor no es un porcentaje válido (0-100)."
        };
    },
    "Texto Corto": (value) => {
        const isValid = typeof value === 'string' && value.length <= 60;
        return {
            isValid,
            message: isValid ? null : "El valor no es un texto corto (máximo 60 caracteres)."
        };
    },
    "Texto Largo": (value) => {
        const isValid = typeof value === 'string' && value.length <= 800;
        return {
            isValid,
            message: isValid ? null : "El valor no es un texto largo (máximo de 500 caracteres)."
        };
    },
    "True/False": (value) => {
        const isValid = typeof value === 'boolean';
        return {
            isValid,
            message: isValid ? null : "El valor no es un booleano (true/false)."
        };
    },
    "Fecha": (value) => {
        if (value === null || value === undefined) {
            return {
                isValid: false,
                message: "El valor no es una fecha válida."
            };
        }
        
        const isValid = !isNaN(Date.parse(value));
        return {
            isValid,
            message: isValid ? null : "El valor no es una fecha válida."
        };
    },
    "Fecha Inicial / Fecha Final": (value) => {
        const isValid = Array.isArray(value) && value.length === 2 && !isNaN(Date.parse(value[0])) && !isNaN(Date.parse(value[1]));
        return {
            isValid,
            message: isValid ? null : "El valor no es un rango de fechas válido (Fecha Inicial y Fecha Final)."
        };
    },
    "Link": (value) => {
        const isValid = typeof value === 'string' && /^(https?:\/\/[^\s]+)$/.test(value);
        return {
            isValid,
            message: isValid ? null : "El valor no es un enlace válido."
        };
    }
};

validatorController.createValidator = async (req, res) => {
    try {      
        const periodId = getRequestPeriodId(req);
        const payload = pickValidatorPayload(req.body);

        if(payload.name?.includes('-')) {
            return res.status(400).json({ status: "Name cannot contain '-' character" });
        }

        if(payload.columns?.some(column => column.name.includes('-'))) {
            return res.status(400).json({ status: "Columns name cannot contain '-' character" });
        }

        // Obtener email del body, query o usuario autenticado
        const email = req.body.email || req.query.email || req.user?.email;
        if (!email) {
            return res.status(400).json({ status: "Email is required" });
        }

        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ status: "User not found" });
        }

        const period = await getPeriodOrThrow(periodId);
        let validator;

        if (period) {
            const existsInPeriod = (period.screenshot.validators || []).some((item) => sameValidatorName(item.name, payload.name));
            if (existsInPeriod) {
                return res.status(400).json({ status: "Validator already exists in this period" });
            }

            validator = new Validator(payload);
            await validator.validate();
            period.screenshot.validators.push(validator.toObject());
            period.markModified('screenshot.validators');
            await period.save();
        } else {
            validator = new Validator(payload);
            await validator.save();
        }
        
        // Audit log
        await auditLogger.logCreate(req, user, 'validator', {
            validatorId: validator._id,
            validatorName: payload.name,
            period: periodId || undefined
        });
        
        res.status(200).json({ status: "Validator created" });

    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

validatorController.updateName = async (req, res) => {
    try {
        const { name, newName } = req.body;
        const email = req.body.email || req.query.email || req.user?.email;
        
        if (!email) {
            return res.status(400).json({ status: "Email is required" });
        }
        
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ status: "User not found" });
        }
        
        const validator = await Validator.findOne({name});

        if(name.includes('-') || newName.includes('-')) {
            return res.status(400).json({ status: "New name cannot contain '-' character" });
        }

        if (!validator) {
            return res.status(404).json({ status: "Validator not found" });
        }
        
        await Validator.updateOne({ name }, { name: newName });
        res.status(200).json({ status: "Name updated" });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
}

validatorController.updateValidator = async (req, res) => {
    try {
        const { id, email, adminEmail } = req.body;
        const periodId = getRequestPeriodId(req);
        const validatorId = id || req.query.id;
        const userEmail = email || adminEmail || req.query.email || req.body.userEmail;
        const payload = pickValidatorPayload(req.body);
        
        console.log('Update validator - Body:', req.body);
        console.log('Update validator - Query:', req.query);
        console.log('Update validator - Extracted userEmail:', userEmail);
        
        if (!validatorId) {
            return res.status(400).json({ status: "Validator ID is required" });
        }
        
        // Usar email 
        const finalUserEmail = userEmail;
        
        const user = await User.findOne({ email: finalUserEmail });
        if (!user) {
            return res.status(404).json({ status: "User not found" });
        }
        
        const period = await getPeriodOrThrow(periodId);
        const validator = period ? findValidatorInPeriod(period, validatorId) : await Validator.findById(validatorId);
        if (!validator) {
            return res.status(404).json({ status: "Validator not found" })
        }
        if (payload.name && payload.name.includes('-')) {
            return res.status(400).json({ 
                status: "The new name cannot contain the '-' character" 
            });
        }
        if(payload.columns?.some(column => column.name.includes('-'))) {
            return res.status(400).json({ status: "Columns name cannot contain '-' character" });
        }

        if (period && payload.name) {
            const existsInPeriod = (period.screenshot.validators || []).some((item) => (
                String(item?._id || '') !== String(validatorId) && sameValidatorName(item.name, payload.name)
            ));
            if (existsInPeriod) {
                return res.status(400).json({ status: "Validator already exists in this period" });
            }
        }

        validator.set(payload)
        if (period) {
            validator.updatedAt = new Date();
            period.markModified('screenshot.validators');
            await period.save();
        } else {
            await validator.save()
        }
        
        // Audit log
        await auditLogger.logUpdate(req, user, 'validator', {
            validatorId: validatorId,
            validatorName: validator.name,
            period: periodId || undefined
        });
        
        res.status(200).json({ status: "Validator updated" })
    }
    catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message })
    }
}

validatorController.getValidators = async (req, res) => {
    try {
        const { email, page = 1, limit = 10, search = '', periodId } = req.query;
        const pageNumber = Number(page);
        const limitNumber = Number(limit);

        // Buscar usuario activo por email
        const user = await User.findOne({ email, isActive: true });
        if (!user) {
            return res.status(404).json({ status: "User not found" });
        }
        
        // Crear filtro de búsqueda para todos los campos del validador
        if (hasPeriodId(periodId)) {
            const period = await getPeriodOrThrow(periodId);
            const filteredValidators = filterValidators(getPeriodValidators(period), search);
            const validators = filteredValidators.slice((pageNumber - 1) * limitNumber, pageNumber * limitNumber);

            return res.status(200).json({
                validators,
                currentPage: pageNumber,
                totalPages: Math.ceil(filteredValidators.length / limitNumber),
                totalValidators: filteredValidators.length
            });
        }

        const searchFilter = search
            ? {
                $or: [
                    { name: { $regex: search, $options: 'i' } },
                    { description: { $regex: search, $options: 'i' } },
                    { otherField1: { $regex: search, $options: 'i' } }, // Añade aquí los campos que desees incluir en la búsqueda
                    { otherField2: { $regex: search, $options: 'i' } }
                ]
            }
            : {};

        // Obtener la lista de validadores con paginación y filtro de búsqueda
        const validators = await Validator.find(searchFilter)
            .skip((page - 1) * limit)
            .limit(Number(limit));

        // Obtener el total de documentos para calcular páginas totales
        const totalValidators = await Validator.countDocuments(searchFilter);

        res.status(200).json({
            validators,
            currentPage: Number(page),
            totalPages: Math.ceil(totalValidators / limit),
            totalValidators
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
}


validatorController.getValidatorOptions = async (req, res) => {
    try {
        let { periodId } = req.query;

        // Si no se provee periodId, usar el periodo activo más reciente
        if (!hasPeriodId(periodId)) {
            const activePeriod = await Period.findOne({ is_active: true })
                .sort({ end_date: -1 })
                .select('_id');
            if (activePeriod) {
                periodId = String(activePeriod._id);
            }
        }

        const options = [
          { name: 'Funcionarios', type: 'Entero' },
          { name: 'Estudiantes', type: 'Texto Corto' },
          { name: 'Participantes', type: 'Texto Corto' },
        ];
        const seenNames = new Set(options.map(o => o.name.trim().toLowerCase()));

        if (hasPeriodId(periodId) && mongoose.Types.ObjectId.isValid(String(periodId))) {
            const period = await Period.findById(periodId).select('screenshot.validators');
            const periodValidators = getPeriodValidators(period);

            // Mostrar solo el nombre del validador del periodo activo (sin columnas)
            periodValidators.forEach(validator => {
                const key = String(validator.name || '').toLowerCase();
                if (seenNames.has(key)) return;
                seenNames.add(key);
                const primaryCol = (validator.columns || []).find(c => c.is_validator) || (validator.columns || [])[0];
                options.push({ name: validator.name, type: primaryCol?.type || 'Texto' });
            });
        }

        res.status(200).json({ options });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
}

validatorController.getValidator = async (req, res) => {
    const { name, periodId } = req.query
    try {
        const period = await getPeriodOrThrow(periodId);
        const validator = period ? findValidatorInPeriod(period, name) : await Validator.findOne({name})
        if (!validator) {
            return res.status(404).json({ status: "Validator not found" })
        }
        res.status(200).json({ validator })
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message })
    }
}

validatorController.getValidatorById = async (req, res) => {
    const { id, periodId } = req.query
    try {
        if (!id || id === 'undefined') {
            return res.status(400).json({ status: "Valid validator ID is required" })
        }
        
        let validator;
        const period = await getPeriodOrThrow(periodId);

        if (period) {
            validator = findValidatorInPeriod(period, id);
        }

        if (!validator) {
            if (id.match(/^[0-9a-fA-F]{24}$/)) {
                validator = await Validator.findById(id);
            } else {
                validator = await Validator.findOne({ name: new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
            }
        }
        
        if (!validator) {
            return res.status(404).json({ status: "Validator not found" })
        }
        res.status(200).json({ validator })
    }
    catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message })
    }
}

validatorController.getValidatorsWithPagination = async (req, res) => {
    try {
        const { page = 1, limit = 10, search = "", periodId } = req.query;
        const pageNumber = Number(page);
        const limitNumber = Number(limit);
        const query = search ? { name: { $regex: search, $options: 'i' } } : {};

        if (hasPeriodId(periodId)) {
            const period = await getPeriodOrThrow(periodId);
            const filteredValidators = filterValidators(getPeriodValidators(period), search);
            const validators = filteredValidators.slice((pageNumber - 1) * limitNumber, pageNumber * limitNumber);

            return res.status(200).json({
                validators,
                pages: Math.ceil(filteredValidators.length / limitNumber),
                currentPage: pageNumber,
                totalValidators: filteredValidators.length,
            });
        }

        const validators = await Validator.find(query)
            .skip((page - 1) * limit)
            .limit(Number(limit))
            .exec();

        const totalCount = await Validator.countDocuments(query);

        res.status(200).json({
            validators,
            pages: Math.ceil(totalCount / limit),
            currentPage: Number(page),
            totalValidators: totalCount,
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

validatorController.deleteValidator = async (req, res) => {
    try {
        const { id } = req.body;
        const periodId = getRequestPeriodId(req);
        const email = req.body.email || req.query.email || req.user?.email;
        
        if (!email) {
            return res.status(400).json({ status: "Email is required" });
        }
        
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ status: "User not found" });
        }
        
        const period = await getPeriodOrThrow(periodId);
        const validator = period ? findValidatorInPeriod(period, id) : await Validator.findById(id);
        if (!validator) {
            return res.status(404).json({ status: "Validator not found" });
        }
        
        if (period) {
            period.screenshot.validators = (period.screenshot.validators || []).filter((item) => String(item?._id || '') !== String(id));
            period.markModified('screenshot.validators');
            await period.save();
        } else {
            await Validator.findByIdAndDelete(id);
        }
        
        // Audit log
        await auditLogger.logDelete(req, user, 'validator', {
            validatorId: id,
            validatorName: validator.name,
            period: periodId || undefined
        });
        
        res.status(200).json({ status: "Validator deleted" });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

validatorController.validateColumn = async (column, periodId = null) => {
  let { values } = column;
  let { name, datatype, validate_with, required, multiple } = column;
  required = getEffectiveRequired(column);
  let result = { status: true, column: name, errors: [] };


  if (!name || !datatype || !values) {
    return { status: false, errors: [{ register: null, message: 'Hace falta el nombre, tipo de dato o valor para la columna ' + column?.name }] };
  }

  const oldValues = values;
  
  // PRIMERO: Normalizar arrays antes de cualquier validación (incluyendo arrays anidados y strings JSON)
  values = values.map(value => {
    let normalizedValue = value;
    
    // Manejar arrays anidados: [[["2"]]] -> [["2"]] -> ["2"] -> "2"
    while (Array.isArray(normalizedValue) && normalizedValue.length === 1) {
      console.log(`DEBUG - Normalizando array anidado:`, normalizedValue, '-> primer elemento:', normalizedValue[0]);
      normalizedValue = normalizedValue[0];
    }
    
    // DESPUÉS: Manejar strings que contienen JSON arrays como '["2"]'
    if (typeof normalizedValue === 'string' && normalizedValue.startsWith('[') && normalizedValue.endsWith(']')) {
      try {
        const parsed = JSON.parse(normalizedValue);
        if (Array.isArray(parsed) && parsed.length === 1) {
          console.log(`DEBUG - Parseando string JSON '${normalizedValue}' -> ${parsed[0]}`);
          normalizedValue = parsed[0];
        }
      } catch (e) {
        // Si no se puede parsear, mantener el valor original
      }
    }
    
    if (normalizedValue !== value) {
      console.log(`DEBUG - Valor final normalizado:`, normalizedValue);
    }

    if (!required && isBlankValue(normalizedValue)) {
      return null;
    }
    
    return normalizedValue;
  });
  
  if (multiple) {
  values = values.flatMap(value => {
    if (typeof value === 'number') {
      return String(value).split(',').map(v => v.trim());
    } else if (typeof value === 'string') {
      return value.split(',').map(v => v.trim());
    } else if (Array.isArray(value)) {
      return value.flatMap(v => 
        typeof v === 'number'
          ? String(v).split(',').map(x => x.trim())
          : typeof v === 'string'
            ? v.split(',').map(x => x.trim())
            : [v]
      );
    } else {
      return [value];
    }
  });
}


  if (datatype === "Link") {
    values = values.map(value => {
      if (typeof value === 'object' && value !== null) {
        return value.hyperlink ?? '';
      }
      if (typeof value === 'string' && value.startsWith('=HYPERLINK(')) {
        const match = value.match(/HYPERLINK\("([^"]+)"/);
        return match ? match[1] : '';
      }
      return value;
    });
  }

  if (datatype === "Entero") {
  values = values.map(value => {
    const isEmpty = isBlankValue(value);
    if (!required && isEmpty) return null;
    
    // Convertir directamente a entero
    const num = parseInt(value);
    console.log(`DEBUG - Convirtiendo '${value}' a entero: ${num}`);
    return isNaN(num) ? value : num;
  });
} else if (datatype === "Decimal" || datatype === "Porcentaje") {
  if (!multiple) {
    values = values.map(value => {
      const isEmpty = isBlankValue(value);
      if (!required && isEmpty) return null;
      
      const num = Number(value);
      console.log(`DEBUG - Convirtiendo '${value}' a número: ${num}`);
      return isNaN(num) ? value : num;
    });
  }
}

  let validator = null;
  let columnToValidate = null;
  let validValuesSet = null;
  let acceptedStringValuesSet = null;
  let activeValidationLabel = validate_with;
  const shouldValidateOptionalField = required || values.some((value) => hasMeaningfulValue(value));

  if (validate_with && shouldValidateOptionalField) {
    const [validatorName, columnName] = validate_with.split(' - ');
    console.log('DEBUG validateColumn - validate_with:', validate_with);
    console.log('DEBUG validateColumn - validatorName:', validatorName);
    console.log('DEBUG validateColumn - columnName:', columnName);

    if (validatorName === "Funcionarios") {
      const users = await User.find({}, { identification: 1 }).lean();
      const userIdentifications = users.map(user => user.identification);
      validValuesSet = new Set(userIdentifications);
      columnToValidate = { type: "Texto", values: userIdentifications };
    } else if (validatorName === "Estudiantes") {
      if (columnName === "Código") {
        const students = await Student.find({}, { code_student: 1 }).lean();
        const studentCodes = students.map(student => student.code_student);
        validValuesSet = new Set(studentCodes);
        columnToValidate = { type: "Texto", values: studentCodes };
      } else {
        const students = await Student.find({}, { identification: 1 }).lean();
        const studentIdentifications = students.map(student => student.identification);
        validValuesSet = new Set(studentIdentifications);
        columnToValidate = { type: "Texto", values: studentIdentifications };
      }
    } else if (validatorName === "Participantes") {
      const students = await Student.find({}, { identification: 1 }).lean();
      const users = await User.find({}, { identification: 1 }).lean();
      const participantIdentifications = [
        ...students.map(student => student.identification),
        ...users.map(user => user.identification)
      ];
      validValuesSet = new Set(participantIdentifications);
      columnToValidate = { type: "Texto", values: participantIdentifications };
    } else {
      validator = await validatorController.findValidatorByName(validatorName, periodId);
      console.log('DEBUG - Buscando validador con nombre:', validatorName);
      console.log('DEBUG - Validador encontrado:', validator ? 'SÍ' : 'NO');
      
      // Si no se encuentra, intentar con el nombre de la columna como nombre del validador
      if (!validator && columnName) {
        validator = await validatorController.findValidatorByName(columnName, periodId);
        console.log('DEBUG - Intentando con columnName:', columnName);
        console.log('DEBUG - Validador encontrado con columnName:', validator ? 'SÍ' : 'NO');
        
        // Si se encuentra con columnName, actualizar el nombre para la búsqueda de columna
        if (validator) {
          console.log('DEBUG - Usando validador encontrado por columnName, buscando columna:', columnName);
        }
      }
      
      if (!validator) {
        // Buscar validadores similares para debug
        const allValidators = await validatorController.listValidatorsByPeriod(periodId);
        console.log('DEBUG - Todos los validadores disponibles:', allValidators.map(v => v.name));
        
        return {
          status: false,
          errors: [{ register: null, message: `Tabla de validación no encontrada: ${validatorName}` }]
        };
      }

      // Si encontramos el validador por columnName, buscar la columna correcta
      if (validatorName !== validator.name || !columnName) {
        // El validador se encontró por columnName, buscar la primera columna que sea validadora
        columnToValidate = validator.columns.find(column => column.is_validator);
        console.log('DEBUG - Buscando primera columna validadora:', columnToValidate ? columnToValidate.name : 'NO ENCONTRADA');
      } else {
        // Búsqueda normal por nombre de columna
        columnToValidate = validator.columns.find(column => column.name === columnName)
          || validator.columns.find(column => column.is_validator)
          || validator.columns[0];
      }

      if (!columnToValidate) {
        return {
          status: false,
          errors: [{ register: null, message: `Columna '${columnName}' no encontrada en la tabla: ${validator.name}` }]
        };
      }

      validValuesSet = new Set(columnToValidate.values);
      acceptedStringValuesSet = buildAcceptedValidatorStringSet(validator, columnToValidate);
      activeValidationLabel = `${validator.name} - ${columnToValidate.name}`;
      console.log('DEBUG - Valores válidos para', validatorName, ':', Array.from(validValuesSet).slice(0, 10), '...');
    }
  }

  if (!validate_with && shouldValidateOptionalField) {
    const dropdownOptions = getFieldDropdownOptions(column);
    if (dropdownOptions.length > 0) {
      columnToValidate = { type: 'Texto', values: dropdownOptions };
      validValuesSet = new Set(dropdownOptions);
      acceptedStringValuesSet = buildAcceptedDropdownOptionSet(dropdownOptions);
      activeValidationLabel = `${name} (opciones permitidas)`;
    }
  }

  if (validValuesSet && !acceptedStringValuesSet) {
    acceptedStringValuesSet = new Set(
      Array.from(validValuesSet).map((item) => normalizeComparableText(item)).filter(Boolean)
    );
  }

  validate_with = activeValidationLabel;

  values.forEach((value, index) => {
const realIndex = index;

  const isEmpty = isBlankValue(value);

  // PRIMERO: Si el valor es vacío y no es requerido, saltar TODA validación
  if (!required && isEmpty) {
    return;
  }

  // SEGUNDO: Si es requerido y está vacío, error
  if (required && isEmpty) {
    result.status = false;
    result.errors.push({
      register: realIndex + 1,
      message: `El campo "${name}" es obligatorio y no puede estar vacío (fila ${realIndex + 1})`,
      value: "Sin valor"
    });
    return;
  }

// Validación de tipo eliminada: solo se valida obligatorio/opcional y lista de valores permitidos

if (columnToValidate && validValuesSet) {
  // Si el campo no es obligatorio y está vacío, saltar validación de validate_with también
  if (!required && isBlankValue(value)) {
    return; // Saltar validación de validate_with para campos no obligatorios vacíos
  }
  
  if (multiple && Array.isArray(value)) {
    value.forEach(val => {
      let normalizedVal = val;

      // Detectar si los valores del validador son números
      const firstValidValue = Array.from(validValuesSet)[0];
      const validatorHasNumbers = typeof firstValidValue === 'number';
      
      // PRIMERO: Si es un array, extraer el primer valor
      let valueToNormalize = val;
      if (Array.isArray(val) && val.length > 0) {
        valueToNormalize = val[0];
      }
      
      if (validatorHasNumbers) {
        const num = Number(valueToNormalize);
        if (!Number.isNaN(num)) {
          normalizedVal = num;
        } else {
          const numericPrefix = String(valueToNormalize || '').trim().match(/^-?\d+(?=\s*(?:[-).:]|\s))/);
          normalizedVal = numericPrefix ? Number(numericPrefix[0]) : valueToNormalize;
        }
      } else {
        normalizedVal = normalizeComparableText(valueToNormalize);
      }

      // Acepta: texto limpio, "N. Texto" (prefijo numérico) o solo "N" (índice 1-basado)
      let isValidValue = validatorHasNumbers
        ? validValuesSet.has(normalizedVal)
        : acceptedStringValuesSet?.has(normalizedVal);

      if (!isValidValue && !validatorHasNumbers) {
        const stripped = normalizeComparableText(String(valueToNormalize).replace(/^\s*\d+[).:\-\s]+\s*/, '').trim());
        if (stripped && stripped !== normalizedVal) isValidValue = !!acceptedStringValuesSet?.has(stripped);
        if (!isValidValue && /^\s*\d+\s*$/.test(String(valueToNormalize))) {
          const idx = parseInt(String(valueToNormalize).trim(), 10) - 1;
          isValidValue = idx >= 0 && idx < (columnToValidate?.values?.length ?? 0);
        }
        // Extrae código del valor completo (ej: "CC Cédula de ciudadanía" → "CC")
        if (!isValidValue) {
          const codePrefix = /^([A-Z0-9]{1,6})[\s\-]/.exec(normalizeComparableText(String(valueToNormalize)));
          if (codePrefix) isValidValue = !!acceptedStringValuesSet?.has(codePrefix[1]);
        }
        // También verifica si el valor completo está en validValuesSet normalizado
        if (!isValidValue) {
          isValidValue = Array.from(validValuesSet).some(v =>
            normalizeComparableText(String(v)) === normalizedVal
          );
        }
      }

      if (!isValidValue) {
        result.status = false;
        result.errors.push({
          register: realIndex + 1,
          message: `Valor de la columna ${name}, fila ${realIndex + 1} no fue encontrado en la validación: ${validate_with}`,
          value: val === null || val === undefined || val === '' ? "Sin valor" : (typeof val === 'object' ? JSON.stringify(val) : String(val))
        });
      }
    });
  } else {
    // Solo validar validate_with si el campo es obligatorio O si tiene valor
    if (required || !isBlankValue(value)) {
      let normalizedVal = value;

      // Detectar si los valores del validador son números
      const firstValidValue = Array.from(validValuesSet)[0];
      const validatorHasNumbers = typeof firstValidValue === 'number';
      
      // PRIMERO: Si es un array, extraer el primer valor
      let valueToNormalize = value;
      if (Array.isArray(value) && value.length > 0) {
        valueToNormalize = value[0];
        console.log('DEBUG - Array detectado, extrayendo primer valor:', valueToNormalize);
      }
      
      if (validatorHasNumbers) {
        const num = Number(valueToNormalize);
        if (!Number.isNaN(num)) {
          normalizedVal = num;
        } else {
          const numericPrefix = String(valueToNormalize || '').trim().match(/^-?\d+(?=\s*(?:[-).:]|\s))/);
          normalizedVal = numericPrefix ? Number(numericPrefix[0]) : valueToNormalize;
        }
      } else {
        normalizedVal = normalizeComparableText(valueToNormalize);
      }

      console.log('DEBUG - Valor original:', value, 'Valor normalizado:', normalizedVal, 'Tipo validador:', validatorHasNumbers ? 'números' : 'strings');

      // Acepta: texto limpio, "N. Texto" (prefijo numérico) o solo "N" (índice 1-basado)
      let isValidValue = validatorHasNumbers
        ? validValuesSet.has(normalizedVal)
        : acceptedStringValuesSet?.has(normalizedVal);

      if (!isValidValue && !validatorHasNumbers) {
        const stripped = normalizeComparableText(String(valueToNormalize).replace(/^\s*\d+[).:\-\s]+\s*/, '').trim());
        if (stripped && stripped !== normalizedVal) isValidValue = !!acceptedStringValuesSet?.has(stripped);
        if (!isValidValue && /^\s*\d+\s*$/.test(String(valueToNormalize))) {
          const idx = parseInt(String(valueToNormalize).trim(), 10) - 1;
          isValidValue = idx >= 0 && idx < (columnToValidate?.values?.length ?? 0);
        }
        // Extrae código del valor completo (ej: "CC Cédula de ciudadanía" → "CC")
        if (!isValidValue) {
          const codePrefix = /^([A-Z0-9]{1,6})[\s\-]/.exec(normalizeComparableText(String(valueToNormalize)));
          if (codePrefix) isValidValue = !!acceptedStringValuesSet?.has(codePrefix[1]);
        }
        // También verifica si el valor completo está en validValuesSet normalizado
        if (!isValidValue) {
          isValidValue = Array.from(validValuesSet).some(v =>
            normalizeComparableText(String(v)) === normalizedVal
          );
        }
      }

      if (!isValidValue) {
        result.status = false;
        result.errors.push({
          register: realIndex + 1,
          message: `Valor de la columna ${name}, fila ${realIndex + 1} no fue encontrado en la validación: ${validate_with}`,
          value: value === null || value === undefined || value === '' ? "Sin valor" : (typeof value === 'object' ? JSON.stringify(value) : String(value))
        });
      }
    }
  }
}

});

  return result;
};

const normalizeValidatorToken = (value = '') =>
    String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');

const normalizeReadableLine = (value = '') =>
    String(value || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

const removeLeadingIdToken = (value = '') => normalizeValidatorToken(value).replace(/^ID_+/, '');

const removeSubjectStopWords = (value = '') => {
    const stopWords = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL']);
    const tokens = normalizeValidatorToken(value)
        .split('_')
        .filter((token) => token && !stopWords.has(token));

    while (['DOCENTE', 'DOCENTES', 'ESTUDIANTE', 'ESTUDIANTES'].includes(tokens[tokens.length - 1])) {
        tokens.pop();
    }

    return tokens.join('_');
};

const looksLikeOptionsMarker = (line = '') => {
    const marker = normalizeComparableText(line);
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

const stripCommentMetadata = (line = '') => {
    const text = normalizeReadableLine(line);
    if (!text || text === '======' || /^ID#/i.test(text) || /^\(\d{4}-\d{2}-\d{2}/.test(text)) {
        return '';
    }
    return text;
};

const stripValidationPrefix = (line = '') => {
    const text = normalizeReadableLine(line).replace(/[.:]\s*$/, '');
    if (!text) return '';

    const parts = text.split(/\.\s+/).map(normalizeReadableLine).filter(Boolean);
    const candidate = parts[parts.length - 1] || text;
    const normalizedCandidate = normalizeComparableText(candidate);

    if (
        normalizedCandidate.startsWith('OBLIG') ||
        normalizedCandidate.includes('NUMERICO') ||
        normalizedCandidate.includes('ALFABETICO') ||
        normalizedCandidate.includes('ALFANUMERICO') ||
        normalizedCandidate.includes('TIPO FECHA')
    ) {
        return '';
    }

    return candidate;
};

const parseStructuredOptionLine = (line = '') => {
    const text = normalizeReadableLine(line)
        .replace(/^[-*]\s*/, '')
        .replace(/^["']+|["']+$/g, '');
    if (!text) return null;

    const numericMatch = text.match(/^(-?\d+(?:[.,]\d+)?)\s*(?:[.)\-:]\s*)?(.+)$/);
    if (numericMatch) {
        const code = numericMatch[1].replace(',', '.').trim();
        const description = normalizeReadableLine(numericMatch[2]).replace(/^[-:]\s*/, '');
        if (code && description) return { code, description };
    }

    const alphaMatch = text.match(/^([A-Za-z0-9]{1,12})\s{2,}(.+)$/)
        || text.match(/^([A-Z0-9]{1,12})\s+(.+)$/);
    if (alphaMatch) {
        const code = alphaMatch[1].trim();
        const description = normalizeReadableLine(alphaMatch[2]).replace(/^[-:]\s*/, '');
        if (code && description) return { code, description };
    }

    return null;
};

const getCommentOptionSubject = (lines, markerIndex) => {
    for (let index = markerIndex - 1; index >= 0; index -= 1) {
        const candidate = stripValidationPrefix(stripCommentMetadata(lines[index]));
        if (candidate) return candidate;
    }
    return '';
};

const extractStructuredRowsFromComment = (comment = '') => {
    const rawLines = String(comment || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const markerIndex = rawLines.findIndex((line) => looksLikeOptionsMarker(stripCommentMetadata(line)));
    if (markerIndex < 0) return { rows: [], subject: '' };

    const subject = getCommentOptionSubject(rawLines, markerIndex);
    const rows = [];
    const seen = new Set();
    let hasReadOption = false;

    for (let index = markerIndex + 1; index < rawLines.length; index += 1) {
        const line = stripCommentMetadata(rawLines[index]);
        if (!line) {
            if (hasReadOption) break;
            continue;
        }

        const parsed = parseStructuredOptionLine(line);
        if (!parsed) {
            if (hasReadOption && line.includes(':')) break;
            continue;
        }

        const key = normalizeComparableText(parsed.code);
        if (!key || seen.has(key)) continue;

        seen.add(key);
        rows.push(parsed);
        hasReadOption = true;
    }

    return { rows, subject };
};

const extractStructuredRowsFromListValues = (values = []) => {
    const rows = [];
    const seen = new Set();

    values.forEach((item) => {
        let parsed = null;

        if (item && typeof item === 'object' && !Array.isArray(item)) {
            const code = item.code ?? item.id ?? item.value ?? item.key;
            const description = item.description ?? item.label ?? item.name ?? item.text;
            const cleanCode = collapseRepeatedCompositeOption(String(code ?? '').trim());
            const cleanDescription = collapseRepeatedCompositeOption(String(description ?? '').trim());
            if (code !== undefined && description !== undefined && cleanCode !== cleanDescription) {
                parsed = {
                    code: cleanCode,
                    description: normalizeReadableLine(cleanDescription),
                };
            } else if (cleanCode || cleanDescription) {
                parsed = parseStructuredOptionLine(cleanCode || cleanDescription);
            }
        } else {
            parsed = parseStructuredOptionLine(collapseRepeatedCompositeOption(item));
        }

        if (!parsed?.code || !parsed?.description) return;

        const key = normalizeComparableText(parsed.code);
        if (!key || seen.has(key)) return;

        seen.add(key);
        rows.push(parsed);
    });

    return rows;
};

const getValidatorDropdownOptionValues = (field = {}) => [
    ...(Array.isArray(field.excel_validation_options) ? field.excel_validation_options : []),
    ...(Array.isArray(field.validator_options) ? field.validator_options : []),
    ...(Array.isArray(field.dropdown_options) ? field.dropdown_options : []),
    ...getFieldDropdownOptions({ comment: field.comment }),
];

const getValidatorDropdownOptions = (field = {}) => getFieldDropdownOptions({
    excel_validation_options: [
        ...(Array.isArray(field.excel_validation_options) ? field.excel_validation_options : []),
        ...(Array.isArray(field.validator_options) ? field.validator_options : []),
    ],
    dropdown_options: Array.isArray(field.dropdown_options) ? field.dropdown_options : [],
    comment: field.comment,
});

const extractStructuredValidatorOptions = (field = {}) => {
    const fromComment = extractStructuredRowsFromComment(field.comment);
    if (fromComment.rows.length > 0) return fromComment;

    return {
        rows: extractStructuredRowsFromListValues(getValidatorDropdownOptionValues(field)),
        subject: '',
    };
};

const deriveStructuredValidatorName = (field = {}, subject = '') => {
    const fieldName = normalizeValidatorToken(field.name);
    const fieldNameWithoutId = removeLeadingIdToken(fieldName);
    const subjectName = removeSubjectStopWords(subject);

    if (subjectName && fieldNameWithoutId) {
        const fieldTokens = fieldNameWithoutId.split('_').filter(Boolean);
        const subjectTokens = new Set(subjectName.split('_').filter(Boolean));
        const subjectContainsField = fieldTokens.length > 0 && fieldTokens.every((token) => subjectTokens.has(token));
        if (subjectContainsField) return fieldNameWithoutId;
    }

    return subjectName || fieldNameWithoutId || fieldName;
};

const shouldStoreCodesAsNumbers = (rows = []) =>
    rows.length > 0 && rows.every((row) => /^-?\d+$/.test(String(row.code || '').trim()));

const castStructuredCode = (code, useNumber) => {
    const text = String(code || '').trim();
    if (!useNumber) return text;
    const numberValue = Number(text);
    return Number.isSafeInteger(numberValue) ? numberValue : text;
};

const deriveStructuredCodeColumnName = (field = {}, validatorName = '', rows = []) => {
    const fieldName = normalizeValidatorToken(field.name);
    const fieldNameWithoutId = removeLeadingIdToken(fieldName);

    if (shouldStoreCodesAsNumbers(rows)) {
        return fieldName || `ID_${validatorName}`;
    }

    if (validatorName.startsWith('TIPO_') || fieldNameWithoutId.startsWith('TIPO_')) {
        return 'TIPO';
    }

    return fieldNameWithoutId || fieldName || 'CODIGO';
};

const buildStructuredValidatorColumns = (field, validatorName, rows) => {
    const useNumber = shouldStoreCodesAsNumbers(rows);

    return [
        {
            name: deriveStructuredCodeColumnName(field, validatorName, rows),
            is_validator: true,
            type: useNumber ? 'Entero' : 'Texto Corto',
            values: rows.map((row) => castStructuredCode(row.code, useNumber)),
        },
        {
            name: 'DESCRIPCION',
            is_validator: false,
            type: 'Texto Corto',
            values: rows.map((row) => row.description),
        },
    ];
};

const getColumnSignature = (columns = []) => JSON.stringify(
    (columns || []).map((column) => ({
        name: column.name,
        is_validator: Boolean(column.is_validator),
        type: column.type,
        values: column.values || [],
    }))
);

const applyStructuredColumnsToValidator = (validator, nextColumns) => {
    if (!validator) return false;
    if (!Array.isArray(validator.columns)) validator.columns = [];

    const currentCodeColumn = validator.columns.find((column) => column.is_validator) || validator.columns[0];
    const currentDescriptionColumn = validator.columns.find((column) => (
        currentCodeColumn && column !== currentCodeColumn && isDescriptionColumn(column.name)
    ));

    if (!currentDescriptionColumn) {
        const changed = getColumnSignature(validator.columns) !== getColumnSignature(nextColumns);
        if (changed) validator.columns = nextColumns;
        return changed;
    }

    const useNumber = nextColumns[0].type === 'Entero';
    const merged = new Map();

    (currentCodeColumn.values || []).forEach((value, index) => {
        const key = normalizeComparableText(value);
        const description = currentDescriptionColumn.values?.[index];
        const descriptionText = description === undefined || description === null ? '' : String(description).trim();
        if (key && descriptionText) {
            merged.set(key, {
                code: castStructuredCode(value, useNumber),
                description: descriptionText,
            });
        }
    });

    (nextColumns[0].values || []).forEach((value, index) => {
        const key = normalizeComparableText(value);
        const description = nextColumns[1].values?.[index] || '';
        if (!key) return;

        merged.set(key, {
            code: castStructuredCode(value, useNumber),
            description,
        });
    });

    const mergedRows = Array.from(merged.values());
    const mergedColumns = [
        {
            ...nextColumns[0],
            values: mergedRows.map((row) => row.code),
        },
        {
            ...nextColumns[1],
            values: mergedRows.map((row) => row.description),
        },
    ];

    const changed = getColumnSignature(validator.columns) !== getColumnSignature(mergedColumns);
    if (changed) validator.columns = mergedColumns;
    return changed;
};

validatorController.createValidatorsFromDropdownOptions = async (fields, periodId) => {
    if (!hasPeriodId(periodId)) return;
    if (!mongoose.Types.ObjectId.isValid(String(periodId))) return;

    const period = await Period.findById(periodId);
    if (!period) return;

    if (!period.screenshot) period.screenshot = {};
    if (!Array.isArray(period.screenshot.validators)) period.screenshot.validators = [];

    // Elimina solo el sufijo " (N)" que agrega makeUnique en el frontend.
    const sanitizeName = (name) =>
        String(name || '')
            .replace(/\s*\(\d+\)$/, '')
            .trim();

    const existingValidatorsByName = new Map(
        period.screenshot.validators.flatMap((v) => {
            const keys = [
                sanitizeName(v.name).toLowerCase(),
                normalizeValidatorToken(v.name).toLowerCase(),
            ].filter(Boolean);
            return [...new Set(keys)].map((key) => [key, v]);
        })
    );

    let periodModified = false;

    for (const field of (fields || [])) {
        // Solo crear validadores para campos con lista desplegable real.
        const structuredOptions = extractStructuredValidatorOptions(field);
        const options = getValidatorDropdownOptions(field);
        if (options.length === 0 && structuredOptions.rows.length === 0) continue;
        if (field.validate_with && String(field.validate_with).trim() !== '') continue;

        const hasStructuredOptions = structuredOptions.rows.length > 0;
        const validatorName = sanitizeName(field.name);
        const legacyValidatorName = hasStructuredOptions
            ? deriveStructuredValidatorName(field, structuredOptions.subject)
            : validatorName;
        if (!validatorName) continue;

        const nameLower = sanitizeName(validatorName).toLowerCase();
        const normalizedNameLower = normalizeValidatorToken(validatorName).toLowerCase();

        if (hasStructuredOptions) {
            const lookupKeys = [
                nameLower,
                normalizedNameLower,
                sanitizeName(legacyValidatorName).toLowerCase(),
                normalizeValidatorToken(legacyValidatorName).toLowerCase(),
                sanitizeName(field.name).toLowerCase(),
                normalizeValidatorToken(field.name).toLowerCase(),
            ].filter(Boolean);
            let existingValidator = lookupKeys.map((key) => existingValidatorsByName.get(key)).find(Boolean);
            const structuredColumns = buildStructuredValidatorColumns(field, validatorName, structuredOptions.rows);

            if (existingValidator) {
                if (existingValidator.name !== validatorName) {
                    existingValidator.name = validatorName;
                    periodModified = true;
                }

                if (applyStructuredColumnsToValidator(existingValidator, structuredColumns)) {
                    periodModified = true;
                }

                existingValidatorsByName.set(nameLower, existingValidator);
                existingValidatorsByName.set(normalizedNameLower, existingValidator);
                continue;
            }

            const newValidator = new Validator({
                name: validatorName,
                columns: structuredColumns,
            });

            period.screenshot.validators.push(newValidator.toObject());
            existingValidator = period.screenshot.validators[period.screenshot.validators.length - 1];
            existingValidatorsByName.set(nameLower, existingValidator);
            existingValidatorsByName.set(normalizedNameLower, existingValidator);
            periodModified = true;
            continue;
        }

        const seenOptions = new Set();
        const cleanOptions = options
            .map((o) => collapseRepeatedCompositeOption(String(o).trim()))
            .filter((option) => {
                const key = normalizeDropdownOptionKey(option);
                if (!key || seenOptions.has(key)) return false;
                seenOptions.add(key);
                return true;
            });
        if (cleanOptions.length === 0) continue;

        const existingValidator = existingValidatorsByName.get(nameLower);
        if (existingValidator) {
            if (!Array.isArray(existingValidator.columns)) existingValidator.columns = [];
            let validatorColumn = existingValidator.columns.find((column) => column.is_validator)
                || existingValidator.columns.find((column) => sanitizeName(column.name).toLowerCase() === nameLower)
                || existingValidator.columns[0];
            const descriptionColumn = existingValidator.columns.find((column) => (
                validatorColumn && column !== validatorColumn && isDescriptionColumn(column.name)
            ));
            if (descriptionColumn) continue;

            if (!validatorColumn) {
                validatorColumn = {
                    name: validatorName,
                    is_validator: true,
                    type: 'Texto',
                    values: [],
                };
                existingValidator.columns.push(validatorColumn);
            }

            if (!Array.isArray(validatorColumn.values)) validatorColumn.values = [];
            const cleanedCurrentValues = validatorColumn.values.map(cleanValidatorValue);
            if (JSON.stringify(cleanedCurrentValues) !== JSON.stringify(validatorColumn.values)) {
                validatorColumn.values = cleanedCurrentValues;
                periodModified = true;
            }
            // Comparar también por clave sin prefijo numérico para evitar "Presencial" y "1 Presencial" coexistiendo
            const stripNumericPrefix = (k) => k.replace(/^\d+\s+/, '');
            const currentOptionKeys = new Set(validatorColumn.values.map(normalizeDropdownOptionKey));
            const currentOptionKeysClean = new Set([...currentOptionKeys].map(stripNumericPrefix));
            const missingOptions = cleanOptions.filter((option) => {
                const key = normalizeDropdownOptionKey(option);
                return !currentOptionKeys.has(key) && !currentOptionKeysClean.has(stripNumericPrefix(key));
            });

            if (missingOptions.length > 0) {
                validatorColumn.values.push(...missingOptions);
                periodModified = true;
            }
            continue;
        }

        const newValidator = new Validator({
            name: validatorName,
            columns: [
                {
                    name: validatorName,
                    is_validator: true,
                    type: 'Texto',
                    values: cleanOptions,
                },
            ],
        });

        period.screenshot.validators.push(newValidator.toObject());
        existingValidatorsByName.set(nameLower, period.screenshot.validators[period.screenshot.validators.length - 1]);
        existingValidatorsByName.set(normalizedNameLower, period.screenshot.validators[period.screenshot.validators.length - 1]);
        periodModified = true;
    }

    if (periodModified) {
        // Eliminar duplicados por nombre antes de guardar (protege contra condiciones de carrera)
        const seen = new Set();
        period.screenshot.validators = period.screenshot.validators.filter((v) => {
            const key = String(v.name || '').trim().toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        period.markModified('screenshot.validators');
        await period.save();
    }
};

validatorController.giveValidatorToExcel = async (name, periodId = null) => {
    try {
        const { validatorName: requestedValidatorName, columnName: requestedColumnName } = splitValidateWithReference(name);

        // Usar el validador con más filas de datos (global vs snapshot de periodo)
        const countValidatorRows = (v) => {
            if (!v) return 0;
            const cols = v.columns || [];
            return cols.length > 0 ? Math.max(...cols.map(c => (c.values || []).length)) : 0;
        };

        const findBestValidator = async (lookupName) => {
            if (!lookupName) return null;
            const [globalValidator, periodValidator] = await Promise.all([
                findGlobalValidatorByName(lookupName),
                hasPeriodId(periodId)
                    ? validatorController.findValidatorByName(lookupName, periodId)
                    : Promise.resolve(null),
            ]);
            if (!globalValidator && !periodValidator) return null;
            if (!globalValidator) return periodValidator;
            if (!periodValidator) return globalValidator;
            // Preferir el que tenga más filas (más completo/actualizado)
            return countValidatorRows(periodValidator) > countValidatorRows(globalValidator)
                ? periodValidator
                : globalValidator;
        };

        let validator = await findBestValidator(requestedValidatorName);
        if (!validator && requestedColumnName) {
            validator = await findBestValidator(requestedColumnName);
        }

        if (!validator) {
            return;
        }

        // Asegúrate de inicializar acc como un array de objetos vacíos
        const columnToValidate = findValidatorColumn(validator, requestedColumnName);
        const validatorFilled = {}

        validatorFilled['name'] = validator.name || requestedValidatorName
        validatorFilled['columns'] = (validator.columns || []).map((column) => ({
            name: column.name,
            is_validator: columnToValidate
                ? normalizeValidatorLookup(column.name) === normalizeValidatorLookup(columnToValidate.name)
                : Boolean(column.is_validator),
            type: column.type,
        }));
        
        validatorFilled['values'] = validator.columns.reduce((acc, item) => {
            const displayValues = getValidatorDisplayValuesForColumn(validator.columns || [], item);
            const maxLength = Math.max(item.values?.length || 0, displayValues.length);
            for (let index = 0; index < maxLength; index += 1) {
                // Inicializar el objeto si no existe
                if (!acc[index]) {
                    acc[index] = {};
                }
                const displayValue = displayValues[index];
                const rawValue = item.values?.[index];
                acc[index][item.name] = displayValue !== undefined && displayValue !== ''
                    ? displayValue
                    : validatorValueToPlain(rawValue);
            }
            return acc;
        }, []);

        return validatorFilled;

    } catch (error) {
        console.log(error);
        return;
    }
}

validatorController.getAllValidators = async (req, res) => {
    try {
      const { periodId } = req.query;
      const validators = hasPeriodId(periodId)
        ? await validatorController.listValidatorsByPeriod(periodId)
        : await Validator.find({});
      res.status(200).json({ validators });
    } catch (error) {
      res.status(error.statusCode || 500).json({ error: error.message });
    }
};

validatorController.getValidatorOptions = async (req, res) => {
    try {
        const { periodId } = req.query;
        const options = [
            {
                name: 'Funcionarios - Identificacion',
                type: 'Entero',
                validator_name: 'Funcionarios',
                column_name: 'Identificacion',
                columns: ['Identificacion'],
                preview_values: [],
            },
            {
                name: 'Estudiantes - Codigo',
                type: 'Texto Corto',
                validator_name: 'Estudiantes',
                column_name: 'Codigo',
                columns: ['Codigo'],
                preview_values: [],
            },
            {
                name: 'Estudiantes - Identificacion',
                type: 'Texto Corto',
                validator_name: 'Estudiantes',
                column_name: 'Identificacion',
                columns: ['Identificacion'],
                preview_values: [],
            },
            {
                name: 'Participantes - Identificacion',
                type: 'Texto Corto',
                validator_name: 'Participantes',
                column_name: 'Identificacion',
                columns: ['Identificacion'],
                preview_values: [],
            }
        ];

        // Combinar validadores del periodo Y globales (periodo tiene prioridad, sin duplicados)
        const seenValidatorNames = new Set();
        const allValidators = [];

        if (hasPeriodId(periodId) && mongoose.Types.ObjectId.isValid(String(periodId))) {
            const periodValidators = await validatorController.listValidatorsByPeriod(periodId);
            (periodValidators || []).filter(Boolean).forEach(v => {
                const key = String(v.name || '').trim().toLowerCase();
                if (key && !seenValidatorNames.has(key)) {
                    seenValidatorNames.add(key);
                    allValidators.push(v);
                }
            });
        }

        const globalValidators = await Validator.find({}, { name: 1, columns: 1 });
        (globalValidators || []).filter(Boolean).forEach(v => {
            const key = String(v.name || '').trim().toLowerCase();
            if (key && !seenValidatorNames.has(key)) {
                seenValidatorNames.add(key);
                allValidators.push(v);
            }
        });

        const dynamicOptions = allValidators.filter(Boolean).flatMap((validator) => {
            if (!validator.name || !Array.isArray(validator.columns)) return [];
            const validatorCols = validator.columns.filter((column) => column && column.is_validator);
            // Si ninguna columna está marcada como validadora, usar la primera columna disponible
            const colsToUse = validatorCols.length > 0 ? validatorCols : (validator.columns || []).slice(0, 1);
            return colsToUse.map((column) => ({
                name: column.name.trim().toLowerCase() === validator.name.trim().toLowerCase()
                    ? validator.name
                    : `${validator.name} - ${column.name}`,
                type: column.type,
                validator_name: validator.name,
                column_name: column.name,
                columns: (validator.columns || []).map((validatorColumn) => validatorColumn.name),
                preview_values: (column.values || [])
                    .map((value) => {
                        if (value === null || value === undefined) return '';
                        if (typeof value === 'object') {
                            if (value.value !== undefined) return String(value.value);
                            return JSON.stringify(value);
                        }
                        return String(value);
                    })
                    .filter(Boolean)
                    .slice(0, 8),
            }));
        });

        res.status(200).json({ options: [...options, ...dynamicOptions] });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

module.exports = validatorController
