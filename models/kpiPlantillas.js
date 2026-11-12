const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Plantillas Excel del módulo KPI. Cada una se llena con la información que
// los productores cargaron en las plantillas publicadas del sistema.
const kpiPlantillaSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
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
    last_run_at: {
      type: Date,
      required: false,
    },
    last_run_by: {
      type: String,
      default: "",
    },
  },
  {
    versionKey: false,
    timestamps: true,
  }
);

module.exports = mongoose.model("kpiPlantillas", kpiPlantillaSchema);
