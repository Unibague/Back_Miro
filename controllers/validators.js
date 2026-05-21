const { register } = require('module');
const User = require('../models/users')
const Validator = require('../models/validators');
const Period = require('../models/periods');
const Student = require('../models/students');
const { all } = require('../routes/users');
const auditLogger = require('../services/auditLogger');
const mongoose = require('mongoose');

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

const sameValidatorName = (a = '', b = '') => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

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

validatorController.findValidatorByName = async (name, periodId = null) => {
    const validatorName = String(name || '').trim();
    if (!validatorName) return null;

    if (hasPeriodId(periodId)) {
        if (!mongoose.Types.ObjectId.isValid(String(periodId))) return null;
        const period = await Period.findById(periodId).select('screenshot.validators');
        return toPlainValidator(findValidatorInPeriod(period, validatorName));
    }

    return Validator.findOne({ name: validatorName });
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

    const descriptionColumn = validator?.columns?.find((column) => {
        return column.name !== columnToValidate.name && isDescriptionColumn(column.name);
    });

    columnToValidate.values.forEach((value, index) => {
        const idText = normalizeComparableText(value);
        if (!idText) return;

        acceptedValues.add(idText);

        const descriptionValue = descriptionColumn?.values?.[index];
        const descriptionText = normalizeComparableText(descriptionValue);
        if (descriptionText) {
            acceptedValues.add(`${idText} - ${descriptionText}`);
        }
    });

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
        const options = [
          { name: 'Funcionarios - Identificación', type: 'Entero' }, 
          { name: 'Estudiantes - Código', type: 'Texto Corto' },
          { name: 'Estudiantes - Identificación', type: 'Texto Corto' },
          { name: 'Participantes - Identificación', type: 'Texto Corto' }
        ];

        const validators = await Validator.find({}, {name: 1, columns: 1});
        
        const result = validators.flatMap(validator => 
            validator.columns
                .filter(column => column.is_validator)
                .map(column => ({ name: `${validator.name} - ${column.name}`, type: column.type }))
        );

        options.push(...result)

        res.status(200).json({ options })
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message })
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
        
        // Intentar buscar por ObjectId primero
        if (period) {
            validator = findValidatorInPeriod(period, id);
        } else if (id.match(/^[0-9a-fA-F]{24}$/)) {
            validator = await Validator.findById(id);
        } else {
            // Si no es un ObjectId válido, buscar por nombre
            validator = await Validator.findOne({ name: id });
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
  const { name, datatype, validate_with, required, multiple } = column;
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
      if (validatorName !== validator.name) {
        // El validador se encontró por columnName, buscar la primera columna que sea validadora
        columnToValidate = validator.columns.find(column => column.is_validator);
        console.log('DEBUG - Buscando primera columna validadora:', columnToValidate ? columnToValidate.name : 'NO ENCONTRADA');
      } else {
        // Búsqueda normal por nombre de columna
        columnToValidate = validator.columns.find(column => column.name === columnName);
      }

      if (!columnToValidate) {
        return {
          status: false,
          errors: [{ register: null, message: `Columna '${columnName}' no encontrada en la tabla: ${validator.name}` }]
        };
      }

      validValuesSet = new Set(columnToValidate.values);
      acceptedStringValuesSet = buildAcceptedValidatorStringSet(validator, columnToValidate);
      console.log('DEBUG - Valores válidos para', validatorName, ':', Array.from(validValuesSet).slice(0, 10), '...');
    }
  }

  if (validValuesSet && !acceptedStringValuesSet) {
    acceptedStringValuesSet = new Set(
      Array.from(validValuesSet).map((item) => normalizeComparableText(item)).filter(Boolean)
    );
  }

  values.forEach((value, index) => {
const realIndex = index;

  const isEmpty = isBlankValue(value);



  // PRIMERO: Si el valor es vacío y no es requerido, saltar TODA validación
  if (!required && isEmpty) {
    return; // Saltar toda validación para campos no obligatorios vacíos
  }

  // SEGUNDO: Si es requerido y está vacío, error
  if (required && isEmpty) {
    result.status = false;
    result.errors.push({
      register: realIndex + 1,
      message: `Valor vacío encontrado en la columna ${name}, fila ${realIndex + 1}`,
      value: "Sin valor"
    });
    return;
  }

if (multiple && Array.isArray(value)) {
  value.forEach(val => {
    const validateFn = allowedDataTypes[datatype];
    if (typeof validateFn !== 'function') return;

    const validation = validateFn(val);
    if (!validation.isValid) {
      result.status = false;
      result.errors.push({
        register: realIndex + 1,
        message: `Valor inválido encontrado en la columna ${name}, fila ${realIndex + 1}: ${validation.message}`,
        value: val === null || val === undefined || val === '' ? "Sin valor" : (typeof val === 'object' ? JSON.stringify(val) : String(val))
      });
    }
  });
} else {
  // Solo validar tipo de dato si el campo es obligatorio O si tiene valor
  if (required || !isBlankValue(value)) {
    const validateFn = allowedDataTypes[datatype];
    if (typeof validateFn === 'function') {
      const validation = validateFn(value);
      if (!validation.isValid) {
        result.status = false;
        result.errors.push({
          register: realIndex + 1,
          message: `Valor inválido encontrado en la columna ${name}, fila ${realIndex + 1}: ${validation.message}`,
          value: value === null || value === undefined || value === '' ? "Sin valor" : (typeof value === 'object' ? JSON.stringify(value) : String(value))
        });
      }
    }
  }
}

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
        normalizedVal = isNaN(num) ? valueToNormalize : num;
      } else {
        normalizedVal = normalizeComparableText(valueToNormalize);
      }

      // 🚫 Si no está en el set, es inválido
      const isValidValue = validatorHasNumbers
        ? validValuesSet.has(normalizedVal)
        : acceptedStringValuesSet?.has(normalizedVal);
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
        normalizedVal = isNaN(num) ? valueToNormalize : num;
      } else {
        normalizedVal = normalizeComparableText(valueToNormalize);
      }
      
      console.log('DEBUG - Valor original:', value, 'Valor normalizado:', normalizedVal, 'Tipo validador:', validatorHasNumbers ? 'números' : 'strings');

      const isValidValue = validatorHasNumbers
        ? validValuesSet.has(normalizedVal)
        : acceptedStringValuesSet?.has(normalizedVal);
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

