const mongoose = require('mongoose');

const pdiProyectoSchema = new mongoose.Schema({
    codigo:              { type: String, required: true },
    nombre:              { type: String, required: true },
    descripcion:         { type: String, default: '' },
    num_acciones:        { type: Number, default: 0 },
    peso:                { type: Number, required: true, min: 0, max: 100 },
    avance:              { type: Number, default: 0, min: 0, max: 100 },
    formulador:          { type: String, required: true },
    responsable:         { type: String, default: '' },
    responsable_email:   { type: String, default: '' },
    fecha_inicio:        { type: String, default: null },
    fecha_fin:           { type: String, default: null },
    presupuesto:         { type: Number, default: 0 },
    presupuesto_ejecutado: { type: Number, default: 0 },
    informe_drive_file_id:      { type: String, default: null },
    informe_drive_web_view_link: { type: String, default: null },
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
