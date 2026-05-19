const mongoose = require('mongoose');

const processSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  /** Ligadura al programa: **`_id` Mongo** (actual). Valores viejos pueden ser `dep_code_programa`. */
  program_code: {
    type: String,
    required: true,
  },
  tipo_proceso: {
    type: String,
    enum: ['RC', 'AV', 'AE', 'PM', 'ALERTA'],
    required: true,
  },
  /** Solo ALERTA: a qué línea pertenece la alerta (RC/AV/AE = post-cierre; PM = alerta activa del plan) */
  alert_para_tipo: {
    type: String,
    enum: ['RC', 'AV', 'AE', 'PM', null],
    default: null,
  },
  cerrado_process_history_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'processhistory',
    default: null,
  },
  /** Congelados al cierre (solo ALERTA) */
  snapshot_codigo_resolucion: { type: String, default: null },
  snapshot_fecha_resolucion: { type: String, default: null },
  snapshot_duracion_anos: { type: Number, default: null },
  /* Subtipo del proceso:
     RC  → Nuevo | Renovación | No renovación | Reforma/actualización curricular | Reactivación | …
     AV  → Nuevo | Renovación | No renovación | Reactivación
     AE  → Autoevaluación
     PM  → Plan de Mejoramiento AV | Plan de Mejoramiento AE */
  subtipo: {
    type: String,
    default: null,
  },
  /** Solo AV: al cerrar, si es true, se pide además resolución de RC de oficio (dos alertas). */
  av_espera_rc_oficio: {
    type: Boolean,
    default: false,
  },
  // Si es un PM o AE, referencia al proceso padre (AV o AE para PM; RC o AV para AE)
  parent_process_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'processes',
    default: null,
  },
  parent_tipo_proceso: {
    type: String,
    enum: ['RC', 'AV', 'AE', null],
    default: null,
  },
  // Solo AE: proceso RC o AV al que está vinculado (informativo)
  linked_process_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'processes',
    default: null,
  },
  linked_process_tipo: {
    type: String,
    enum: ['RC', 'AV', null],
    default: null,
  },
  fase_actual: {
    type: Number,
    min: 0,
    max: 7,
    default: 0,
  },
  observaciones: {
    type: String,
    default: '',
  },
  /* Condición (RC: 1-9) o Factor (AV: 1-12) asociado al proceso (fase 2 — viabilidad financiera) */
  condicion: {
    type: Number,
    default: null,
  },

  /* Condición RC (1-9) o Factor AV (1-12) en revisión durante "Reuniones parciales de avance" */
  factor_condicion_actual: {
    type: Number,
    default: null,
  },

  /* Observaciones por fecha (proceso principal RC/AV) */
  obs_vencimiento:      { type: String, default: '' },
  obs_inicio:           { type: String, default: '' },
  obs_documento_par:    { type: String, default: '' },
  obs_digitacion_saces: { type: String, default: '' },
  obs_radicado_men:     { type: String, default: '' },

  /* Observaciones por fecha (Plan de Mejoramiento) */
  obs_envio_pm_vicerrectoria:    { type: String, default: '' },
  obs_entrega_pm_cna:            { type: String, default: '' },
  obs_envio_avance_vicerrectoria:{ type: String, default: '' },
  obs_radicacion_avance_cna:     { type: String, default: '' },

  /* Etiquetas editables para las fechas del Plan de Mejoramiento (RC) */
  label_envio_pm_vicerrectoria:    { type: String, default: null },
  label_entrega_pm_cna:            { type: String, default: null },
  label_envio_avance_vicerrectoria:{ type: String, default: null },
  label_radicacion_avance_cna:     { type: String, default: null },

  /* Meses de cálculo configurables para el PM */
  meses_envio_pm:       { type: Number, default: null },
  meses_entrega_pm_cna: { type: Number, default: null },
  meses_envio_avance:   { type: Number, default: null },
  meses_radicacion_avance: { type: Number, default: null },

  /* Offsets configurables (en meses antes de la fecha de vencimiento) */
  meses_inicio_antes_venc: {
    type: Number,
    default: null,
  },
  meses_doc_par_antes_venc: {
    type: Number,
    default: null,
  },
  meses_digitacion_antes_venc: {
    type: Number,
    default: null,
  },
  meses_radicado_antes_venc: {
    type: Number,
    default: null,
  },

  /* ── Fechas calculadas a partir de la resolución vigente del programa ──
     fecha_vencimiento = fecha_resolucion + duracion_resolucion (en meses)
     Las demás se calculan X meses antes del vencimiento.
     Se guardan para permitir ajustes manuales si es necesario. */

  fecha_vencimiento: {
    type: String,   // YYYY-MM-DD — calculada o editada manualmente
    default: null,
  },
  fecha_inicio: {
    type: String,   // Inicio del proceso (alerta temprana)
    default: null,
  },
  fecha_documento_par: {
    type: String,   // Fecha límite documento para lectura del par
    default: null,
  },
  fecha_digitacion_saces: {
    type: String,   // Fecha límite digitación en SACES
    default: null,
  },
  fecha_radicado_men: {
    type: String,   // Fecha límite radicado en el MEN
    default: null,
  },
  /* Fechas adicionales específicas de Acreditación Voluntaria (AV) */
  fecha_envio_pm_vicerrectoria: {
    type: String,   // Envío informe plan de mejoramiento a Vicerrectoría (manual)
    default: null,
  },
  fecha_entrega_pm_cna: {
    type: String,   // Entrega plan de mejoramiento al CNA (≈ +6 meses acto admvo)
    default: null,
  },
  fecha_envio_avance_vicerrectoria: {
    type: String,   // Envío informe de avance a Vicerrectoría (manual)
    default: null,
  },
  fecha_radicacion_avance_cna: {
    type: String,   // Radicación ante CNA informe de avance (≈ mitad vigencia)
    default: null,
  },

  /**
   * RC «Registro calificado de oficio» creado tras cierre AV con vigencia de gracia
   * (programa.av_rc_oficio_pendiente al crear). Gestión liviana en front.
   */
  rc_oficio_contexto: {
    type: String,
    enum: ['post_av_gracia', null],
    default: null,
  },
  /** Copia del RC en vigencia transitoria (gracia) antes de registrar el oficio. */
  rc_gracia_vigente_snapshot: {
    type: new mongoose.Schema(
      {
        codigo_resolucion:   { type: String, default: null },
        fecha_resolucion:    { type: String, default: null },
        fecha_vencimiento:   { type: String, default: null },
        duracion_resolucion: { type: Number, default: null },
        link_documento:      { type: String, default: null },
      },
      { _id: false },
    ),
    default: null,
  },
},
{
  versionKey: false,
  timestamps: true,
});

module.exports = mongoose.model('processes', processSchema);
