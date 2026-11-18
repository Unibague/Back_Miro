const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Carpetas del módulo KPI para organizar las plantillas. Cada carpeta
// pertenece a un período.
const kpiCarpetaSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    period: {
      type: Schema.Types.ObjectId,
      ref: "periods",
      required: true,
    },
    created_by: {
      type: String,
      default: "",
    },
  },
  {
    versionKey: false,
    timestamps: true,
  }
);

module.exports = mongoose.model("kpiCarpetas", kpiCarpetaSchema);
