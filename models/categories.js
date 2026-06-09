// models/categories.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const categorySchema = new Schema({
  name: {
    type: String,
    required: true
  },
  templates: [
    {
      templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'templates', required: true }
    }
  ]
  
}, { timestamps: true });

module.exports = mongoose.model('categories', categorySchema);