validatorController.createValidatorsFromDropdownOptions = async (fields, periodId) => {
    if (!hasPeriodId(periodId)) return;
    if (!mongoose.Types.ObjectId.isValid(String(periodId))) return;

    const period = await Period.findById(periodId);
    if (!period) return;

    if (!period.screenshot) period.screenshot = {};
    if (!Array.isArray(period.screenshot.validators)) period.screenshot.validators = [];

    // Elimina el sufijo " (N)" que agrega makeUnique en el frontend y quita guiones
    const sanitizeName = (name) =>
        String(name || '')
            .replace(/\s*\(\d+\)$/, '')
            .replace(/-/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

    const normalizeOptionKey = (value) => String(value || '')
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .toLowerCase();

    const existingValidatorsByName = new Map(
        period.screenshot.validators.map((v) => [sanitizeName(v.name).toLowerCase(), v])
    );

    let periodModified = false;

    for (const field of (fields || [])) {
        // Solo crear validadores para campos con validación de lista real en Excel
        const options = Array.isArray(field.excel_validation_options) && field.excel_validation_options.length > 0
            ? field.excel_validation_options
            : Array.isArray(field.dropdown_options) && field.dropdown_options.length > 0
                ? field.dropdown_options
                : null;
        if (!options) continue;
        if (field.validate_with && String(field.validate_with).trim() !== '') continue;

        const validatorName = sanitizeName(field.name);
        if (!validatorName) continue;

        const nameLower = validatorName.toLowerCase();
        const seenOptions = new Set();
        const cleanOptions = options
            .map((o) => String(o).trim())
            .filter((option) => {
                const key = normalizeOptionKey(option);
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
            const currentOptionKeys = new Set(validatorColumn.values.map(normalizeOptionKey));
            const missingOptions = cleanOptions.filter((option) => !currentOptionKeys.has(normalizeOptionKey(option)));

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
        const parts = String(name || '').split(' - ');
        const requestedValidatorName = (parts[0] || '').trim();
        const requestedColumnName = parts.slice(1).join(' - ').trim();
        let validator = await validatorController.findValidatorByName(requestedValidatorName, periodId);

        if (!validator && requestedColumnName) {
            validator = await validatorController.findValidatorByName(requestedColumnName, periodId);
        }

        if (!validator) {
            return;
        }

        // Asegúrate de inicializar acc como un array de objetos vacíos
        const validatorFilled = {}

        validatorFilled['name'] = requestedValidatorName || validator.name
        
        validatorFilled['values'] = validator.columns.reduce((acc, item) => {
            item.values.forEach((value, index) => {
                // Inicializar el objeto si no existe
                if (!acc[index]) {
                    acc[index] = {};
                }
                acc[index][item.name] = value.$numberInt || value;
            });
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

        const validators = hasPeriodId(periodId)
            ? await validatorController.listValidatorsByPeriod(periodId)
            : await Validator.find({}, { name: 1, columns: 1 });
        const dynamicOptions = validators.flatMap((validator) =>
            validator.columns
                .filter((column) => column.is_validator)
                .map((column) => ({
                    name: `${validator.name} - ${column.name}`,
                    type: column.type,
                    validator_name: validator.name,
                    column_name: column.name,
                    columns: validator.columns.map((validatorColumn) => validatorColumn.name),
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
                }))
        );

        res.status(200).json({ options: [...options, ...dynamicOptions] });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
};

module.exports = validatorController
