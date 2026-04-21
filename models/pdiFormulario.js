const mongoose = require('mongoose');

const campoPdiSchema = new mongoose.Schema({
    etiqueta:     { type: String, required: true },           // nombre visible del campo
    tipo:         { type: String, enum: ['texto_largo', 'archivo_pdf'], required: true },
    requerido:    { type: Boolean, default: false },
    descripcion:  { type: String, default: '' },              // ayuda/placeholder
    orden:        { type: Number, default: 0 },
}, { _id: true });

const pdiFormularioSchema = new mongoose.Schema({
    nombre:       { type: String, required: true },
    descripcion:  { type: String, default: '' },
    activo:       { type: Boolean, default: true },
    // Asociación: indicador o acción (solo uno de los dos)
    indicador_id: { type: mongoose.Schema.Types.ObjectId, ref: 'pdiIndicador', required: true },
    campos:       { type: [campoPdiSchema], default: [] },
    creado_por:   { type: String, default: '' },
}, {
    versionKey: false,
    timestamps: true,
});

pdiFormularioSchema.index(
    { indicador_id: 1 },
    { unique: true, partialFilterExpression: { indicador_id: { $exists: true, $ne: null } } }
);

module.exports = mongoose.model('pdiFormulario', pdiFormularioSchema);
