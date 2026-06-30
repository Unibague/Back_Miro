const mongoose = require('mongoose');

const ayudaSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  description: { type: String, default: '', trim: true },
  type: { type: String, enum: ['video', 'pdf'], required: true },
  filename: { type: String, required: true },
  originalName: { type: String, required: true },
  uploadedBy: { type: String, required: true },
  size: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('ayudas', ayudaSchema);
