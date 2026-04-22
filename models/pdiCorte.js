const mongoose = require('mongoose');

const pdiCorteSchema = new mongoose.Schema({
    nombre:      { type: String, required: true, unique: true }, // ej: "2026A", "2026B"
    descripcion: { type: String, default: '' },
    activo:      { type: Boolean, default: true },
    orden:       { type: Number, default: 0 }, // para ordenar en el select
    fecha_inicio: { type: Date, default: null }, // inicio del periodo de calificación
    fecha_fin:    { type: Date, default: null }, // cierre del periodo de calificación
}, {
    versionKey: false,
    timestamps: true,
});

module.exports = mongoose.model('pdiCorte', pdiCorteSchema);
