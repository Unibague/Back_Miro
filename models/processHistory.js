const mongoose = require('mongoose');

/* Snapshot de un documento de fase al momento de cerrar el proceso */
const docSnapshotSchema = new mongoose.Schema(
  {
    _id:           { type: mongoose.Schema.Types.ObjectId },
    name:          { type: String },
    drive_id:      { type: String },
    view_link:     { type: String },
    download_link: { type: String },
    mime_type:     { type: String, default: null },
    size:          { type: Number, default: null },
  },
  { _id: false }
);

/* Snapshot de una fase completa al momento de cerrar el proceso */
const faseSnapshotSchema = new mongoose.Schema(
  {
    fase_numero: { type: Number },
    fase_nombre: { type: String },
    actividades_completadas: { type: Number, default: 0 },
    actividades_total:       { type: Number, default: 0 },
    documentos:              { type: [docSnapshotSchema], default: [] },
  },
  { _id: false }
);

const processHistorySchema = new mongoose.Schema(
  {
    /* Referencia al programa */
    program_code:     { type: String, required: true, index: true },
    dep_code_facultad:{ type: String, default: null,  index: true },
    nombre_programa:  { type: String, required: true },

    /* Datos del proceso archivado */
    process_id:       { type: mongoose.Schema.Types.ObjectId, ref: 'processes', default: null },
    tipo_proceso:     { type: String, enum: ['RC', 'AV', 'PM'], required: true },
    nombre_proceso:   { type: String, required: true },
    subtipo:          { type: String, default: null },

    /* Resolución archivada */
    codigo_resolucion:  { type: String, default: null },
    fecha_resolucion:   { type: String, default: null },
    duracion_resolucion:{ type: Number, default: null },

    /* Fechas del proceso al momento de cerrarse */
    fecha_vencimiento:      { type: String, default: null },
    fecha_inicio:           { type: String, default: null },
    fecha_documento_par:    { type: String, default: null },
    fecha_digitacion_saces: { type: String, default: null },
    fecha_radicado_men:     { type: String, default: null },

    /* Estado al cierre */
    fase_al_cierre:    { type: Number, default: 0 },
    observaciones:     { type: String, default: '' },
    condicion:         { type: Number, default: null },

    /* PM ligado al cierre (snapshot completo si existía uno activo) */
    pm_ligado: {
      type: new mongoose.Schema({
        subtipo:                         { type: String, default: null },
        fecha_envio_pm_vicerrectoria:    { type: String, default: null },
        fecha_entrega_pm_cna:            { type: String, default: null },
        fecha_envio_avance_vicerrectoria:{ type: String, default: null },
        fecha_radicacion_avance_cna:     { type: String, default: null },
        observaciones:                   { type: String, default: '' },
      }, { _id: false }),
      default: null,
    },

    /* Snapshot de fases con sus documentos */
    fases: { type: [faseSnapshotSchema], default: [] },

    /* PDF de resolución vigente (ligado al proceso, no a una fase) */
    documentos_proceso: { type: [docSnapshotSchema], default: [] },

    /* Metadatos del cierre */
    cerrado_en:  { type: Date, default: Date.now },
    cerrado_por: { type: String, default: null },
  },
  {
    versionKey: false,
    timestamps: true,
  }
);

module.exports = mongoose.model('processhistory', processHistorySchema);
