const Dimension = require('../models/dimensions');
const Dependency = require('../models/dependencies');
const AuditLogger = require('../services/auditLogger');
const User = require('../models/users');

const dimensionController = {};

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
    const dimension = await Dimension.findById(id);
    if (!dimension) {
      return res.status(404).json({ error: "Dimension not found" });
    }

    const producers = await Dependency.find({ dep_code: { $in: dimension.producers } });

    res.status(200).json(producers);
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
