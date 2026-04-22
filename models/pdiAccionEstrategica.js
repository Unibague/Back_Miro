const mongoose = require('mongoose');

const pdiAccionEstrategicaSchema = new mongoose.Schema({
    codigo:              { type: String, required: true },
    nombre:              { type: String, required: true },
    alcance:             { type: String, default: '' },
    responsable:         { type: String, default: '' },
    responsable_email:   { type: String, default: '' },
    peso:                { type: Number, required: true, min: 0, max: 100 },
    avance:              { type: Number, default: 0, min: 0, max: 100 },
    fecha_inicio:        { type: String, default: null },
    fecha_fin:           { type: String, default: null },
    presupuesto:         { type: Number, default: 0 },          // Presupuesto asignado (COP)
    presupuesto_ejecutado: { type: Number, default: 0 },        // Presupuesto ejecutado (COP)
    proyecto_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'pdiProyecto',
        required: true,
    },
},
{
    versionKey: false,
    timestamps: true,
});

module.exports = mongoose.model('pdiAccionEstrategica', pdiAccionEstrategicaSchema);
