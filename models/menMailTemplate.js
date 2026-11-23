const mongoose = require('mongoose');

/** Mensajes predeterminados del Buzón MEN, editables por el administrador. */
const menMailTemplateSchema = new mongoose.Schema(
  {
    /** responsables = correo a cada programa y su línea; administradores = resumen con fecha de radicación. */
    clave: { type: String, enum: ['responsables', 'administradores'], required: true, unique: true },
    asunto: { type: String, required: true, trim: true },
    cuerpo: { type: String, required: true },
    actualizado_por: { type: String, default: '' },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model('menmailtemplate', menMailTemplateSchema);
