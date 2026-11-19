const ConfigurationAuditService = require('../services/configurationAudit');
const Template = require('../models/templates');
const Report = require('../models/reports');
const ProducerReport = require('../models/producerReports');
const User = require('../models/users');

const getModelByType = (entityType) => {
  switch (entityType) {
    case 'template':
      return Template;
    case 'report':
      return Report;
    case 'producerReport':
      return ProducerReport;
    default:
      throw new Error(`Unknown entity type: ${entityType}`);
  }
};

const auditMiddleware = (entityType) => {
  return async (req, res, next) => {
    const Model = getModelByType(entityType);
    const entityId = req.params.id;
    
    // Solo auditar operaciones de modificación
    if (!['PUT', 'PATCH', 'DELETE', 'POST'].includes(req.method)) {
      return next();
    }
    
    try {
      let originalData = null;
      
      // Capturar datos originales para UPDATE y DELETE
      if (entityId && (req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE')) {
        originalData = await Model.findById(entityId).lean();
      }
      
      // Guardar datos originales en req para uso posterior
      req.auditData = {
        entityType,
        originalData,
        entityId
      };
      
      // Interceptar la respuesta para capturar los nuevos datos
      const originalJson = res.json.bind(res);
      res.json = async function(data) {
        try {
          // Buscar usuario en múltiples fuentes
          const userEmail = req.body.email || req.body.userEmail || req.query.email || 
                           req.headers['user-email'] || req.user?.email || 'system';
          let userFullName = req.body.full_name || req.body.userName || req.body.fullName ||
                            req.headers['user-name'] || req.user?.full_name || req.user?.name;
          // La duplicación individual y masiva envía el correo del actor.
          // Resolver su nombre en servidor evita registrar la copia como System.
          if ((!userFullName || userFullName === 'System') && userEmail !== 'system') {
            const actor = await User.findOne({ email: userEmail }).select('full_name').lean();
            userFullName = actor?.full_name || userEmail;
          }
          userFullName ||= 'System';
          
          console.log('🔍 Audit - Usuario capturado:', { email: userEmail, full_name: userFullName });
          
          const user = {
            email: userEmail,
            full_name: userFullName
          };
          
          let action = 'update';
          let changes = [];
          let entityName = '';
          
          if (req.method === 'POST') {
            action = 'create';
            entityName = data.template?.name || data.report?.name || data.name || 'Nueva entidad';
            changes = [{
              field: 'Entidad completa',
              old_value: null,
              new_value: 'Creada',
              description: `${entityType} creada`
            }];
          } else if (req.method === 'DELETE') {
            action = 'delete';
            entityName = originalData?.name || 'Entidad eliminada';
            changes = [{
              field: 'Entidad completa',
              old_value: 'Existente',
              new_value: null,
              description: `${entityType} eliminada`
            }];
          } else {
            // UPDATE - detectar cambios específicos
            const newData = await Model.findById(entityId).lean();
            entityName = newData?.name || originalData?.name || 'Entidad';
            
            const fieldsToTrack = [
              { path: 'name', name: 'Nombre', description: 'Nombre de la entidad' },
              { path: 'active', name: 'Estado', description: 'Estado activo/inactivo' },
              { path: 'producers', name: 'Productores', description: 'Dependencias productoras' },
              { path: 'dimensions', name: 'Dimensiones', description: 'Dimensiones asignadas' },
              { path: 'fields', name: 'Campos', description: 'Campos de configuración' },
              { path: 'file_description', name: 'Descripción de archivo', description: 'Descripción del archivo' },
              { path: 'requires_attachment', name: 'Requiere adjuntos', description: 'Si requiere archivos adjuntos' }
            ];
            
            changes = ConfigurationAuditService.detectChanges(
              originalData,
              newData,
              fieldsToTrack
            );
          }
          
          // Solo registrar si hay cambios o es creación/eliminación
          if (changes.length > 0 || action === 'create' || action === 'delete') {
            const logMethod = entityType === 'template' 
              ? ConfigurationAuditService.logTemplateChange
              : entityType === 'report'
              ? ConfigurationAuditService.logReportChange
              : ConfigurationAuditService.logProducerReportChange;
            
            await logMethod(
              entityId || data._id || data.template?._id || data.report?._id,
              entityName,
              user,
              action,
              changes
            );
            
            console.log(`✅ Auditoría registrada: ${action} - ${entityName} por ${user.email}`);
          }
        } catch (auditError) {
          console.error('❌ Error en auditoría:', auditError.message);
          // No fallar la operación principal si falla la auditoría
        }
        
        return originalJson(data);
      };
      
      next();
    } catch (error) {
      console.error('❌ Error en middleware de auditoría:', error.message);
      next(); // Continuar aunque falle la auditoría
    }
  };
};

module.exports = auditMiddleware;
