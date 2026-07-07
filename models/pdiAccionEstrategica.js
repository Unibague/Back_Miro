const mongoose = require('mongoose');

const pdiAccionEstrategicaSchema = new mongoose.Schema({
    codigo:              { type: String, required: true },
    nombre:              { type: String, required: true },
    alcance:             { type: String, default: '' },
    responsables: [{
        nombre: { type: String, default: '' },
        email: { type: String, default: '' }
    }],
    // Deprecated - mantener para compatibilidad backwards
    responsable:         { type: String, default: '' },
    responsable_email:   { type: String, default: '' },
    num_indicadores:     { type: Number, default: 0 },
    peso:                { type: Number, required: true, min: 0, max: 100 },
    avance:              { type: Number, default: 0, min: 0, max: 100 },
    fecha_inicio:        { type: String, default: null },
    fecha_fin:           { type: String, default: null },
    presupuesto:                    { type: Number, default: 0 },
    presupuesto_ejecutado:          { type: Number, default: 0 },
    fecha_pago:                     { type: String, default: '' },
    gasto:                          { type: Number, default: 0 },
    inversion:                      { type: Number, default: 0 },
    presupuesto_por_anio:           { type: Map, of: Number, default: {} },
    presupuesto_ejecutado_por_anio: { type: Map, of: Number, default: {} },
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
