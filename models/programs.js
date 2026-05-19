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
    default: null,
    unique: true,
    sparse: true,
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

  /* ── Clasificación Internacional Normalizada de Educación CINE F 2013 AC ── */
  cine_f: {
    type: new mongoose.Schema({
      campo_amplio:    { type: String, default: null },
      campo_especifico:{ type: String, default: null },
      campo_detallado: { type: String, default: null },
    }, { _id: false }),
    default: () => ({}),
  },

  /* ── Núcleo Básico del Conocimiento ── */
  nbc: {
    type: new mongoose.Schema({
      area_conocimiento: { type: String, default: null },
      nbc:               { type: String, default: null },
    }, { _id: false }),
    default: () => ({}),
  },

  /* ── Último proceso RC vigente ── */
  ultimo_rc: {
    type: new mongoose.Schema({
      codigo_resolucion:  { type: String, default: null },
      fecha_resolucion:   { type: String, default: null },
      duracion_resolucion:{ type: Number, default: null },
      fecha_vencimiento:  { type: String, default: null },
      link_documento:     { type: String, default: null },
    }, { _id: false }),
    default: null,
  },

  /* ── Último proceso AV vigente ── */
  ultimo_av: {
    type: new mongoose.Schema({
      codigo_resolucion:  { type: String, default: null },
      fecha_resolucion:   { type: String, default: null },
      duracion_resolucion:{ type: Number, default: null },
      fecha_vencimiento:  { type: String, default: null },
      link_documento:     { type: String, default: null },
    }, { _id: false }),
    default: null,
  },

  /* ── Vigencia (actualizada por cron diario) ── */
  tiene_rc_vigente: { type: Boolean, default: false },
  tiene_av_vigente: { type: Boolean, default: false },

  /** Tras cerrar AV: el MEN concederá RC de oficio después; hasta registrarlo, el cron mantiene RC «vigente» en la ficha. */
  av_rc_oficio_pendiente: { type: Boolean, default: false },

  /* ── Totales históricos (calculados al cerrar procesos) ── */
  total_rc: { type: Number, default: 0 },
  total_av: { type: Number, default: 0 },

  /* ── Campos legacy (mantener compatibilidad) ── */
  fecha_resolucion_rc:    { type: String, default: null },
  codigo_resolucion_rc:   { type: String, default: null },
  duracion_resolucion_rc: { type: Number, default: null },
  fecha_resolucion_av:    { type: String, default: null },
  codigo_resolucion_av:   { type: String, default: null },
  duracion_resolucion_av: { type: Number, default: null },

},
{
  versionKey: false,
  timestamps: true,
});

module.exports = mongoose.model('programs', programSchema);
