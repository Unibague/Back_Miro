const mongoose = require('mongoose');

const pqrSchema = new mongoose.Schema(
  {
    nombre_solicitud:      { type: String, required: true },
    programa_id:           { type: mongoose.Schema.Types.ObjectId, ref: 'programs', default: null },
    fecha_radicacion:      { type: String, default: null },
    hora:                  { type: String, default: null },
    numero_radicado:       { type: String, default: null },
    medio_realizado:       { type: String, default: null },
    fecha_respuesta:       { type: String, default: null },
    observacion_respuesta: { type: String, default: null },
    cedula_encargado:     { type: String, default: null },
    cerrado:               { type: Boolean, default: false },
    enlaces_respuesta:     { type: [{ nombre: String, url: String, _id: false }], default: [] },
    importacion_fuentes:   { type: [{ hoja: String, fila: Number, valores: { type: Map, of: String }, _id: false }], default: [] },
    importacion_clave:     { type: String, unique: true, sparse: true },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model('pqr', pqrSchema);
