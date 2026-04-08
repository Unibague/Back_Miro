const mongoose = require('mongoose');

const subactividadSchema = new mongoose.Schema({
  nombre:          { type: String, required: true },
  completada:      { type: Boolean, default: false },
  no_aplica:       { type: Boolean, default: false },
  fecha_completado:{ type: String,  default: null },
  observaciones:   { type: String,  default: '' },
  grupo:           { type: String,  default: null }, // 'satisfactorio' | 'no_satisfactorio' | null
}, { _id: true });

const actividadSchema = new mongoose.Schema({
  nombre:           { type: String, required: true },
  responsables:     { type: String, default: '' },
  completada:       { type: Boolean, default: false },
  no_aplica:        { type: Boolean, default: false },
  fecha_completado: { type: String,  default: null },
  observaciones:    { type: String,  default: '' },
  acto_admin_modo:  { type: String,  default: null }, // 'satisfactorio' | 'no_satisfactorio' | null
  subactividades:   { type: [subactividadSchema], default: [] },
}, { _id: true });

const phaseSchema = new mongoose.Schema({
  proceso_id: { type: mongoose.Schema.Types.ObjectId, ref: 'processes', required: true },
  numero:     { type: Number, min: 0, max: 7, required: true },
  nombre:     { type: String, required: true },
  actividades:{ type: [actividadSchema], default: [] },
}, { versionKey: false, timestamps: true });

module.exports = mongoose.model('phases', phaseSchema);
