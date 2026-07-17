const mongoose = require("mongoose");

const sheetDataSchema = new mongoose.Schema(
  {
    name: { type: String },
    headers: [{ type: String }],
    rows: { type: mongoose.Schema.Types.Mixed, default: [] },
  },
  { _id: false }
);

const anexoSchema = new mongoose.Schema(
  {
    file_name: { type: String, required: true },
    uploaded_by: { type: Object },
    pdf_data: { type: Buffer },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const historicoDocentesSchema = new mongoose.Schema(
  {
    file_name: { type: String },
    uploaded_by: { type: Object },
    drive_file_id: { type: String },
    drive_file_link: { type: String },
    drive_file_download: { type: String },
    file_type: { type: String, enum: ['excel', 'pdf'], default: 'excel' },
    excel_data: { type: Buffer, default: null },
    pdf_data: { type: Buffer, default: null },
    sheets: [sheetDataSchema],
    anexos: { type: [anexoSchema], default: [] },
    category: { type: String, enum: ['snies', 'plantillas', 'informes'], default: 'snies' },
    period: { type: mongoose.Schema.Types.ObjectId, ref: 'periods', default: null },
    // Ámbito/dimensión al que pertenece el archivo (opcional): permite
    // consultar Plantillas/Informes agrupados por ámbito. Los archivos
    // subidos antes de esta funcionalidad quedan sin ámbito (null) y siguen
    // apareciendo en la biblioteca general sin filtrar.
    dimension: { type: mongoose.Schema.Types.ObjectId, ref: 'dimensions', default: null },
    // Si este archivo se generó automáticamente al hacer el envío final a
    // SNIES de una plantilla publicada, referencia esa plantilla publicada —
    // permite reemplazar (upsert) la copia existente en reenvíos, en vez de
    // acumular una nueva por cada envío. Los archivos subidos manualmente por
    // un administrador no tienen este campo (null).
    source_published_template: { type: mongoose.Schema.Types.ObjectId, ref: 'publishedTemplates', default: null },
    // Si este archivo es una copia de otro archivo de esta misma colección
    // (ej. clonar el Histórico Docentes SNIES dentro de un ámbito como
    // Plantilla), referencia el archivo original — permite reemplazar la
    // copia si se vuelve a agregar, en vez de duplicarla.
    cloned_from: { type: mongoose.Schema.Types.ObjectId, ref: 'HistoricoDocentes', default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("HistoricoDocentes", historicoDocentesSchema);
