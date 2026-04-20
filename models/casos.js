const mongoose = require('mongoose');

const casoSchema = new mongoose.Schema(
  {
    proceso_id:                     { type: mongoose.Schema.Types.ObjectId, ref: 'processes', required: true, unique: true },
    codigo_caso:                    { type: String,  default: null },
    fecha_solicitud_radicado:       { type: String,  default: null },
    fecha_notificacion_completitud: { type: String,  default: null },
    fecha_respuesta_completitud:    { type: String,  default: null },
    fecha_resolucion:               { type: String,  default: null },
    resolucion_aprobada:            { type: Boolean, default: null },
    aplica_apelacion:               { type: Boolean, default: false },
    fecha_resolucion_apelacion:     { type: String,  default: null },
    fecha_respuesta_men:            { type: String,  default: null },
    obs_fecha_solicitud_radicado:       { type: String, default: '' },
    obs_fecha_notificacion_completitud: { type: String, default: '' },
    obs_fecha_respuesta_completitud:    { type: String, default: '' },
    obs_fecha_resolucion:               { type: String, default: '' },
    obs_fecha_resolucion_apelacion:     { type: String, default: '' },
    obs_fecha_respuesta_men:            { type: String, default: '' },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model('casos', casoSchema);
