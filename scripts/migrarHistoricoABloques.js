/**
 * Migración única: pasa los archivos antiguos de Consulta de Información
 * (colección historicodocentes, storage "inline") al almacenamiento por
 * bloques: el binario (excel_data/pdf_data) va a GridFS y las filas de
 * "sheets" a historico_row_chunks. El registro principal se conserva (con
 * nombre, ámbito, período, resumen, anexos...) pero queda liviano.
 *
 * Seguridad:
 *  - Sin --aplicar solo muestra lo que haría (no escribe nada).
 *  - Un archivo a la vez: copia, VERIFICA (filas y bytes) y solo entonces
 *    quita los datos pesados del registro. Si algo falla, borra lo copiado y
 *    deja el registro como estaba.
 *  - Se puede correr varias veces: salta los registros ya migrados y limpia
 *    los restos de una ejecución interrumpida.
 *  - No toca las copias generadas desde Plantillas (source_published_template):
 *    se reescriben solas en cada reenvío de la plantilla.
 *  - Los anexos no se migran (quedan igual).
 *
 * Uso:
 *   node scripts/migrarHistoricoABloques.js            → simulación
 *   node scripts/migrarHistoricoABloques.js --aplicar  → migra
 */
require("dotenv").config();
const mongoose = require("mongoose");
const HistoricoDocentes = require("../models/historicoDocentes");
const HistoricoRowChunk = require("../models/historicoRowChunks");
const { buildResumenArchivo } = require("../services/historicoResumen");
const { saveBufferToGridFS, writeRowsToChunks, getGridFSFileInfo } = require("../services/historicoStorage");

const APPLY = process.argv.includes("--aplicar");
const EXCEL_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_CONTENT_TYPE = "application/pdf";
const BUCKET_NAME = "historico_files";

const CANDIDATES = { storage: { $ne: "chunked" }, source_published_template: null };

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// En lean() los Buffer llegan como Binary de BSON.
const toBuffer = (value) => {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value.buffer) return Buffer.from(value.buffer);
  return Buffer.from(value);
};

const gridFSFiles = () => mongoose.connection.db.collection(`${BUCKET_NAME}.files`);
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });

const removeCopies = async (docId) => {
  await HistoricoRowChunk.deleteMany({ archivo: docId });
  const leftovers = await gridFSFiles().find({ "metadata.migrated_from": docId }).project({ _id: 1 }).toArray();
  for (const file of leftovers) await bucket().delete(file._id);
};

const countChunkRows = async (docId, sheetIndex) => {
  const [result] = await HistoricoRowChunk.aggregate([
    { $match: { archivo: docId, sheet: sheetIndex } },
    { $group: { _id: null, rows: { $sum: { $size: "$rows" } } } },
  ]);
  return result?.rows || 0;
};

const migrateOne = async (id) => {
  const doc = await HistoricoDocentes.findById(id).lean();
  if (!doc || doc.storage === "chunked") return { status: "saltado", reason: "ya migrado" };

  const sheets = doc.sheets || [];
  if (sheets.some((sheet) => (sheet.rows || []).some((row) => !Array.isArray(row)))) {
    return { status: "saltado", reason: "filas con formato no estándar (se deja igual)", file_name: doc.file_name, category: doc.category || "snies" };
  }

  const isPdf = doc.file_type === "pdf";
  const binary = toBuffer(isPdf ? doc.pdf_data : doc.excel_data);
  const totalRows = sheets.reduce((sum, sheet) => sum + (sheet.rows || []).length, 0);
  const info = { file_name: doc.file_name, category: doc.category || "snies", rows: totalRows, binary: binary ? binary.length : 0 };
  if (!APPLY) return { status: "pendiente", ...info };

  await removeCopies(doc._id);
  try {
    let fileId = null;
    if (binary) {
      fileId = await saveBufferToGridFS(binary, doc.file_name || "archivo", isPdf ? PDF_CONTENT_TYPE : EXCEL_CONTENT_TYPE, { migrated_from: doc._id });
      const stored = await getGridFSFileInfo(fileId);
      if (!stored || stored.length !== binary.length) throw new Error("el archivo en GridFS no coincide con el original");
    }

    const newSheets = [];
    for (let index = 0; index < sheets.length; index++) {
      const rows = sheets[index].rows || [];
      const written = await writeRowsToChunks(doc._id, index, sheets[index].headers || [], rows);
      const inChunks = await countChunkRows(doc._id, index);
      if (written.totalRows !== rows.length || inChunks !== rows.length) {
        throw new Error(`hoja "${sheets[index].name}": ${rows.length} filas originales, ${inChunks} en bloques`);
      }
      newSheets.push({
        name: sheets[index].name,
        headers: sheets[index].headers || [],
        rows: [],
        totalRows: written.totalRows,
        availableYears: written.availableYears,
      });
    }

    // El resumen (ej. total de matriculados) se calcula ahora si faltaba: sin
    // las filas en el registro, el Tablero ya no podría calcularlo después.
    const resumen = doc.resumen || (isPdf ? null : buildResumenArchivo(doc.file_name, sheets));

    // Solo se actualiza si nadie modificó el registro mientras se copiaba.
    const result = await HistoricoDocentes.updateOne(
      { _id: doc._id, storage: { $ne: "chunked" }, updatedAt: doc.updatedAt },
      {
        $set: {
          storage: "chunked",
          file_id: fileId,
          status: "listo",
          sheets: newSheets,
          resumen,
          excel_data: null,
          pdf_data: null,
        },
      },
      { timestamps: false }
    );
    if (result.modifiedCount !== 1) throw new Error("el registro cambió durante la migración; vuelve a correr el script");
    return { status: "migrado", ...info };
  } catch (error) {
    await removeCopies(doc._id);
    return { status: "error", reason: error.message, ...info };
  }
};

async function main() {
  await mongoose.connect(process.env.DB_URI);
  await HistoricoRowChunk.init();
  console.log(APPLY ? "MODO APLICAR: se migrarán los registros.\n" : "SIMULACIÓN: no se escribe nada. Usa --aplicar para migrar.\n");

  const sizes = await HistoricoDocentes.aggregate([
    { $match: CANDIDATES },
    { $project: { size: { $bsonSize: "$$ROOT" } } },
  ]);
  const sizeById = new Map(sizes.map((s) => [String(s._id), s.size]));
  const totalSize = sizes.reduce((sum, s) => sum + s.size, 0);
  const skippedTemplates = await HistoricoDocentes.countDocuments({ storage: { $ne: "chunked" }, source_published_template: { $ne: null } });

  console.log(`Registros a migrar: ${sizes.length} (${mb(totalSize)} en total).`);
  console.log(`Copias de Plantillas que no se tocan: ${skippedTemplates}.`);
  console.log(`Durante la migración se necesita libre en disco al menos ~${mb(totalSize)} adicionales.\n`);

  const summary = { migrado: 0, pendiente: 0, saltado: 0, error: 0 };
  for (const { _id } of sizes) {
    const result = await migrateOne(_id);
    summary[result.status] += 1;
    const detail = result.reason ? ` — ${result.reason}` : "";
    const stats = result.rows !== undefined ? ` · ${result.rows} filas · binario ${mb(result.binary)} · registro ${mb(sizeById.get(String(_id)) || 0)}` : "";
    console.log(`[${result.status}] ${_id} ${result.file_name || ""} (${result.category || ""})${stats}${detail}`);
  }

  console.log("\nResumen:", summary);
  await mongoose.disconnect();
  if (summary.error > 0) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error("Error en la migración:", error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
