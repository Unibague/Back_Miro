const mongoose = require('mongoose');

const accessProfileSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    positions: {
      type: [String],
      default: []
    },
    individualMembers: {
      type: [Number],
      default: []
    },
    // Personas cuyo cargo esta vinculado al perfil (positions) pero que se
    // excluyeron individualmente (p.ej. al dar "Quitar" en una fila de la
    // tabla de personas activas). Permite remover a una sola persona sin
    // desvincular el cargo completo, que seguiria dando acceso a los demas.
    excludedMembers: {
      type: [Number],
      default: []
    },
    createdBy: {
      type: String,
      default: null
    },
    updatedBy: {
      type: String,
      default: null
    }
  },
  {
    versionKey: false,
    timestamps: true
  }
);

module.exports = mongoose.model('accessProfiles', accessProfileSchema);
