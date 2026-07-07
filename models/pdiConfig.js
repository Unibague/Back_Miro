const mongoose = require('mongoose');

// Documento singleton — siempre existe uno solo con _id fijo
const SINGLETON_ID = 'pdi-config-v1';

const pdiConfigSchema = new mongoose.Schema({
    _id:          { type: String, default: SINGLETON_ID },
    nombre:       { type: String, default: 'PDI 2026–2029' },
    descripcion:  { type: String, default: 'Proyecto de Desarrollo Institucional' },
    anio_inicio:  { type: Number, default: 2026 },
    anio_fin:     { type: Number, default: 2029 },
    // Texto libre para encabezados y reportes
    lema:         { type: String, default: 'Tejiendo futuros: soñar, actuar y transformar juntos' },
    // Estructura planeada del PDI (0 = sin definir)
    num_macroproyectos:      { type: Number, default: 0, min: 0 },
    proyectos_por_macro:     { type: Number, default: 0, min: 0 },
    acciones_por_proyecto:   { type: Number, default: 0, min: 0 },
    indicadores_por_accion:  { type: Number, default: 0, min: 0 },
}, {
    versionKey: false,
    timestamps: true,
    _id: false,   // evita que mongoose genere uno nuevo
});

module.exports = mongoose.model('pdiConfig', pdiConfigSchema);
module.exports.SINGLETON_ID = SINGLETON_ID;
