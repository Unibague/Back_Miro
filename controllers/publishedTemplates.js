const PublishedTemplate = require('../models/publishedTemplates.js');
const Template = require('../models/templates.js')
const Period = require('../models/periods.js')
const Dimension = require('../models/dimensions.js')
const Dependency = require('../models/dependencies.js')
const User = require('../models/users.js')
const Validator = require('./validators.js');
const ValidatorModel = require('../models/validators');
const Log = require('../models/logs');
const UserService = require('../services/users.js');
const Category = require('../models/categories.js');  
const ExcelJS = require("exceljs");
const auditLogger = require('../services/auditLogger');

const publTempController = {};

// Función para convertir hipervínculos de Excel a texto
const convertHyperlinkToText = (value) => {
  if (value && typeof value === 'object') {
    // Si es un array, tomar el primer elemento o convertir a string
    if (Array.isArray(value)) {
      return value.length > 0 ? String(value[0]) : '';
    }
    
    // Si es un hipervínculo de Excel
    if (value.hyperlink || value.text) {
      return value.text || value.hyperlink || String(value);
    }
    // Si es un objeto MongoDB
    if ('$numberInt' in value || '$numberDouble' in value) {
      return value.$numberInt || value.$numberDouble;
    }
    // Si tiene propiedades como richText, formula, etc. (objetos de Excel)
    if (value.richText) {
      return value.richText.map(rt => rt.text || '').join('');
    }
    if (value.formula) {
      return value.result || value.formula;
    }
    if (value.result !== undefined) {
      return value.result;
    }
    // Si es un objeto con valor directo
    if (value.value !== undefined) {
      return value.value;
    }
    // Intentar extraer cualquier propiedad que parezca texto
    const possibleTextProps = ['text', 'value', 'result', 'displayText', 'content'];
    for (const prop of possibleTextProps) {
      if (value[prop] !== undefined) {
        return value[prop];
      }
    }
    // Si es otro tipo de objeto, convertir a string
    return String(value);
  }
  return value ?? '';
};

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

    const user = await UserService.findUserByEmailAndRole(email, 'Administrador')

    const category = template.category;  
    const sequence = template.sequence;  

    const newPublTemp = new PublishedTemplate({
      name: req.body.name || template.name,
      published_by: user,
      template: template,
      period: req.body.period_id,
      deadline: req.body.deadline,
      published_date: datetime_now(),
      category: category,  
      sequence: sequence   
    })

    await newPublTemp.save()

    return res.status(201).json({ status: 'Template published successfully' })
  } catch (error) {
    return res.status(500).json({ status: error.message })
  }
}


publTempController.getPublishedTemplatesDimension = async (req, res) => {
  const email = req.query.email;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || '';
  const periodId = req.query.periodId || null;
  const skip = (page - 1) * limit;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ status: 'User not found' });
    }

    const dimensions = await Dimension.find().populate({
      path: 'responsible',
      match: { responsible: email }
    }).then(dimensions => dimensions.filter(dim => dim.responsible));

    const activeRole = user.activeRole;

    let query = {
      name: { $regex: search, $options: 'i' },
      ...(periodId && { period: periodId }),
    };
    
    if (activeRole !== 'Administrador') {
      const dimensionIds = dimensions.map(dim => dim._id);
      if (dimensionIds.length > 0) {
        query['template.dimensions'] = { $in: dimensionIds };
      } else {
        return res.status(403).json({ status: 'Access denied' });
      }
    }

    const published_templates = await PublishedTemplate.find(query)
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
      const validators = await Promise.all(
        template.template.fields.map(async (field) => {
          return Validator.giveValidatorToExcel(field.validate_with);
        })
      );

      template = template.toObject();
      validatorsFiltered = validators.filter(v => v !== undefined)
      template.validators = validatorsFiltered // Añadir validators al objeto

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
      
      const validators = await Promise.all(
        t.template.fields.map(async (field) => {
          return Validator.giveValidatorToExcel(field.validate_with);
        })
      );

      t = t.toObject();
      validatorsFiltered = validators.filter(v => v !== undefined)
      t.validators = validatorsFiltered // Añadir validators al objeto
  
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
              acc[index][item.field_name] = convertHyperlinkToText(value);
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

    await workbook.xlsx.write(res);
    

  } catch (error) {
    console.error("Error al exportar pendientes:", error);
    res.status(500).json({ message: error.message || "Error interno al exportar pendientes." });
  }

}

