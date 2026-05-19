const mongoose = require('mongoose');

/* Snapshot de un documento al momento de cerrar el proceso */
const docSnapshotSchema = new mongoose.Schema(
  {
    _id:           { type: mongoose.Schema.Types.ObjectId },
    name:          { type: String },
    drive_id:      { type: String },
    view_link:     { type: String },
    download_link: { type: String },
    mime_type:     { type: String, default: null },
    size:          { type: Number, default: null },
    subido_en:     { type: Date, default: null },
    /** Tipo al cerrar (resolucion_cierre, constancia_reforma, etc.); necesario para mostrar el PDF correcto en historial. */
    doc_type:      { type: String, default: null },
    caso_date_key: { type: String, default: null },
  },
  { _id: false }
);

/* Snapshot de una subactividad */
const subactividadSnapshotSchema = new mongoose.Schema(
  {
    nombre:          { type: String },
    completada:      { type: Boolean, default: false },
    no_aplica:       { type: Boolean, default: false },
    fecha_completado:{ type: String, default: null },
    observaciones:   { type: String, default: '' },
    documentos:      { type: [docSnapshotSchema], default: [] },
  },
  { _id: false }
);

/* Snapshot de una actividad */
const actividadSnapshotSchema = new mongoose.Schema(
  {
    nombre:          { type: String },
    responsables:    { type: String, default: '' },
    completada:      { type: Boolean, default: false },
    no_aplica:       { type: Boolean, default: false },
    fecha_completado:{ type: String, default: null },
    observaciones:   { type: String, default: '' },
    documentos:      { type: [docSnapshotSchema], default: [] },
    subactividades:  { type: [subactividadSnapshotSchema], default: [] },
  },
  { _id: false }
);

