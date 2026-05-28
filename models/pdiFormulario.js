const mongoose = require('mongoose');

const campoPdiSchema = new mongoose.Schema({
    etiqueta:             { type: String, required: true },
    tipo:                 { type: String, enum: ['texto_largo', 'texto_corto', 'archivo_pdf', 'select', 'select_con_otro', 'select_multiple', 'select_multiple_con_otro', 'checkbox'], required: true },
    requerido:            { type: Boolean, default: false },
    descripcion:          { type: String, default: '' },
    orden:                { type: Number, default: 0 },
    min_caracteres:                { type: Number, default: null, min: 0 },
    max_caracteres:                { type: Number, default: null, min: 1 },
    justificacion_descripcion:     { type: String, default: '' },
    justificacion_min_caracteres:  { type: Number, default: null, min: 0 },
    justificacion_max_caracteres:  { type: Number, default: null, min: 1 },
    opciones:                      { type: [String], default: [] },
    condicional_campo_id: { type: String, default: null },
    condicional_valor:    { type: String, default: null },
}, { _id: true });

const pdiFormularioSchema = new mongoose.Schema({
    nombre:       { type: String, required: true },
    descripcion:  { type: String, default: '' },
    activo:       { type: Boolean, default: true },
    // Asociación: indicador o acción (solo uno de los dos)
    alcance:      { type: String, enum: ['indicador', 'general'], default: 'indicador' },
    indicador_id: { type: mongoose.Schema.Types.ObjectId, ref: 'pdiIndicador', default: null },
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
