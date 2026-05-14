const mongoose = require("mongoose");

const sheetDataSchema = new mongoose.Schema(
  {
    name: { type: String },
    headers: [{ type: String }],
    rows: { type: mongoose.Schema.Types.Mixed, default: [] },
  },
  { _id: false }
);

const historicoDocentesSchema = new mongoose.Schema(
  {
    file_name: { type: String },
    uploaded_by: { type: Object },
    drive_file_id: { type: String },
    drive_file_link: { type: String },
    drive_file_download: { type: String },
    sheets: [sheetDataSchema],
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("HistoricoDocentes", historicoDocentesSchema);
