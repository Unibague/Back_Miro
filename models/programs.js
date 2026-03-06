const mongoose = require('mongoose');

const programSchema = new mongoose.Schema({
  nombre: {
    type: String,
    required: true,
  },
  dep_code_facultad: {
    type: String,
    required: true,
  },
  dep_code_programa: {
    type: String,
    required: true,
    unique: true,
  },
  codigo_snies: {
    type: String,
    default: null,
  },
  modalidad: {
    type: String,
    enum: ['Presencial', 'Virtual', 'Híbrido'],
    default: null,
  },
  nivel_academico: {
    type: String,
    enum: ['Pregrado', 'Posgrado'],
    default: null,
  },
  nivel_formacion: {
    type: String,
    enum: ['Profesional', 'Tecnológico', 'Técnico', 'Especialización', 'Maestría', 'Doctorado'],
    default: null,
  },
  num_creditos: {
    type: Number,
    default: null,
  },
  num_semestres: {
    type: Number,
    default: null,
  },
  admision_estudiantes: {
    type: String,
    default: null,
  },
  num_estudiantes_saces: {
    type: Number,
    default: null,
  },
  estado: {
    type: String,
    enum: ['Activo', 'Inactivo'],
    default: 'Activo',
  },

  /* ── Resolución vigente — Registro Calificado (RC) ── */
  fecha_resolucion_rc: {
    type: String,   // YYYY-MM-DD
    default: null,
  },
  codigo_resolucion_rc: {
    type: String,
    default: null,
  },
  duracion_resolucion_rc: {
    type: Number,   // en años (ej: 7 = 7 años)
    default: null,
  },

  /* ── Resolución vigente — Acreditación Voluntaria (AV) ── */
  fecha_resolucion_av: {
    type: String,   // YYYY-MM-DD
    default: null,
  },
  codigo_resolucion_av: {
    type: String,
    default: null,
  },
  duracion_resolucion_av: {
    type: Number,   // en años (ej: 4 = 4 años)
    default: null,
  },

},
{
  versionKey: false,
  timestamps: true,
});

module.exports = mongoose.model('programs', programSchema);
