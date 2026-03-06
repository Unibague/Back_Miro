const PublishedTemplate = require('../models/publishedTemplates');
const User = require('../models/users');
const Dependency = require('../models/dependencies');
const xlsx = require('xlsx');

const templateStatusController = {};

// Obtener estado de plantillas: quién debe subir y si ya lo hizo
templateStatusController.getTemplateSubmissionStatus = async (req, res) => {
  try {
    const { periodId } = req.query;
    
    console.log('[TemplateStatus] periodId:', periodId);
    
    if (!periodId) {
      return res.status(400).json({ message: 'periodId is required' });
    }
    
    const query = { period: periodId };
    
    const publishedTemplates = await PublishedTemplate.find(query)
      .populate('period', 'name producer_end_date')
      .lean();
    
    console.log('[TemplateStatus] Plantillas encontradas:', publishedTemplates.length);
    
    if (!publishedTemplates || publishedTemplates.length === 0) {
      return res.status(200).json([]);
    }
    
    const result = [];
    
    for (const template of publishedTemplates) {
      console.log('[TemplateStatus] Procesando plantilla:', template.name);
      
      // Obtener dependencias asignadas
      const assignedDependencyIds = template.template?.producers || [];
      
      if (assignedDependencyIds.length === 0) continue;
      
      // Obtener nombres completos de las dependencias asignadas
      const dependencies = await Dependency.find({
        _id: { $in: assignedDependencyIds }
      }).select('dep_code name').lean();
      
      // Si tiene loaded_data, obtener también los nombres de esas dependencias
      const loadedDepCodes = template.loaded_data?.map(d => d.dependency) || [];
      const allDepCodes = [...new Set([...dependencies.map(d => d.dep_code), ...loadedDepCodes])];
      
      const allDependencies = await Dependency.find({
        dep_code: { $in: allDepCodes }
      }).select('dep_code name').lean();
      
      // Si tiene loaded_data, mostrar quién subió CON NOMBRE DE DEPENDENCIA
      if (template.loaded_data && template.loaded_data.length > 0) {
        for (const data of template.loaded_data) {
          const dep = allDependencies.find(d => d.dep_code === data.dependency);
          result.push({
            template_id: template._id,
            template_name: template.name,
            period: template.period?.name || 'N/A',
            deadline: template.deadline,
            user_name: data.send_by?.full_name || data.send_by?.name || 'N/A',
            user_email: data.send_by?.email || 'N/A',
            dependency: dep?.name || data.dependency,
            has_submitted: true,
            submitted_date: data.loaded_date
          });
        }
      }
      
      const depCodes = dependencies.map(d => d.dep_code);
      
      // Dependencias que ya subieron
      const submittedDepCodes = template.loaded_data?.map(d => d.dependency) || [];
      
      // Dependencias pendientes
      const pendingDepCodes = depCodes.filter(code => !submittedDepCodes.includes(code));
      
      console.log('[TemplateStatus] Pendientes:', pendingDepCodes);
      
      // Para cada dependencia pendiente, buscar TODOS los usuarios activos
      for (const depCode of pendingDepCodes) {
        console.log('[TemplateStatus] Buscando usuarios para dep_code:', depCode);
        
        const dep = allDependencies.find(d => d.dep_code === depCode);
        const depName = dep?.name || depCode;
        
        const users = await User.find({
          dependency: depCode,
          isActive: true,
          activeRole: 'Productor'
        }).select('name full_name email activeRole').lean();
        
        console.log('[TemplateStatus] Usuarios encontrados para', depCode, ':', users.length);
        
        if (users.length === 0) {
          result.push({
            template_id: template._id,
            template_name: template.name,
            period: template.period?.name || 'N/A',
            deadline: template.deadline,
            user_name: 'Sin permiso en la Dependencia',
            user_email: 'N/A',
            dependency: depName,
            has_submitted: false,
            submitted_date: null
          });
        } else {
          for (const user of users) {
            result.push({
              template_id: template._id,
              template_name: template.name,
              period: template.period?.name || 'N/A',
              deadline: template.deadline,
              user_name: user.full_name || user.name,
              user_email: user.email,
              dependency: depName,
              has_submitted: false,
              submitted_date: null
            });
          }
        }
      }
    }
    
    console.log('[TemplateStatus] Total resultados:', result.length);
    
    res.status(200).json(result);
  } catch (error) {
    console.error('[TemplateStatus] Error:', error);
    res.status(500).json({ message: 'Error getting template submission status', error: error.message });
  }
};

