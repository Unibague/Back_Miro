const mongoose = require('mongoose');

const docSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    view_link: { type: String, required: true },
  },
  { _id: false }
);

/** Fechas proyectadas tipo renovación al cerrar un proceso RC/AV (para correos / seguimiento). */
const processReminderSchema = new mongoose.Schema(
  {
    process_history_id: { type: mongoose.Schema.Types.ObjectId, ref: 'processhistory', required: true },
    program_code: { type: String, required: true, index: true },
    dep_code_facultad: { type: String, default: null, index: true },
    nombre_programa: { type: String, required: true },
    nivel_academico: { type: String, default: null, index: true },
    tipo_proceso: { type: String, enum: ['RC', 'AV'], required: true },

    codigo_resolucion: { type: String, default: null },
    fecha_resolucion: { type: String, default: null },
    duracion_resolucion: { type: Number, default: null },

    fecha_vencimiento: { type: String, default: null },
    fecha_inicio: { type: String, default: null },
    fecha_documento_par: { type: String, default: null },
    fecha_digitacion_saces: { type: String, default: null },
    fecha_radicado_men: { type: String, default: null },

    /** Observaciones congeladas al cierre (no se sobrescriben con procesos nuevos) */
    obs_vencimiento: { type: String, default: '' },
    obs_inicio: { type: String, default: '' },
    obs_documento_par: { type: String, default: '' },
    obs_digitacion_saces: { type: String, default: '' },
    obs_radicado_men: { type: String, default: '' },

    documentos: { type: [docSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('processreminder', processReminderSchema);
