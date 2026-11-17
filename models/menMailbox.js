const mongoose = require('mongoose');

/** Historial de mensajes enviados desde el Buzón del módulo MEN. */
const menMailboxSchema = new mongoose.Schema(
  {
    /** general = recordatorio general; administradores / responsables = mensajes dirigidos (en prueba van solo a quien envía). */
    tipo: { type: String, enum: ['general', 'administradores', 'responsables'], default: 'general' },
    asunto: { type: String, required: true, trim: true },
    cuerpo: { type: String, required: true },
    destinatarios: { type: [String], default: [] },
    enviado_por: { type: String, default: '' },
    estado: { type: String, enum: ['enviado', 'error'], default: 'enviado' },
    error: { type: String, default: null },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model('menmailbox', menMailboxSchema);
