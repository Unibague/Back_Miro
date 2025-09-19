const mongoose = require('mongoose');

const templateFilterSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true
  },
  label: {
    type: String,
    required: true
  },
  type: {
    type: String,
    required: true,
    enum: ['select', 'multiselect', 'text', 'date']
  },
  source: {
    type: String,
    required: true,
    enum: ['estudiantes', 'funcionarios', 'dependencies', 'custom', 'template_fields']
  },
  sourceField: {
    type: String,
    required: function() {
      return this.source !== 'custom';
    }
  },
  customOptions: [{
    value: String,
    label: String
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  order: {
    type: Number,
    default: 0
  },
  hasSubfilter: {
    type: Boolean,
    default: false
  },
  subfilterConfig: {
    source: String,
    sourceField: String,
    dependsOn: String
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('templateFilters', templateFilterSchema);