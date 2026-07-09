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
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("HistoricoDocentes", historicoDocentesSchema);
