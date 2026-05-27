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
    drive_file_id:   { type: String, default: '' },
    drive_web_view_link: { type: String, default: '' },
    drive_web_content_link: { type: String, default: '' },
}, { _id: true });

const documentoEvidenciaSchema = new mongoose.Schema({
    nombre_original: { type: String, default: '' },
    filename:        { type: String, default: '' },
    url:             { type: String, default: '' },
    mimetype:        { type: String, default: '' },
    size:            { type: Number, default: 0 },
    drive_file_id:   { type: String, default: '' },
    drive_web_view_link: { type: String, default: '' },
    drive_web_content_link: { type: String, default: '' },
    fecha_subida:    { type: Date, default: Date.now },
}, { _id: true });

const pdiFormularioRespuestaSchema = new mongoose.Schema({
    formulario_id:  { type: mongoose.Schema.Types.ObjectId, ref: 'pdiFormulario', required: true },
    indicador_id:   { type: mongoose.Schema.Types.ObjectId, ref: 'pdiIndicador', default: null },
    respondido_por: { type: String, default: '' },           // email del responsable
    corte:          { type: String, default: '' },           // ej: '2026A'
    respuestas:     { type: [respuestaCampoSchema], default: [] },
    estado:         { type: String, enum: ['Borrador', 'Enviado'], default: 'Borrador' },
    fecha_envio:    { type: Date, default: null },
    word_filename:  { type: String, default: '' },
    word_url:       { type: String, default: '' },
    word_nombre_original: { type: String, default: '' },
    word_drive_file_id: { type: String, default: '' },
    word_drive_web_view_link: { type: String, default: '' },
    word_drive_web_content_link: { type: String, default: '' },
    documento_nombre_original: { type: String, default: '' },
    documento_filename:        { type: String, default: '' },
    documento_url:             { type: String, default: '' },
    documento_mimetype:        { type: String, default: '' },
    documento_size:            { type: Number, default: 0 },
    documento_drive_file_id:   { type: String, default: '' },
    documento_drive_web_view_link: { type: String, default: '' },
    documento_drive_web_content_link: { type: String, default: '' },
    documentos:                { type: [documentoEvidenciaSchema], default: [] },
    // Flujo de aval del lider de macroproyecto
    estado_aval:        { type: String, enum: ['Pendiente', 'Aprobado', 'Rechazado'], default: null },
    lider_email_aval:   { type: String, default: '' },
    aval_por:           { type: String, default: '' },
    aval_comentario:    { type: String, default: '' },
    aval_razones:       { type: [String], default: [] },
    aval_otro_cual:     { type: String, default: '' },
    aval_fecha:         { type: Date, default: null },
    // Flujo de aval de Planeación (segundo nivel, solo cuando el líder aprueba)
    aval_planeacion:             { type: String, enum: ['Pendiente', 'Validado', 'Devuelto'], default: null },
    aval_planeacion_por:         { type: String, default: '' },
    aval_planeacion_comentario:  { type: String, default: '' },
    aval_planeacion_fecha:       { type: Date, default: null },
}, {
    versionKey: false,
    timestamps: true,
});

pdiFormularioRespuestaSchema.index(
    { formulario_id: 1, indicador_id: 1, respondido_por: 1, corte: 1 },
    { unique: true }
);

module.exports = mongoose.model('pdiFormularioRespuesta', pdiFormularioRespuestaSchema);
