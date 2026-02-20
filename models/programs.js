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
  fecha_acreditacion: {
    type: String,
    default: null,
  },
  fecha_registro_calificado: {
    type: String,
    default: null,
  },
  estado: {
    type: String,
    enum: ['Activo', 'Inactivo'],
    default: 'Activo',
  },
  estado_acreditacion: {
    type: String,
    enum: ['Completo', 'Inicio del proceso', 'Documentación de lectura de par', 'Digitación en SACES', 'Fecha Límite'],
    default: null,
  },
  estado_registro_calificado: {
    type: String,
    enum: ['Completo', 'Inicio del proceso', 'Documentación de lectura de par', 'Digitación en SACES', 'Fecha Límite'],
    default: null,
  },
  estado_plan_mejoramiento: {
    type: String,
    enum: ['Completo', 'Inicio del proceso', 'Documentación de lectura de par', 'Digitación en SACES', 'Fecha Límite'],
    default: null,
  },
  fase_acreditacion: {
    type: Number,
    min: 0,
    max: 6,
    default: null,
  },
  fase_registro_calificado: {
    type: Number,
    min: 0,
    max: 6,
    default: null,
  },
  fase_plan_mejoramiento: {
    type: Number,
    min: 0,
    max: 6,
    default: null,
  },
},
{
  versionKey: false,
  timestamps: true,
});

module.exports = mongoose.model('programs', programSchema);
