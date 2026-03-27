const mongoose = require('mongoose');

const configurationAuditSchema = new mongoose.Schema({
  entity_type: {
    type: String,
    required: true,
    enum: ['template', 'report', 'producerReport']
  },
  entity_id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  entity_name: {
    type: String,
    required: true
  },
  action: {
    type: String,
    required: true,
    enum: ['create', 'update', 'delete']
  },
  user: {
    email: { type: String, required: true },
    full_name: { type: String, required: true }
  },
  changes: [{
    field: { type: String, required: true },
    old_value: { type: mongoose.Schema.Types.Mixed },
    new_value: { type: mongoose.Schema.Types.Mixed },
    description: { type: String }
  }],
  timestamp: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

configurationAuditSchema.index({ entity_type: 1, entity_id: 1, timestamp: -1 });
configurationAuditSchema.index({ 'user.email': 1, timestamp: -1 });

module.exports = mongoose.model('configurationAudits', configurationAuditSchema);
