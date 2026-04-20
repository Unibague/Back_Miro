const mongoose = require('mongoose');

// Cada respuesta a un campo del formulario
const respuestaCampoSchema = new mongoose.Schema({
    campo_id:        { type: mongoose.Schema.Types.ObjectId, required: true },
    etiqueta:        { type: String, default: '' },
    tipo:            { type: String, default: '' },
    // Para texto_largo
    valor_texto:     { type: String, default: '' },
    // Para archivo_pdf
    nombre_original: { type: String, default: '' },
    filename:        { type: String, default: '' },
    url:             { type: String, default: '' },
}, { _id: true });

const pdiFormularioRespuestaSchema = new mongoose.Schema({
    formulario_id:  { type: mongoose.Schema.Types.ObjectId, ref: 'pdiFormulario', required: true },
    respondido_por: { type: String, default: '' },           // email del responsable
    corte:          { type: String, default: '' },           // ej: '2026A'
    respuestas:     { type: [respuestaCampoSchema], default: [] },
    estado:         { type: String, enum: ['Borrador', 'Enviado'], default: 'Borrador' },
    fecha_envio:    { type: Date, default: null },
}, {
    versionKey: false,
    timestamps: true,
});

module.exports = mongoose.model('pdiFormularioRespuesta', pdiFormularioRespuestaSchema);
