const mongoose = require('mongoose');

const pdiProyectoSchema = new mongoose.Schema({
    codigo:           { type: String, required: true },
    nombre:           { type: String, required: true },
    peso:             { type: Number, required: true, min: 0, max: 100 },
    avance:           { type: Number, default: 0, min: 0, max: 100 },
    formulador:       { type: String, required: true },
    macroproyecto_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'pdiMacroproyecto',
        required: true,
    },
},
{
    versionKey: false,
    timestamps: true,
});

module.exports = mongoose.model('pdiProyecto', pdiProyectoSchema);
