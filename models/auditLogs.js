const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
    user_email: {
        type: String,
        required: true,
        index: true
    },
    user_name: {
        type: String,
        required: true
    },
    action: {
        type: String,
        required: true,
        enum: ['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'UPLOAD', 'DOWNLOAD', 'IMPERSONATE']
    },
    entity_type: {
        type: String,
        required: true,
        enum: ['DEPENDENCY', 'USER', 'SCOPE', 'TEMPLATE', 'REPORT', 'FILE', 'DIMENSION', 
               'dimension', 'template', 'report', 'publishedReport', 'publishedTemplate', 
               'publishedTemplateData', 'producerReport', 'publishedProducerReport', 
               'validator', 'homeInfoSection', 'user', 'templateFilter']
    },
    entity_name: {
        type: String,
        required: true
    },
    entity_id: {
        type: String,
        required: false
    },
    details: {
        type: String,
        required: true
    },
    timestamp: {
        type: Date,
        default: Date.now,
        index: true
    },
    ip_address: {
        type: String,
        required: false
    },
    user_agent: {
        type: String,
        required: false
    }
}, {
    versionKey: false,
    timestamps: false
});

// Índices para optimizar consultas
auditLogSchema.index({ user_email: 1, timestamp: -1 });
auditLogSchema.index({ entity_type: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });

module.exports = mongoose.model('auditLogs', auditLogSchema);