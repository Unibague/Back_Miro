const mongoose = require('mongoose');
const ConfigurationAudit = require('../models/configurationAudit');

class ConfigurationAuditService {
  
  static async logTemplateChange(templateId, templateName, user, action, changes) {
    try {
      const audit = new ConfigurationAudit({
        entity_type: 'template',
        entity_id: templateId,
        entity_name: templateName,
        action: action,
        user: {
          email: user.email,
          full_name: user.full_name || user.name || user.email
        },
        changes: changes
      });
      
      await audit.save();
      console.log(`✅ Auditoría de plantilla registrada: ${action} - ${templateName}`);
      return audit;
    } catch (error) {
      console.error('❌ Error registrando auditoría de plantilla:', error.message);
      throw error;
    }
  }
  
  static async logReportChange(reportId, reportName, user, action, changes) {
    try {
      const audit = new ConfigurationAudit({
        entity_type: 'report',
        entity_id: reportId,
        entity_name: reportName,
        action: action,
        user: {
          email: user.email,
          full_name: user.full_name || user.name || user.email
        },
        changes: changes
      });
      
      await audit.save();
      console.log(`✅ Auditoría de informe registrada: ${action} - ${reportName}`);
      return audit;
    } catch (error) {
      console.error('❌ Error registrando auditoría de informe:', error.message);
      throw error;
    }
  }
  
  static async logProducerReportChange(reportId, reportName, user, action, changes) {
    try {
      const audit = new ConfigurationAudit({
        entity_type: 'producerReport',
        entity_id: reportId,
        entity_name: reportName,
        action: action,
        user: {
          email: user.email,
          full_name: user.full_name || user.name || user.email
        },
        changes: changes
      });
      
      await audit.save();
      console.log(`✅ Auditoría de informe de productor registrada: ${action} - ${reportName}`);
      return audit;
    } catch (error) {
      console.error('❌ Error registrando auditoría de informe de productor:', error.message);
      throw error;
    }
  }
  
  static detectChanges(oldData, newData, fieldsToTrack) {
    const changes = [];
    
    for (const field of fieldsToTrack) {
      const oldValue = this.getNestedValue(oldData, field.path);
      const newValue = this.getNestedValue(newData, field.path);
      
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        changes.push({
          field: field.name,
          old_value: oldValue,
          new_value: newValue,
          description: field.description
        });
      }
    }
    
    return changes;
  }
  
  static getNestedValue(obj, path) {
    return path.split('.').reduce((current, key) => current?.[key], obj);
  }
  
  static async getAuditHistory(entityType, entityId, options = {}) {
    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;
    
    const query = { entity_type: entityType, entity_id: entityId };
    
    const audits = await ConfigurationAudit.find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit);
    
    const total = await ConfigurationAudit.countDocuments(query);
    
    return {
      audits,
      total,
      page,
      pages: Math.ceil(total / limit)
    };
  }
  
  // Trae el ultimo audit de cada entidad en una sola consulta (evita N llamadas,
  // una por fila, cuando se necesita solo "ultima modificacion" en un listado).
  static async getLatestAuditsForEntities(entityType, entityIds = []) {
    const ids = entityIds
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .map((id) => new mongoose.Types.ObjectId(id));
    if (!ids.length) return {};

    const results = await ConfigurationAudit.aggregate([
      { $match: { entity_type: entityType, entity_id: { $in: ids } } },
      { $sort: { timestamp: -1 } },
      { $group: { _id: '$entity_id', doc: { $first: '$$ROOT' } } },
    ]);

    const map = {};
    for (const r of results) map[String(r._id)] = r.doc;
    return map;
  }

  static async getUserAuditHistory(userEmail, options = {}) {
    const { page = 1, limit = 20 } = options;
    const skip = (page - 1) * limit;
    
    const query = { 'user.email': userEmail };
    
    const audits = await ConfigurationAudit.find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit);
    
    const total = await ConfigurationAudit.countDocuments(query);
    
    return {
      audits,
      total,
      page,
      pages: Math.ceil(total / limit)
    };
  }
}

module.exports = ConfigurationAuditService;
