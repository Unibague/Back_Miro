const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Plantillas de Cuadros Maestros CNA. Solo existen dos: la de programa y la
// de institución. Subir una nueva reemplaza el archivo de la existente.
const cnaPlantillaSchema = new Schema(
  {
    tipo: {
      type: String,
      enum: ["programa", "institucion"],
      required: true,
      unique: true,
    },
    file_name: {
      type: String,
      required: true,
      trim: true,
    },
    drive_file_id: {
      type: String,
      required: true,
    },
    drive_file_link: {
      type: String,
      default: "",
    },
    uploaded_by: {
      type: String,
      default: "",
    },
  },
  {
    versionKey: false,
    timestamps: true,
  }
);

module.exports = mongoose.model("cnaPlantillas", cnaPlantillaSchema);
