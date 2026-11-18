const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Bases externas del módulo KPI (SPADIES u otras). Se cargan solo para llenar
// las plantillas KPI junto con la información de Consulta de Información. Sus
// filas se guardan por bloques en historico_row_chunks (archivo = _id de la
// base), igual que los archivos grandes de Consulta de Información.
const kpiBaseSheetSchema = new Schema(
  {
    name: { type: String },
    headers: [{ type: String }],
    totalRows: { type: Number, default: 0 },
    // Hoja generada al cargar: las columnas de período (1998-1, 1998-2…) de
    // otra hoja convertidas en filas PERIODO / VALOR.
    derived_from: { type: String, default: null },
  },
  { _id: false }
);

const kpiBaseSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    file_name: { type: String, required: true, trim: true },
    drive_file_id: { type: String, default: "" },
    drive_file_link: { type: String, default: "" },
    uploaded_by: { type: String, default: "" },
    storage: { type: String, default: "chunked" },
    sheets: { type: [kpiBaseSheetSchema], default: [] },
  },
  {
    versionKey: false,
    timestamps: true,
  }
);

module.exports = mongoose.model("kpiBases", kpiBaseSchema);
