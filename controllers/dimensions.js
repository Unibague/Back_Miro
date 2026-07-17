const Dimension = require('../models/dimensions');
const Dependency = require('../models/dependencies');
const AuditLogger = require('../services/auditLogger');
const User = require('../models/users');
const Template = require('../models/templates');
const PublishedTemplate = require('../models/publishedTemplates');
const Report = require('../models/reports');

const dimensionController = {};

const isBlankValue = (value) => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return Number.isNaN(value);
  const raw = value && typeof value === 'object' && 'text' in value ? value.text : value;
  const normalized = String(raw ?? '').trim().toLowerCase();
  return normalized === '' || normalized === 'null' || normalized === 'nan';
};

// Cuenta cuantos registros (filas) reporto una dependencia en un envio: el
// maximo de valores no vacios entre todos sus campos, igual criterio que usa
// el resto del sistema para saber si un envio "tiene informacion" o no.
const countRecordsInLoadedEntry = (entry) => {
  const filled = Array.isArray(entry?.filled_data) ? entry.filled_data : [];
  return filled.reduce((max, field) => {
    const meaningful = Array.isArray(field?.values)
      ? field.values.filter((value) => !isBlankValue(value)).length
      : 0;
    return Math.max(max, meaningful);
  }, 0);
};

// Estadisticas por ambito para el Tablero: no cuenta "cuantos enviaron" sino
// el volumen real de informacion reportada (numero de registros) en las
// plantillas de cada ambito, ademas de cuantas plantillas/informes tiene
// asignados. Se calcula para todos los ambitos en una sola pasada para no
// pagar N consultas por ambito.
dimensionController.getTableroStats = async (req, res) => {
  const periodId = req.query.periodId || null;

  try {
    const [dimensions, templates, reports] = await Promise.all([
      Dimension.find().select('_id name').lean(),
      Template.find().select('_id dimensions').lean(),
      Report.find().select('_id dimensions').lean(),
    ]);

    const templateIdsByDimension = new Map();
    templates.forEach((template) => {
      (template.dimensions || []).forEach((dimId) => {
        const key = String(dimId);
        if (!templateIdsByDimension.has(key)) templateIdsByDimension.set(key, []);
        templateIdsByDimension.get(key).push(String(template._id));
      });
    });

    const reportsCountByDimension = new Map();
    reports.forEach((report) => {
      (report.dimensions || []).forEach((dimId) => {
        const key = String(dimId);
        reportsCountByDimension.set(key, (reportsCountByDimension.get(key) || 0) + 1);
      });
    });

    const publishedQuery = periodId ? { period: periodId } : {};
    const publishedTemplates = await PublishedTemplate.find(publishedQuery)
      .select('template._id loaded_data')
      .lean();

    const recordsByTemplateId = new Map();
    const dependenciesByTemplateId = new Map();
    publishedTemplates.forEach((published) => {
      const templateId = String(published.template?._id || '');
      if (!templateId) return;

      let totalRecords = 0;
      const dependencies = new Set();
      (published.loaded_data || []).forEach((entry) => {
        const recordCount = countRecordsInLoadedEntry(entry);
        if (recordCount > 0) {
          totalRecords += recordCount;
          if (entry.dependency) dependencies.add(entry.dependency);
        }
      });

      recordsByTemplateId.set(templateId, (recordsByTemplateId.get(templateId) || 0) + totalRecords);
      const existingDeps = dependenciesByTemplateId.get(templateId) || new Set();
      dependencies.forEach((dep) => existingDeps.add(dep));
      dependenciesByTemplateId.set(templateId, existingDeps);
    });

    const stats = dimensions.map((dimension) => {
      const dimId = String(dimension._id);
      const templateIds = templateIdsByDimension.get(dimId) || [];
      const totalRegistrosReportados = templateIds.reduce(
        (sum, templateId) => sum + (recordsByTemplateId.get(templateId) || 0),
        0
      );
      const dependenciasQueReportaron = new Set();
      templateIds.forEach((templateId) => {
        (dependenciesByTemplateId.get(templateId) || new Set()).forEach((dep) => dependenciasQueReportaron.add(dep));
      });

      return {
        _id: dimension._id,
        name: dimension.name,
        totalPlantillas: templateIds.length,
        totalInformes: reportsCountByDimension.get(dimId) || 0,
        totalRegistrosReportados,
        totalDependenciasReportando: dependenciasQueReportaron.size,
      };
    });

    res.status(200).json({ stats });
  } catch (error) {
    console.error('Error building tablero stats:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

dimensionController.getDimensions = async (req, res) => {
  const dimensions = await Dimension.find();
  res.status(200).json(dimensions);
}

dimensionController.getDimensionsPagination = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || '';
  const email = req.query.email;
  const skip = (page - 1) * limit;

  try {
    let query = {};
    
    // Si hay email, filtrar por dimensiones donde el usuario es visualizer
    if (email) {
      
      // Buscar el usuario
      const user = await User.findOne({ email, isActive: true });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Si es administrador, mostrar todas las dimensiones
      if (user.activeRole === 'Administrador') {
        // No agregar filtro, mostrar todas
      } else {
        // Buscar las dependencias donde el usuario es visualizer
        const leaderDependencies = await Dependency.find({ 
          visualizers: { $in: [email] }
        });
        
        if (leaderDependencies.length === 0) {
          return res.status(200).json({
            dimensions: [],
            total: 0,
            page,
            pages: 0
          });
        }

        const dependencyIds = leaderDependencies.map(dep => dep._id);
        
        // Filtrar dimensiones por dependencias del usuario
        query.responsible = { $in: dependencyIds };
      }
    }
    
    // Agregar filtro de búsqueda si existe
    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }
    
    const dimensions = await Dimension
      .find(query)
      .populate('responsible')
      .populate('producers')
      .skip(skip)
      .limit(limit);
    const total = await Dimension.countDocuments(query);

    res.status(200).json({
      dimensions,
      total,
      page,
      pages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching dimensions:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

dimensionController.getDimensionsByResponsible = async (req, res) => {
  const email = req.query.email;
  try {
    const User = require('../models/users');
    
    // Buscar el usuario
    const user = await User.findOne({ email, isActive: true });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Buscar las dependencias donde el usuario es visualizer
    const leaderDependencies = await Dependency.find({ 
      visualizers: { $in: [email] }
    });
    
    if (leaderDependencies.length === 0) {
      return res.status(200).json([]);
    }

    const dependencyIds = leaderDependencies.map(dep => dep._id);

    // Buscar dimensiones donde las dependencias del líder son responsables
    const dimensions = await Dimension.find({
      responsible: { $in: dependencyIds }
    }).populate('responsible');

    res.status(200).json(dimensions);
  } catch (error) {
    console.error('Error fetching dimensions by responsible:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

dimensionController.createDimension = async (req, res) => {
  try {
    const name = req.body.name;
    const nameLowerCase = req.body.name.toLowerCase();
    const existingDimension = await Dimension.findOne({ name: { $regex: new RegExp(`^${nameLowerCase}$`, 'i') } });
    
    if (existingDimension) {
      return res.status(400).json({ error: "La dimensión con ese nombre ya existe" });
    }

    const dimension = new Dimension({
      ...req.body,
      name: name
    });

    await dimension.save();
    
    // Registrar en auditoría (non-blocking)
    try {
      const userEmail = req.body.userEmail || req.query.email || req.headers['user-email'];
      console.log('🔍 Attempting audit log for dimension creation, userEmail:', userEmail);
      if (userEmail) {
        const user = await User.findOne({ email: userEmail });
        console.log('🔍 User found for audit:', user ? 'YES' : 'NO');
        if (user) {
          const dependency = await Dependency.findById(dimension.responsible);
          console.log('🔍 Dependency found:', dependency?.name);
          await AuditLogger.logCreate(req, user, 'dimension', {
            dimensionId: dimension._id.toString(),
            dimensionName: dimension.name,
            responsibleDependency: dependency?.name || 'dependencia desconocida'
          });
          console.log('✅ Audit log created successfully for dimension');
        }
      } else {
        console.log('⚠️ No userEmail found for audit logging');
      }
    } catch (auditError) {
      console.error('❌ Audit logging failed:', auditError);
    }
    
    res.status(200).json({ status: "Dimension created" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

dimensionController.updateDimension = async (req, res) => {
  const { id } = req.params;
  const dimensionData = req.body;

  try {
    // Encuentra la dimensión por su ID
    let dimension = await Dimension.findById(id);
    if (!dimension) {
      return res.status(404).json({ error: "Dimension not found" });
    }

    // Asigna las nuevas propiedades al documento
    Object.assign(dimension, dimensionData);

    // Guarda el documento actualizado
    await dimension.save();

    res.status(200).json({ dimension });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

dimensionController.deleteDimension = async (req, res) => {
  const { id } = req.params;

  try {
    const dimension = await Dimension.findById(id).populate('responsible');
    if (!dimension) {
      return res.status(404).json({ error: "Dimension not found" });
    }
    
    const dimensionName = dimension.name;
    const dependencyName = dimension.responsible?.name || 'dependencia desconocida';
    
    await Dimension.findByIdAndDelete(id);
    
    // Registrar en auditoría (non-blocking)
    try {
      const userEmail = req.body.userEmail || req.query.email || req.headers['user-email'];
      console.log('🔍 Attempting audit log for dimension deletion, userEmail:', userEmail);
      if (userEmail) {
        const user = await User.findOne({ email: userEmail });
        console.log('🔍 User found for audit:', user ? 'YES' : 'NO');
        if (user) {
          await AuditLogger.logDelete(req, user, 'dimension', {
            dimensionId: id,
            dimensionName: dimensionName,
            responsibleDependency: dependencyName
          });
          console.log('✅ Audit log created successfully for dimension deletion');
        }
      } else {
        console.log('⚠️ No userEmail found for audit logging');
      }
    } catch (auditError) {
      console.error('❌ Audit logging failed:', auditError);
    }
    
    res.status(200).json({ status: "Dimension deleted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

dimensionController.getProducers = async (req, res) => {
  const { id } = req.params;

  try {
    const dimension = await Dimension.findById(id).populate('producers');
    if (!dimension) {
      return res.status(404).json({ error: "Dimension not found" });
    }

    res.status(200).json(dimension.producers || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

dimensionController.getDimensionsByUser = async (req, res) => {
  const { email } = req.params;

  try {
    const user = await User.findOne({ email, isActive: true });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let dimensions;

    if (user.activeRole === 'Administrador') {
      dimensions = await Dimension.find({}, '_id name');
    } else {
      const userDependencies = await Dependency.find({
        visualizers: { $in: [email] }
      });

      if (userDependencies.length === 0) {
        return res.status(200).json([]);
      }

      const dependencyIds = userDependencies.map(dep => dep._id);
      dimensions = await Dimension.find(
        { responsible: { $in: dependencyIds } },
        '_id name'
      );
    }

    res.status(200).json(dimensions);
  } catch (error) {
    console.error('Error fetching dimensions by user:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

dimensionController.getDimensionById = async (req, res) => {
  const { id } = req.params;

  try {
    const dimension = await Dimension.findById(id);
    if (!dimension) {
      return res.status(404).json({ error: "Dimension not found" });
    }
    res.status(200).json(dimension);
  } catch (error) {
    console.error('Error fetching dimension by id:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = dimensionController;
