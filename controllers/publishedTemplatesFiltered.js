const PublishedTemplate = require('../models/publishedTemplates');
const Template = require('../models/templates');
const User = require('../models/users');
const Dependency = require('../models/dependencies');
const Student = require('../models/students');
const TemplateFilter = require('../models/templateFilters');
const auditLogger = require('../services/auditLogger');

const filteredController = {};

// Obtener TODAS las plantillas publicadas para filtrar
filteredController.getAllPublishedTemplates = async (req, res) => {
  try {
    const { email, periodId } = req.query;
    
    const user = await User.findOne({ email });
    if (!user || user.activeRole !== 'Administrador') {
      return res.status(403).json({ error: 'Access denied' });
    }

    const query = periodId ? { period: periodId } : {};
    
    const templates = await PublishedTemplate.find(query)
      .populate('period', 'name')
      .populate({
        path: 'template',
        populate: {
          path: 'dimensions',
          model: 'dimensions',
          populate: {
            path: 'responsible',
            model: 'dependencies',
            select: 'name dep_code'
          }
        }
      })
      .lean();

    // Audit log
    await auditLogger.logRead(req, user, 'publishedTemplatesFiltered', {
      action: 'getAllPublishedTemplates',
      periodId: periodId,
      totalTemplates: templates.length
    });

    res.status(200).json({
      templates,
      total: templates.length,
      message: 'All published templates retrieved successfully'
    });
  } catch (error) {
    console.error('Error getting all published templates:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Obtener campos disponibles para filtrar
filteredController.getAvailableFields = async (req, res) => {
  try {
    const { periodId } = req.query;
    
    const query = periodId ? { period: periodId } : {};
    const templates = await PublishedTemplate.find(query, 'template.fields loaded_data');
    
    const fieldNames = new Set();
    const fieldValues = {};
    
    templates.forEach(template => {
      if (template.template && template.template.fields) {
        template.template.fields.forEach(field => {
          fieldNames.add(field.name);
          
          // Recopilar valores únicos de loaded_data
          if (!fieldValues[field.name]) {
            fieldValues[field.name] = new Set();
          }
          
          template.loaded_data.forEach(loadedData => {
            loadedData.filled_data.forEach(filledField => {
              if (filledField.field_name === field.name) {
                filledField.values.forEach(value => {
                  if (value && value !== '') {
                    fieldValues[field.name].add(value.toString());
                  }
                });
              }
            });
          });
        });
      }
    });
    
    // Convertir Sets a arrays y limitar valores
    const result = Array.from(fieldNames).map(fieldName => ({
      name: fieldName,
      label: fieldName.replace(/_/g, ' ').toUpperCase(),
      values: Array.from(fieldValues[fieldName] || []).slice(0, 100) // Limitar a 100 valores
    }));
    
    res.status(200).json(result);
  } catch (error) {
    console.error('Error getting available fields:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Endpoint principal con filtros dinámicos
filteredController.getFilteredPublishedTemplates = async (req, res) => {
  const { email, page = 1, limit = 10, search = '', periodId, dependency, field, fieldValue } = req.query;
  const skip = (page - 1) * limit;

  try {
    const user = await User.findOne({ email });
    if (!user || user.activeRole !== 'Administrador') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Query base
    let query = {
      name: { $regex: search, $options: 'i' },
      ...(periodId && { period: periodId })
    };

    // Filtro por dependencia
    if (dependency) {
      query['loaded_data.dependency'] = dependency;
    }

    // Filtro por campo específico y valor
    if (field && fieldValue) {
      query['loaded_data.filled_data'] = {
        $elemMatch: {
          field_name: field,
          values: { $in: [fieldValue] }
        }
      };
    }

    const templates = await PublishedTemplate.find(query)
      .skip(skip)
      .limit(parseInt(limit))
      .populate('period')
      .populate({
        path: 'template',
        populate: {
          path: 'dimensions',
          model: 'dimensions'
        }
      });

    const total = await PublishedTemplate.countDocuments(query);

    // Audit log
    await auditLogger.logRead(req, user, 'publishedTemplatesFiltered', {
      action: 'getFilteredPublishedTemplates',
      appliedFilters: { dependency, field, fieldValue },
      totalResults: total,
      page: parseInt(page)
    });

    res.status(200).json({
      templates,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit),
      appliedFilters: { dependency, field, fieldValue }
    });
  } catch (error) {
    console.error('Error fetching filtered templates:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Obtener valores únicos de un campo específico
filteredController.getFieldValues = async (req, res) => {
  try {
    const { field, periodId, dependency } = req.query;
    
    if (!field) {
      return res.status(400).json({ error: 'Field parameter is required' });
    }
    
    let query = {};
    if (periodId) query.period = periodId;
    if (dependency) query['loaded_data.dependency'] = dependency;
    
    const templates = await PublishedTemplate.find(query, 'loaded_data');
    
    const values = new Set();
    
    templates.forEach(template => {
      template.loaded_data.forEach(loadedData => {
        if (!dependency || loadedData.dependency === dependency) {
          loadedData.filled_data.forEach(filledField => {
            if (filledField.field_name === field) {
              filledField.values.forEach(value => {
                if (value && value !== '') {
                  values.add(value.toString());
                }
              });
            }
          });
        }
      });
    });
    
    res.status(200).json(Array.from(values).sort());
  } catch (error) {
    console.error('Error getting field values:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Obtener dependencias que tienen datos
filteredController.getAvailableDependencies = async (req, res) => {
  try {
    const { periodId } = req.query;
    
    const query = periodId ? { period: periodId } : {};
    const templates = await PublishedTemplate.find(query, 'loaded_data');
    
    const dependencyCodes = new Set();
    templates.forEach(template => {
      template.loaded_data.forEach(loadedData => {
        dependencyCodes.add(loadedData.dependency);
      });
    });
    
    const dependencies = await Dependency.find(
      { dep_code: { $in: Array.from(dependencyCodes) } },
      'name dep_code'
    );
    
    res.status(200).json(dependencies);
  } catch (error) {
    console.error('Error getting available dependencies:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Función para aplicar filtros dinámicos
async function applyDynamicFilters(filters) {
  let templateIds = null;

  for (const [filterName, filterValue] of Object.entries(filters)) {
    if (!filterValue) continue;

    const filterConfig = await TemplateFilter.findOne({ name: filterName, isActive: true });
    if (!filterConfig) continue;

    let filteredIds = [];

    switch (filterConfig.source) {
      case 'estudiantes':
        if (filterConfig.sourceField === 'codigo_programa') {
          const students = await Student.find({ codigo_programa: filterValue }, 'code_student');
          // Buscar plantillas que contengan estos códigos de estudiante
          const studentCodes = students.map(s => s.code_student);
          filteredIds = await findTemplatesByStudentCodes(studentCodes);
        }
        break;

      case 'funcionarios':
        if (filterConfig.sourceField === 'dependencia') {
          const users = await User.find({ dep_code: filterValue }, 'identification');
          // Buscar plantillas que contengan estas identificaciones
          const identifications = users.map(u => u.identification);
          filteredIds = await findTemplatesByUserIdentifications(identifications);
        }
        break;

      case 'dependencies':
        // Buscar plantillas asignadas a esta dependencia
        const dependency = await Dependency.findOne({ dep_code: filterValue });
        if (dependency) {
          const templates = await Template.find({ producers: dependency._id }, '_id');
          const publishedTemplates = await PublishedTemplate.find({
            'template._id': { $in: templates.map(t => t._id) }
          }, 'template._id');
          filteredIds = publishedTemplates.map(pt => pt.template._id);
        }
        break;
    }

    // Intersección de resultados si ya hay filtros aplicados
    if (templateIds === null) {
      templateIds = filteredIds;
    } else {
      templateIds = templateIds.filter(id => filteredIds.includes(id));
    }
  }

  return { templateIds };
}

// Funciones auxiliares para buscar en datos de plantillas
async function findTemplatesByStudentCodes(studentCodes) {
  // Buscar en loaded_data de PublishedTemplates
  const publishedTemplates = await PublishedTemplate.find({
    'loaded_data.filled_data': {
      $elemMatch: {
        'values': { $in: studentCodes }
      }
    }
  }, 'template._id');
  
  return publishedTemplates.map(pt => pt.template._id);
}

async function findTemplatesByUserIdentifications(identifications) {
  // Buscar en loaded_data de PublishedTemplate
  const publishedTemplates = await PublishedTemplate.find({
    'loaded_data.filled_data': {
      $elemMatch: {
        'values': { $in: identifications }
      }
    }
  }, 'template._id');
  
  return publishedTemplates.map(pt => pt.template._id);
}

module.exports = filteredController;