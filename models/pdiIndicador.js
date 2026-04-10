const mongoose = require('mongoose');

const TIPOS_CALCULO = ['acumulado', 'promedio', 'ultimo_valor'];

// Formato sugerido: '2026A', '2026B', '2030A'... pero libre
const metaPeriodoSchema = new mongoose.Schema({
    periodo: { type: String, required: true },
    meta:    { type: mongoose.Schema.Types.Mixed, default: null },
    avance:  { type: Number, default: null },
}, { _id: false });

const evidenciaSchema = new mongoose.Schema({
    nombre_original: { type: String, required: true },
    filename:        { type: String, required: true }, // nombre en disco
    url:             { type: String, required: true }, // URL pública
    subido_por:      { type: String, default: '' },
    periodo:         { type: String, default: '' },    // periodo al que aplica (opcional)
    descripcion:     { type: String, default: '' },
    fecha_subida:    { type: Date, default: Date.now },
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
    responsable:         { type: String, default: '' },
    fecha_inicio:        { type: String, default: null },
    fecha_fin:           { type: String, default: null },
    observaciones:       { type: String, default: '' },
    periodos:            { type: [metaPeriodoSchema], default: [] },
    avances_por_anio:    { type: Map, of: Number, default: {} },
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
