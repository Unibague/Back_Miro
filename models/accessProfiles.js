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
    // Rol al que pertenece el perfil: solo aplica cuando la persona tiene ese
    // rol activo. null = perfil anterior a este cambio (el rol se deduce en
    // services/viewPermissionsResolver.js hasta que se guarde).
    role: {
      type: String,
      enum: ['Administrador', 'Responsable', 'Productor', 'Usuario'],
      default: null
    },
    // Permisos de vista PROPIOS del perfil ({ vista: ["Ver","Gestionar"] }).
    // Antes se guardaban por cargo y los perfiles que compartían un cargo se
    // sobrescribían entre sí. null = aún se leen del cargo (datos anteriores).
    permissions: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    allowed_dimensions: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'dimensions',
      default: []
    },
    allowed_dependencies: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'dependencies',
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
