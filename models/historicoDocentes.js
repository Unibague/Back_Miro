const mongoose = require("mongoose");

const sheetDataSchema = new mongoose.Schema(
  {
    name: { type: String },
    headers: [{ type: String }],
    rows: { type: mongoose.Schema.Types.Mixed, default: [] },
    // Solo en archivos con storage "chunked": las filas están en
    // historico_row_chunks y aquí queda el conteo y los años disponibles.
    totalRows: { type: Number },
    availableYears: { type: [String], default: undefined },
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
    // Archivos subidos desde la carga por bloques: el original va a GridFS
    // (bucket historico_files) y las filas a historico_row_chunks, sin el
    // límite de 16 MB por documento. Los registros anteriores siguen con
    // excel_data/pdf_data y las filas dentro de "sheets" (storage "inline").
    storage: { type: String, enum: ['inline', 'chunked'], default: 'inline' },
    file_id: { type: mongoose.Schema.Types.ObjectId, default: null },
    // Dueño de los bloques de filas cuando este registro es una copia
    // (clonado a otro ámbito). null = los bloques son de este mismo registro.
    rows_source: { type: mongoose.Schema.Types.ObjectId, default: null },
    // Estado del procesamiento en segundo plano de la carga.
    status: { type: String, enum: ['procesando', 'listo', 'error'], default: 'listo' },
    progress: {
      rows: { type: Number, default: 0 },
      step: { type: String, default: null },
      heartbeat: { type: Date, default: null },
    },
    error_message: { type: String, default: null },
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
    // Cifras calculadas UNA sola vez al guardar el archivo (ej. total de
    // matriculados), para que el Tablero las lea tal cual sin recontar. Ver
    // services/historicoResumen.js. null = aún no calculado.
    resumen: { type: mongoose.Schema.Types.Mixed, default: null },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("HistoricoDocentes", historicoDocentesSchema);
