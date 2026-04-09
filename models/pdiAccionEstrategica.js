const mongoose = require('mongoose');

const pdiAccionEstrategicaSchema = new mongoose.Schema({
    codigo:      { type: String, required: true },
    nombre:      { type: String, required: true },
    alcance:     { type: String, default: '' },
    peso:        { type: Number, required: true, min: 0, max: 100 },
    avance:      { type: Number, default: 0, min: 0, max: 100 },
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
