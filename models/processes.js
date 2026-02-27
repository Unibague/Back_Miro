const mongoose = require('mongoose');

const processSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  program_code: {
    type: String,
    required: true,
  },
  tipo_proceso: {
    type: String,
    enum: ['RC', 'AV', 'PM'],
    required: true,
  },
  fase_actual: {
    type: Number,
    min: 0,
    max: 6,
    default: 0,
  },
  observaciones: {
    type: String,
    default: '',
  },
  /* Condición (RC: 1-9) o Factor (AV: 1-12) asociado al proceso */
  condicion: {
    type: Number,
    default: null,
  },

  /* Observaciones por fecha */
  obs_vencimiento:      { type: String, default: '' },
  obs_inicio:           { type: String, default: '' },
  obs_documento_par:    { type: String, default: '' },
  obs_digitacion_saces: { type: String, default: '' },
  obs_radicado_men:     { type: String, default: '' },

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
},
{
  versionKey: false,
  timestamps: true,
});

module.exports = mongoose.model('processes', processSchema);
