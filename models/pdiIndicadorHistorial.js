const mongoose = require('mongoose');

const pdiIndicadorHistorialSchema = new mongoose.Schema({
    indicador_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'pdiIndicador', required: true },
    indicador_codigo: { type: String, default: '' },
    indicador_nombre: { type: String, default: '' },
    modificado_por:   { type: String, default: '' },
    corte:            { type: String, default: '' }, // corte activo al momento del cambio (ej: '2026A')
    antes:            { type: mongoose.Schema.Types.Mixed, required: true },
    despues:          { type: mongoose.Schema.Types.Mixed, required: true },
    campos_cambiados: { type: [String], default: [] },
}, {
    versionKey: false,
    timestamps: true,
});

module.exports = mongoose.model('pdiIndicadorHistorial', pdiIndicadorHistorialSchema);
