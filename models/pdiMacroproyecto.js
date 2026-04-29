const mongoose = require('mongoose');

const pdiMacroproyectoSchema = new mongoose.Schema({
    codigo: { type: String, required: true, unique: true },
    nombre: { type: String, required: true },
    lider:       { type: String, default: '' },
    lider_email: { type: String, default: '' },
    peso:   { type: Number, required: true, min: 0, max: 100 },
    avance: { type: Number, default: 0, min: 0, max: 100 },
    presupuesto:          { type: Number, default: 0 },
    presupuesto_ejecutado: { type: Number, default: 0 },
},
{
    versionKey: false,
    timestamps: true,
});

module.exports = mongoose.model('pdiMacroproyecto', pdiMacroproyectoSchema);
