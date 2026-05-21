const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const qrTokenSchema = new Schema({
  token: { type: String, required: true, unique: true },
  publishedTemplateId: { type: Schema.Types.ObjectId, ref: 'publishedTemplates', required: true },
  dependency: { type: String, required: true },
  createdBy: { type: String, default: '' }, // email del productor que generó el QR
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date },
  active: { type: Boolean, default: true }
}, { versionKey: false });

module.exports = mongoose.model('qrTokens', qrTokenSchema);
