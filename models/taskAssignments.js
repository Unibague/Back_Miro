const mongoose = require('mongoose');

const taskAssignmentSchema = new mongoose.Schema({
  titulo: { type: String, required: true, trim: true },
  descripcion: { type: String, default: '' },
  // dep_code de la dependencia destino (líder/responsable)
  dep_code: { type: String, required: true },
  nombre_dependencia: { type: String, default: '' },
  // email del responsable/líder destino
  email_responsable: { type: String, default: null },
  fecha_limite: { type: String, default: null },
  completada: { type: Boolean, default: false },
  fecha_completada: { type: String, default: null },
  observacion_respuesta: { type: String, default: '' },
  creado_por: { type: String, default: '' },
}, {
  versionKey: false,
  timestamps: true,
});

module.exports = mongoose.model('taskAssignments', taskAssignmentSchema);
