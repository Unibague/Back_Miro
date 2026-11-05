const mongoose = require('mongoose');

// Un cambio detectado en una sincronización de dependencias
const cambioSchema = new mongoose.Schema({
    tipo: {
        type: String,
        enum: ['creada', 'reactivada', 'modificada', 'desactivada', 'reemplazada'],
        required: true,
    },
    dep_code:        { type: String, required: true },
    nombre:          { type: String, default: '' },
    // Solo para 'modificada': campo que cambió y sus valores
    campo:           { type: String, default: '' },
    antes:           { type: String, default: null },
    despues:         { type: String, default: null },
    // Solo para 'reemplazada': dependencia nueva que tomó su lugar
    reemplazada_por: { type: String, default: null },
    reemplazada_por_nombre: { type: String, default: null },
}, { _id: false });

const dependencySyncLogSchema = new mongoose.Schema({
    fecha:          { type: Date, default: Date.now },
    origen:         { type: String, enum: ['dependencias', 'usuarios'], default: 'dependencias' },
    ejecutado_por:  { type: String, default: '' },
    total_recibidas: { type: Number, default: 0 },
    resumen: {
        creadas:      { type: Number, default: 0 },
        reactivadas:  { type: Number, default: 0 },
        modificadas:  { type: Number, default: 0 },
        desactivadas: { type: Number, default: 0 },
        reemplazadas: { type: Number, default: 0 },
    },
    cambios:        { type: [cambioSchema], default: [] },
}, {
    versionKey: false,
});

dependencySyncLogSchema.index({ fecha: -1 });

module.exports = mongoose.model('dependencySyncLogs', dependencySyncLogSchema);
