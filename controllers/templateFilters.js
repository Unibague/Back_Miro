const TemplateFilter = require('../models/templateFilters');
const Student = require('../models/students');
const User = require('../models/users');
const Dependency = require('../models/dependencies');
const auditLogger = require('../services/auditLogger');

const templateFilterController = {};

// Obtener todos los filtros activos
templateFilterController.getActiveFilters = async (req, res) => {
  try {
    const filters = await TemplateFilter.find({ isActive: true }).sort({ order: 1 });
    
    // Enriquecer filtros con opciones dinámicas
    const enrichedFilters = await Promise.all(filters.map(async (filter) => {
      const filterObj = filter.toObject();
      
      if (filter.source !== 'custom') {
        filterObj.options = await getFilterOptions(filter.source, filter.sourceField);
      } else {
        filterObj.options = filter.customOptions;
      }
      
      return filterObj;
    }));
    
    res.status(200).json(enrichedFilters);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Obtener opciones de subfiltro
templateFilterController.getSubfilterOptions = async (req, res) => {
  try {
    const { filterName, parentValue } = req.query;
    
    const filter = await TemplateFilter.findOne({ name: filterName, hasSubfilter: true });
    if (!filter) {
      return res.status(404).json({ error: 'Filter not found' });
    }
    
    let options = [];
    
    if (filter.subfilterConfig.source === 'dependencies' && parentValue) {
      // Si el filtro padre es dependencia, obtener subdependencias o usuarios
      if (filter.subfilterConfig.sourceField === 'subdependencies') {
        options = await Dependency.find({ dep_father: parentValue }, 'name dep_code');
      } else if (filter.subfilterConfig.sourceField === 'members') {
        const dependency = await Dependency.findOne({ dep_code: parentValue });
        if (dependency) {
          const users = await User.find({ email: { $in: dependency.members } }, 'full_name email');
          options = users.map(u => ({ value: u.email, label: u.full_name }));
        }
      }
    }
    
    res.status(200).json(options);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// CRUD para administradores
templateFilterController.getAllFilters = async (req, res) => {
  try {
    const { page = 1, limit = 10, search = '' } = req.query;
    const skip = (page - 1) * limit;
    
    const query = search ? {
      $or: [
        { name: { $regex: search, $options: 'i' } },
        { label: { $regex: search, $options: 'i' } }
      ]
    } : {};
    
    const filters = await TemplateFilter.find(query)
      .sort({ order: 1 })
      .skip(skip)
      .limit(parseInt(limit));
      
    const total = await TemplateFilter.countDocuments(query);
    
    res.status(200).json({
      filters,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / limit)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

templateFilterController.createFilter = async (req, res) => {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const filter = new TemplateFilter(req.body);
    await filter.save();
    
    // Audit log
    await auditLogger.logCreate(req, user, 'templateFilter', {
      filterId: filter._id,
      filterName: filter.name
    });
    
    res.status(201).json({ status: 'Filter created', filter });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

templateFilterController.updateFilter = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const filter = await TemplateFilter.findByIdAndUpdate(id, req.body, { new: true });
    if (!filter) {
      return res.status(404).json({ error: 'Filter not found' });
    }
    
    // Audit log
    await auditLogger.logUpdate(req, user, 'templateFilter', {
      filterId: id,
      filterName: filter.name
    });
    
    res.status(200).json({ status: 'Filter updated', filter });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

templateFilterController.deleteFilter = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const filter = await TemplateFilter.findByIdAndDelete(id);
    if (!filter) {
      return res.status(404).json({ error: 'Filter not found' });
    }
    
    // Audit log
    await auditLogger.logDelete(req, user, 'templateFilter', {
      filterId: id,
      filterName: filter.name
    });
    
    res.status(200).json({ status: 'Filter deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Función auxiliar para obtener opciones dinámicas
async function getFilterOptions(source, sourceField) {
  try {
    switch (source) {
      case 'estudiantes':
        if (sourceField === 'codigo_programa') {
          const programs = await Student.distinct('codigo_programa');
          return programs.map(p => ({ value: p, label: p }));
        }
        break;
        
      case 'funcionarios':
        if (sourceField === 'dependencia') {
          const dependencies = await User.distinct('dep_code');
          const deps = await Dependency.find({ dep_code: { $in: dependencies } }, 'name dep_code');
          return deps.map(d => ({ value: d.dep_code, label: d.name }));
        }
        break;
        
      case 'dependencies':
        const dependencies = await Dependency.find({}, 'name dep_code');
        return dependencies.map(d => ({ value: d.dep_code, label: d.name }));
        
      default:
        return [];
    }
  } catch (error) {
    console.error('Error getting filter options:', error);
    return [];
  }
}

module.exports = templateFilterController;