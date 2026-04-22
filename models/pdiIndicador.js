const mongoose = require('mongoose');

const TIPOS_CALCULO = ['acumulado', 'promedio', 'ultimo_valor'];

// Formato sugerido: '2026A', '2026B', '2030A'... pero libre
const metaPeriodoSchema = new mongoose.Schema({
    periodo:                  { type: String, required: true },
    meta:                     { type: mongoose.Schema.Types.Mixed, default: null },
    avance:                   { type: mongoose.Schema.Types.Mixed, default: null },
    presupuesto_ejecutado:    { type: Number, default: 0, min: 0 },
    // Campos cualitativos del reporte de avance por corte
    resultados_alcanzados:    { type: String, default: '' },
    logros:                   { type: String, default: '' },
    alertas:                  { type: String, default: '' },
    justificacion_retrasos:   { type: String, default: '' },
    estado_reporte:           {
        type: String,
        enum: ['Borrador', 'Enviado', 'Aprobado', 'Rechazado'],
        default: 'Borrador',
    },
    fecha_envio:              { type: Date, default: null },
    reportado_por:            { type: String, default: '' },
}, { _id: false });

const evidenciaSchema = new mongoose.Schema({
    nombre_original: { type: String, required: true },
    filename:        { type: String, required: true },
    url:             { type: String, required: true },
    subido_por:      { type: String, default: '' },
    periodo:         { type: String, default: '' },
    descripcion:     { type: String, default: '' },
    fecha_subida:    { type: Date, default: Date.now },
    estado:          { type: String, enum: ['En Revisión', 'Aprobado', 'Rechazado'], default: 'En Revisión' },
    comentario_revision: { type: String, default: '' },
}, { _id: true });

const pdiIndicadorSchema = new mongoose.Schema({
    codigo:              { type: String, required: true },
    nombre:              { type: String, required: true },
    indicador_resultado: { type: String, default: '' },
    peso:                { type: Number, required: true, min: 0, max: 100 },
    avance:              { type: Number, default: 0 },   // % avance total calculado
    tipo_seguimiento:    { type: String, default: '' },
    fecha_seguimiento:   { type: String, default: '' },
    tipo_calculo:        { type: String, enum: TIPOS_CALCULO, default: 'promedio' },
    meta_final_2029:     { type: mongoose.Schema.Types.Mixed, default: null },
    entregable:          { type: String, default: '' },
    presupuesto:         { type: Number, default: 0, min: 0 },
    presupuesto_ejecutado: { type: Number, default: 0, min: 0 },
    responsable:         { type: String, default: '' },
    responsable_email:   { type: String, default: '' },
    fecha_inicio:        { type: String, default: null },
    fecha_fin:           { type: String, default: null },
    observaciones:       { type: String, default: '' },
    periodos:            { type: [metaPeriodoSchema], default: [] },
    avances_por_anio:    { type: mongoose.Schema.Types.Mixed, default: {} },
    avance_total_real:   { type: mongoose.Schema.Types.Mixed, default: null }, // (avance / meta_final_2029) * 100
    evidencias:          { type: [evidenciaSchema], default: [] },
    accion_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'pdiAccionEstrategica',
        required: true,
    },
},
{
    versionKey: false,
    timestamps: true,
});

module.exports = mongoose.model('pdiIndicador', pdiIndicadorSchema);
module.exports.TIPOS_CALCULO = TIPOS_CALCULO;
