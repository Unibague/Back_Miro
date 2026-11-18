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
    // Período y carpeta en que se organiza la plantilla. Las plantillas
    // anteriores a los períodos quedan sin período hasta que se abre el módulo.
    period: {
      type: Schema.Types.ObjectId,
      ref: "periods",
      default: null,
    },
    folder: {
      type: Schema.Types.ObjectId,
      ref: "kpiCarpetas",
      default: null,
    },
    // Qué fuente llena cada hoja del Excel (la elige el administrador). Las
    // hojas que no están aquí no se tocan. Vacío = emparejamiento automático
    // por encabezados (plantillas configuradas antes de esta opción).
    mapeo: {
      type: [
        new Schema(
          {
            hoja: { type: String, required: true },
            fuente: { type: String, required: true },
            fuente_label: { type: String, default: "" },
          },
          { _id: false }
        ),
      ],
      default: [],
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