publTempController.loadProducerData = async (req, res) => {
  const { email, pubTem_id, data, edit } = req.body;



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

    const now = new Date(datetime_now().toDateString());
    const endDate = new Date(pubTem.deadline).toDateString();
    if (endDate < now) {
      return res.status(403).json({ status: 'The period is closed' });
    }

    // Verificar si el usuario puede enviar datos desde alguna de sus dependencias
    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
    const userDependencies = await Dependency.find({ dep_code: { $in: allUserDependencies } });
    const userDependencyIds = userDependencies.map(dep => dep._id.toString());
    
    const canSubmit = pubTem.template?.producers.some(p => userDependencyIds.includes(p._id.toString()));
    if (!canSubmit) {
      return res.status(403).json({ status: 'User is not assigned to this published template' });
    }

    if (!pubTem.published_date) {
      pubTem.published_date = datetime_now();
    }

    // VALIDACIÓN PREVIA: Verificar que las columnas del Excel coincidan
    if (data && data.length > 0) {
      const excelColumns = Object.keys(data[0]);
      const templateColumns = pubTem.template.fields.map(f => f.name);
      
      // Solo considerar como faltantes las columnas que son obligatorias (required = true)
      const missingColumns = pubTem.template.fields
        .filter(field => field.required && !excelColumns.includes(field.name))
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
    if (typeof val === 'string' && val.trim() === 'null') {
      val = null;
    }
    
    // Limpiar valores vacíos para campos no obligatorios
    if (!field.required && (val === null || val === undefined || (typeof val === 'string' && val.trim() === ''))) {
      val = null;
    }

if (field.multiple) {
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
        const [validatorName, columnName] = templateField.validate_with.split(" - ");
        const validator = await ValidatorModel.findOne({ name: validatorName });

        if (validator) {
          const validatorColumn = validator.columns.find(c => c.name === columnName);
          if (validatorColumn) {
            templateField.validator_values = validatorColumn.values;
            templateField.validator_type = validatorColumn.type;
          }
        }
      }

      templateField.values = field.values;

      const validationResult = await Validator.validateColumn(templateField);
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

    // Verificar si ya existe data para esta dependencia
    const existingDataIndex = pubTem.loaded_data.findIndex(d => d.dependency === user.dep_code);
    
    if (existingDataIndex > -1) {
      // Si ya existe, actualizar los datos existentes
      pubTem.loaded_data[existingDataIndex] = producersData;
    } else {
      // Si no existe, agregar nuevos datos
      pubTem.loaded_data.push(producersData);
    }

    await pubTem.save();

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
  const { pubTem_id, email } = req.query;

  user = await User.findOne({ email })

  if(!user || (!user.roles.includes('Responsable') && !user.roles.includes('Administrador'))) {
    return res.status(404).json({status: 'User not available'})
  }

  if (!pubTem_id) {
    return res.status(400).json({ status: 'Missing pubTem_id' });
  }

  try {
    const template = await PublishedTemplate.findById(pubTem_id);

    if (!template) {
      return res.status(404).json({ status: 'Published template not found' });
    }

    const dependencies = await Dependency.find({ dep_code: { $in: template.loaded_data.map(data => data.dependency) } });

    const depCodeToNameMap = dependencies.reduce((acc, dep) => {
      acc[dep.dep_code] = dep.name;
      return acc;
    }, {});

    const data = template.loaded_data.map(data => {

      // Detectar si no hay datos cargados
      if (!Array.isArray(data.filled_data) || data.filled_data.length === 0) {
  const emptyRow = {
    Dependencia: depCodeToNameMap[data.dependency] || data.dependency,
  };

  // Añadir todas las columnas vacías según template.fields
  template.template.fields.forEach(field => {
    emptyRow[field.name] = "";
  });

  return [emptyRow];
      }

      const filledData = data.filled_data.reduce((acc, item) => {
  item.values.forEach((value, index) => {
    if (!acc[index]) {
      acc[index] = { Dependencia: depCodeToNameMap[data.dependency] || data.dependency };
    }
    // Fix para datos existentes con '[object Object]'
    if (typeof value === 'string' && value === '[object Object]') {
      acc[index][item.field_name] = '';
    } else {
      acc[index][item.field_name] = convertHyperlinkToText(value) ?? "";
    }
  });
  return acc;
}, []);


       console.log('INFO CARGADA', filledData);
    
      return filledData;
    }).flat();

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
  const skip = (page - 1) * limit;

  try {
    console.log('=== DEBUG getUploadedTemplatesByProducer ===');
    console.log('Email:', email);
    console.log('FilterByDependency:', filterByDependency);
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
      name: { $regex: search, $options: 'i' }
    };
    
    if (periodId) {
      query.period = periodId;
    }

    const templates = await PublishedTemplate.find(query)
      .skip(skip)
      .limit(limit)
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

    const templatesWithValidators = await Promise.all(
      templatesWithData.map(async (template) => {
        const validators = await Promise.all(
          template.template.fields.map(async (field) => {
            return Validator.giveValidatorToExcel(field.validate_with);
          })
        );

        template = template.toObject();
        template.validators = validators.filter(v => v !== undefined);
        return template;
      })
    );

    // Contar total real después del filtrado
    const allTemplatesForCount = await PublishedTemplate.find(query);
    const totalWithData = allTemplatesForCount.filter(template => {
      return template.loaded_data.some(data => 
        dependenciesToQuery.includes(data.dependency) && 
        data.filled_data !== undefined
      );
    }).length;

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
  const { email, periodId, page = 1, limit = 10, search = '', filterByDependency = '' } = req.query;
  const skip = (page - 1) * limit;

  try {
    console.log('=== DEBUG getAvailableTemplatesToProductor ===');
    console.log('Email:', email);
    
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
    
    // Obtener IDs de las dependencias a consultar
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
    
    // Count total documents without pagination
    const total = await PublishedTemplate.countDocuments(query);
    console.log('Total templates found:', total);

    // Fetch templates with initial population
    const templates = await PublishedTemplate.find(query)
      .skip(skip)
      .limit(limit)
      .populate('period')
      .populate({
        path: 'template',
        populate: [
          { path: 'dimensions', model: 'dimensions' },
          { path: 'producers', model: 'dependencies' }
        ]
      }).lean();

    // Manually fetch categories
    const templatesWithCategories = await Promise.all(templates.map(async (template) => {
      // Find the category directly from the original template
      const originalTemplate = await Template.findById(template.template._id)
        .populate({
          path: 'category',
          model: 'categories',
          select: 'name templates' // Select specific fields if needed
        }).lean();
      
        // Find the sequence for this template within the category
        let sequence = null;
        if (originalTemplate.category) {
          const sequenceObj = originalTemplate.category.templates.find(
            t => t.templateId.toString() === template.template._id.toString()
          );
          sequence = sequenceObj ? sequenceObj.sequence : null;
        }
  
        return {
          ...template,
          template: {
            ...template.template,
            category: {
              ...originalTemplate.category,
              templateSequence: sequence
            }
          }
        };
      }));

      // Custom sorting logic
      const sortedTemplates = templatesWithCategories.sort((a, b) => {
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
        
        // If categories are the same, sort by sequence
        if (categoryComparison === 0) {
          // Handle cases where sequence might be null
          const seqA = a.template.category.templateSequence ?? Infinity;
          const seqB = b.template.category.templateSequence ?? Infinity;
          return seqA - seqB;
        }
        
        return categoryComparison;
      });

    // Paginate the sorted templates
    const paginatedTemplates = sortedTemplates.slice(skip, skip + limit);

    // Filter templates without loaded data for queried dependencies
    const filteredTemplates = paginatedTemplates.filter(
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
    
    console.log(`Templates after filtering: ${filteredTemplates.length} of ${paginatedTemplates.length}`);

    // Get validators for filtered templates
    const templatesWithValidators = await Promise.all(
      filteredTemplates.map(async (template) => {
        const validators = (
          await Promise.all(
            template.template.fields.map(async (field) => 
              Validator.giveValidatorToExcel(field.validate_with)
            )
          )
        ).filter(Boolean);

        return { ...template, validators };
      })
    );

    res.status(200).json({
      templates: templatesWithValidators,
      total,
      page: Number(page),
      pages: Math.ceil(total / limit),
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

    const fieldsWithValidatorIds = await Promise.all(publishedTemplate.template.fields.map(async (field) => {
      if (field.validate_with) {
        try {
          // Extraer el nombre del template y el nombre de la columna desde field.validate_with
          const [templateName, columnName] = field.validate_with.split(' - ');

          // Buscar en la base de datos por el templateName y luego encontrar la columna correspondiente
          const validator = await ValidatorModel.findOne({ name: templateName });
          
          if (validator) {
            // Encontrar la columna que es validadora
            const column = validator.columns.find(col => col.name === columnName && col.is_validator);
            
            if (column) {
              field.validate_with = {
                id: validator._id.toString(),
                name: `${validator.name} - ${column.name}`,
              };
            } else {
              console.error(`Validator column not found for: ${columnName}`);
            }
          } else {
            console.error(`Validator not found for template: ${templateName}`);
          }
        } catch (err) {
          console.error(`Error during ValidatorModel.findOne: ${err.message}`);
        }
      }
      return field;
    }));

    const response = {
      name: publishedTemplate.name,
      template: {
        ...publishedTemplate.template._doc,
        fields: fieldsWithValidatorIds,
      },
      publishedTemplate: publishedTemplate
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

    // Aplicar conversión de hipervínculos a los datos
    const processedData = producerData.filled_data.map(item => ({
      ...item,
      values: item.values.map(value => {
        // Fix para datos existentes con '[object Object]'
        if (typeof value === 'string' && value === '[object Object]') {
          return ''; // Convertir a string vacío
        }
        return convertHyperlinkToText(value);
      })
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
    const { email, templateIds, deadline } = req.body;

    console.log(req.body);


    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    for (const id of templateIds) {
      await PublishedTemplate.findByIdAndUpdate(id, { deadline });
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


module.exports = publTempController;
