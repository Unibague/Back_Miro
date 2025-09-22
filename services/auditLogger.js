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
}

module.exports = AuditLogger;