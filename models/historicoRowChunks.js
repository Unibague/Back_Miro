const mongoose = require("mongoose");

// Filas de un archivo de Consulta de Información (HistoricoDocentes) guardadas
// por bloques. Un archivo grande (cientos de miles de filas) no cabe en un
// solo documento de MongoDB (máx. 16 MB), así que sus filas viven aquí y el
// registro principal solo guarda los metadatos de cada hoja. Ver
// services/historicoStorage.js.
const historicoRowChunkSchema = new mongoose.Schema(
  {
    // _id del registro HistoricoDocentes dueño de las filas (las copias
    // clonadas a otro ámbito reutilizan los bloques del original).
    archivo: { type: mongoose.Schema.Types.ObjectId, required: true },
    sheet: { type: Number, required: true },
    chunk: { type: Number, required: true },
    // Rango de filas [start, end) dentro de la hoja, para paginar sin leer
    // los bloques anteriores.
    start: { type: Number, required: true },
    end: { type: Number, required: true },
    // Valores distintos de la columna AÑO en este bloque, para filtrar por
    // año sin recorrer todos los bloques.
    years: { type: [String], default: [] },
    rows: { type: mongoose.Schema.Types.Mixed, default: [] },
  },
  { versionKey: false }
);

historicoRowChunkSchema.index({ archivo: 1, sheet: 1, chunk: 1 }, { unique: true });
historicoRowChunkSchema.index({ archivo: 1, sheet: 1, start: 1 });
historicoRowChunkSchema.index({ archivo: 1, sheet: 1, years: 1 });

module.exports = mongoose.model("HistoricoRowChunk", historicoRowChunkSchema, "historico_row_chunks");