/* Snapshot de una fase completa al momento de cerrar el proceso */
const faseSnapshotSchema = new mongoose.Schema(
  {
    fase_numero:             { type: Number },
    fase_nombre:             { type: String },
    actividades_completadas: { type: Number, default: 0 },
    actividades_total:       { type: Number, default: 0 },
    documentos:              { type: [docSnapshotSchema], default: [] },
    actividades:             { type: [actividadSnapshotSchema], default: [] },
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
    tipo_proceso:     { type: String, enum: ['RC', 'AV', 'AE', 'PM'], required: true },
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

    /* Observaciones de fechas del trámite al cierre */
    obs_vencimiento:      { type: String, default: '' },
    obs_inicio:           { type: String, default: '' },
    obs_documento_par:    { type: String, default: '' },
    obs_digitacion_saces: { type: String, default: '' },
    obs_radicado_men:     { type: String, default: '' },
    obs_envio_pm_vicerrectoria:     { type: String, default: '' },
    obs_entrega_pm_cna:             { type: String, default: '' },
    obs_envio_avance_vicerrectoria: { type: String, default: '' },
    obs_radicacion_avance_cna:      { type: String, default: '' },

    /** Snapshot de «Información del caso» (fechas, estado, reposición, docs y obs por fecha). */
    caso_snapshot: {
      type: new mongoose.Schema(
        {
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
          documentos_por_fecha: { type: mongoose.Schema.Types.Mixed, default: {} },
        },
        { _id: false }
      ),
      default: null,
    },

    /* Fechas específicas del PM (solo aplica a historial tipo PM) */
    fecha_envio_pm_vicerrectoria:     { type: String, default: null },
    fecha_entrega_pm_cna:             { type: String, default: null },
    fecha_envio_avance_vicerrectoria: { type: String, default: null },
    fecha_radicacion_avance_cna:      { type: String, default: null },

    /* Estado al cierre */
    fase_al_cierre:    { type: Number, default: 0 },
    observaciones:     { type: String, default: '' },
    condicion:         { type: Number, default: null },

    /* PM ligado al cierre (snapshot legacy — campos de fechas planas) */
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

    /**
     * Solo AV / AE: ID del proceso PM activo creado automáticamente al cerrar.
     * Mientras el PM está en curso, este campo apunta al proceso PM activo.
     * Se limpia cuando el PM es cerrado y se archiva (pm_history_id toma el relevo).
     */
    pm_proceso_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'processes',
      default: null,
    },

    /**
     * Solo AV / AE: ID del historial del PM una vez cerrado.
     * Cuando se cierra el PM, su historial se crea y este campo queda apuntando a él.
     */
    pm_history_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'processhistory',
      default: null,
    },

    /**
     * Solo PM: ID del historial del proceso AV/AE padre al que este PM pertenece.
     */
    parent_history_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'processhistory',
      default: null,
    },

    /* Snapshot de fases con sus documentos */
    fases: { type: [faseSnapshotSchema], default: [] },

    /* PDF de resolución vigente (ligado al proceso, no a una fase) */
    documentos_proceso: { type: [docSnapshotSchema], default: [] },

    /**
     * Solo RC con subtipo "Reforma curricular" o "Renovación + reforma":
     * diff de los campos del programa que cambiaron al cerrar el proceso.
     * Formato: [{ campo, label, antes, despues }]
     */
    programa_cambios: {
      type: [
        new mongoose.Schema({
          campo:   { type: String },
          label:   { type: String },
          antes:   { type: mongoose.Schema.Types.Mixed },
          despues: { type: mongoose.Schema.Types.Mixed },
        }, { _id: false }),
      ],
      default: [],
    },

    /** Snapshot de la ficha del programa tras cierre aprobado (reforma / renovación+reforma). */
    programa_ficha_al_cierre: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    /* Metadatos del cierre */
    cerrado_en:  { type: Date, default: Date.now },
    cerrado_por: { type: String, default: null },

    /** Resultado de la solicitud MEN (solo aplica a cierres con evaluación) */
    estado_solicitud: {
      type: String,
      enum: ['APROBADO', 'NEGADO', 'CANCELADO'],
      default: 'APROBADO',
    },

    /** Solo AV: cómo quedó el RC de oficio en el cierre (ninguno | incluido | pendiente de entrega). */
    av_rc_oficio_modo: {
      type: String,
      enum: ['ninguno', 'incluido', 'pendiente'],
      default: undefined,
    },

    /**
     * Solo AV con RC de oficio: ID del historial del RC de oficio creado al mismo tiempo.
     */
    rc_oficio_history_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'processhistory',
      default: null,
    },

    /**
     * Solo AV aprobado con RC de oficio pendiente:
     * id del historial RC «Vigencia transitoria» (solo archivo), creado al mismo cierre.
     */
    rc_vigencia_transitoria_history_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'processhistory',
      default: null,
    },

    /** Solo RC historial subtipo Vigencia transitoria: cierre AV que originó esta fila de archivo. */
    origen_av_history_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'processhistory',
      default: null,
    },

    /**
     * Solo RC «No renovación»: resolución MEN que estaba vigente al abrir/gestionar el trámite
     * (distinto de la respuesta al cierre en fecha_resolucion / documentos_proceso).
     */
    resolucion_vigente_snapshot: {
      type: new mongoose.Schema(
        {
          codigo_resolucion:  { type: String, default: null },
          fecha_resolucion:   { type: String, default: null },
          fecha_vencimiento:  { type: String, default: null },
          duracion_resolucion:{ type: Number, default: null },
          documentos:         { type: [docSnapshotSchema], default: [] },
        },
        { _id: false }
      ),
      default: null,
    },

    /**
     * Solo cierre AV con av_espera_rc_oficio: copia de la resolución de RC de oficio
     * y sus documentos, para historial.
     */
    rc_oficio: {
      type: new mongoose.Schema(
        {
          codigo_resolucion:  { type: String, default: null },
          fecha_resolucion:   { type: String, default: null },
          duracion_resolucion:{ type: Number, default: null },
          documentos:         { type: [docSnapshotSchema], default: [] },
        },
        { _id: false }
      ),
      default: null,
    },
  },
  {
    versionKey: false,
    timestamps: true,
  }
);

module.exports = mongoose.model('processhistory', processHistorySchema);
