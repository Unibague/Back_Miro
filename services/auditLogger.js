const AuditLog = require('../models/auditLogs');

class AuditLogger {
    static async log(logData) {
        try {
            const auditLog = new AuditLog({
                user_email: logData.user_email,
                user_name: logData.user_name,
                action: logData.action,
                entity_type: logData.entity_type,
                entity_name: logData.entity_name,
                entity_id: logData.entity_id,
                details: logData.details,
                ip_address: logData.ip_address,
                user_agent: logData.user_agent
            });
            
            await auditLog.save();
        } catch (error) {
            console.error('Error saving audit log:', error);
        }
    }

    // Métodos específicos para diferentes acciones
    static async logCreate(req, user, entityType, details) {
        await this.log({
            user_email: user.email,
            user_name: user.full_name || user.name || 'Usuario',
            action: 'CREATE',
            entity_type: entityType,
            entity_name: details.templateName || details.reportName || details.dimensionName || details.validatorName || details.sectionTitle || 'Unknown',
            entity_id: details.templateId || details.reportId || details.dimensionId || details.validatorId || details.sectionId || 'Unknown',
            details: JSON.stringify(details),
            ip_address: req?.ip,
            user_agent: req?.get('User-Agent')
        });
    }

    static async logUpdate(req, user, entityType, details) {
        await this.log({
            user_email: user.email,
            user_name: user.full_name || user.name || 'Usuario',
            action: 'UPDATE',
            entity_type: entityType,
            entity_name: details.templateName || details.reportName || details.dimensionName || details.validatorName || details.sectionTitle || details.userEmail || details.userEmail || 'Usuario A/I',
            entity_id: details.templateId || details.reportId || details.dimensionId || details.validatorId || details.sectionId || details.userId || 'Unknown',
            details: JSON.stringify(details),
            ip_address: req?.ip,
            user_agent: req?.get('User-Agent')
        });
    }

    static async logDelete(req, user, entityType, details) {
        await this.log({
            user_email: user.email,
            user_name: user.full_name || user.name || 'Usuario',
            action: 'DELETE',
            entity_type: entityType,
            entity_name: details.templateName || details.reportName || details.dimensionName || details.validatorName || details.sectionTitle || 'Unknown',
            entity_id: details.templateId || details.reportId || details.dimensionId || details.validatorId || details.sectionId || 'Unknown',
            details: JSON.stringify(details),
            ip_address: req?.ip,
            user_agent: req?.get('User-Agent')
        });
    }

    static async logUpload(req, user, entityType, details) {
        await this.log({
            user_email: user.email,
            user_name: user.full_name || user.name || 'Usuario',
            action: 'UPLOAD',
            entity_type: entityType,
            entity_name: details.templateName || details.reportName || details.dimensionName || details.validatorName || details.sectionTitle || 'Unknown',
            entity_id: details.templateId || details.reportId || details.dimensionId || details.validatorId || details.sectionId || 'Unknown',
            details: JSON.stringify(details),
            ip_address: req?.ip,
            user_agent: req?.get('User-Agent')
        });
    }

    static async logImpersonate(req, user, targetUserEmail) {
        await this.log({
            user_email: user.email,
            user_name: user.full_name || user.name || 'Usuario',
            action: 'IMPERSONATE',
            entity_type: 'user',
            entity_name: targetUserEmail,
            entity_id: 'impersonation',
            details: JSON.stringify({ targetUser: targetUserEmail }),
            ip_address: req?.ip,
            user_agent: req?.get('User-Agent')
        });
    }

    // Métodos específicos para plantillas con filtros
    static async logDownload(req, user, entityType, details) {
        await this.log({
            user_email: user.email,
            user_name: user.full_name || user.name || 'Usuario',
            action: 'DOWNLOAD',
            entity_type: entityType,
            entity_name: details.templateName || details.entity_name || 'Unknown',
            entity_id: details.templateId || details.entity_id || 'Unknown',
            details: JSON.stringify({
                action: 'download',
                entity_type: entityType,
                entity_name: details.templateName || details.entity_name,
                templateId: details.templateId,
                fileName: details.fileName,
                dataRows: details.dataRows,
                period: details.period
            }),
            ip_address: req?.ip,
            user_agent: req?.get('User-Agent')
        });
    }

    static async logFilterConfig(req, user, details) {
        await this.log({
            user_email: user.email,
            user_name: user.full_name || user.name || 'Usuario',
            action: 'UPDATE',
            entity_type: 'template_filters',
            entity_name: `Filtros de ${details.templateName}`,
            entity_id: details.templateId || 'filter_config',
            details: JSON.stringify({
                action: 'update',
                entity_type: 'template_filters',
                entity_name: `Filtros de ${details.templateName}`,
                templateName: details.templateName,
                filterChanges: details.filterChanges,
                actionDescription: 'Configuración de filtros actualizada'
            }),
            ip_address: req?.ip,
            user_agent: req?.get('User-Agent')
        });
    }

    static async logFieldConfig(req, user, details) {
        await this.log({
            user_email: user.email,
            user_name: user.full_name || user.name || 'Usuario',
            action: 'FIELD_CONFIG',
            entity_type: 'published_template',
            entity_name: details.templateNames ? details.templateNames.join(', ') : 'Multiple templates',
            entity_id: 'field_config',
            details: JSON.stringify({
                action: 'field_config',
                entity_type: 'published_template',
                entity_name: details.templateNames ? details.templateNames.join(', ') : 'Multiple templates',
                templatesCount: details.templatesCount,
                fieldsCount: details.fieldsCount,
                selectedFields: details.selectedFields
            }),
            ip_address: req?.ip,
            user_agent: req?.get('User-Agent')
        });
    }

    static async logMultiDownload(req, user, details) {
        await this.log({
            user_email: user.email,
            user_name: user.full_name || user.name || 'Usuario',
            action: 'MULTI_DOWNLOAD',
            entity_type: 'published_template',
            entity_name: `${details.templates ? details.templates.length : 0} plantillas`,
            entity_id: 'multi_download',
            details: JSON.stringify({
                action: 'multi_download',
                entity_type: 'published_template',
                entity_name: `${details.templates ? details.templates.length : 0} plantillas`,
                templates: details.templates,
                fieldsCount: details.fieldsCount,
                selectedFields: details.selectedFields,
                actionDescription: 'Descarga múltiple de plantillas con campos configurados'
            }),
            ip_address: req?.ip,
            user_agent: req?.get('User-Agent')
        });
    }

    static async logRead(req, user, entityType, details) {
        await this.log({
            user_email: user.email,
            user_name: user.full_name || user.name || 'Usuario',
            action: 'READ',
            entity_type: entityType,
            entity_name: details.templateName || details.entity_name || 'Unknown',
            entity_id: details.templateId || details.entity_id || 'Unknown',
            details: JSON.stringify(details),
            ip_address: req?.ip,
            user_agent: req?.get('User-Agent')
        });
    }
}

module.exports = AuditLogger;