// Descargar reporte en Excel
templateStatusController.downloadTemplateSubmissionStatus = async (req, res) => {
  try {
    const { periodId } = req.query;
    
    const query = periodId ? { period: periodId } : {};
    
    const publishedTemplates = await PublishedTemplate.find(query)
      .populate('period', 'name producer_end_date')
      .lean();
    
    const data = [];
    
    for (const template of publishedTemplates) {
      const assignedDependencyIds = template.template?.producers || [];
      
      if (assignedDependencyIds.length === 0) continue;
      
      // Obtener dependencias con nombre completo
      const dependencies = await Dependency.find({
        _id: { $in: assignedDependencyIds }
      }).select('dep_code name').lean();
      
      const depCodes = dependencies.map(d => d.dep_code);
      
      // Dependencias que ya subieron
      const submittedDepCodes = template.loaded_data?.map(d => d.dependency) || [];
      const allDepCodes = [...new Set([...depCodes, ...submittedDepCodes])];
      
      const allDependencies = await Dependency.find({
        dep_code: { $in: allDepCodes }
      }).select('dep_code name').lean();
      
      // Dependencias pendientes
      const pendingDepCodes = depCodes.filter(code => !submittedDepCodes.includes(code));
      
      // Para dependencias que ya subieron
      if (template.loaded_data && template.loaded_data.length > 0) {
        for (const loadedData of template.loaded_data) {
          const dep = allDependencies.find(d => d.dep_code === loadedData.dependency);
          data.push({
            'Plantilla': template.name,
            'Período': template.period?.name || 'N/A',
            'Fecha Límite': template.deadline ? new Date(template.deadline).toLocaleDateString('es-CO') : 'N/A',
            'Usuario': loadedData.send_by?.full_name || loadedData.send_by?.name || 'N/A',
            'Email': loadedData.send_by?.email || 'N/A',
            'Dependencia': dep?.name || loadedData.dependency,
            'Estado': 'Enviado',
            'Fecha Envío': loadedData.loaded_date ? new Date(loadedData.loaded_date).toLocaleDateString('es-CO') : 'N/A'
          });
        }
      }
      
      // Para dependencias pendientes
      for (const depCode of pendingDepCodes) {
        const dep = allDependencies.find(d => d.dep_code === depCode);
        const depName = dep?.name || depCode;
        
        const users = await User.find({
          dependency: depCode,
          isActive: true,
          activeRole: 'Productor'
        }).select('name full_name email activeRole').lean();
        
        if (users.length === 0) {
          data.push({
            'Plantilla': template.name,
            'Período': template.period?.name || 'N/A',
            'Fecha Límite': template.deadline ? new Date(template.deadline).toLocaleDateString('es-CO') : 'N/A',
            'Usuario': 'Sin usuario asignado',
            'Email': 'N/A',
            'Dependencia': depName,
            'Estado': 'Pendiente',
            'Fecha Envío': 'N/A'
          });
        } else {
          for (const user of users) {
            data.push({
              'Plantilla': template.name,
              'Período': template.period?.name || 'N/A',
              'Fecha Límite': template.deadline ? new Date(template.deadline).toLocaleDateString('es-CO') : 'N/A',
              'Usuario': user.full_name || user.name,
              'Email': user.email,
              'Dependencia': depName,
              'Estado': 'Pendiente',
              'Fecha Envío': 'N/A'
            });
          }
        }
      }
    }
    
    // Crear Excel
    const ws = xlsx.utils.json_to_sheet(data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Estado Plantillas');
    
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="estado-plantillas-${Date.now()}.xlsx"`);
    res.send(buffer);
  } catch (error) {
    console.error('Error downloading template submission status:', error);
    res.status(500).json({ message: 'Error downloading report', error: error.message });
  }
};

module.exports = templateStatusController;
