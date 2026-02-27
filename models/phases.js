const mongoose = require('mongoose');

const actividadSchema = new mongoose.Schema({
  nombre: {
    type: String,
    required: true,
  },
  responsables: {
    type: String,
    default: "",
  },
  completada: {
    type: Boolean,
    default: false,
  },
}, { _id: true });

const phaseSchema = new mongoose.Schema({
  proceso_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'processes',
    required: true,
  },
  numero: {
    type: Number,
    min: 0,
    max: 6,
    required: true,
  },
  nombre: {
    type: String,
    required: true,
  },
  actividades: {
    type: [actividadSchema],
    default: [],
  },
},
{
  versionKey: false,
  timestamps: true,
});

module.exports = mongoose.model('phases', phaseSchema);
