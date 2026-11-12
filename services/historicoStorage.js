// Almacenamiento de archivos grandes de Consulta de Información
// (HistoricoDocentes) sin pasar por el límite de 16 MB por documento de
// MongoDB ni cargar el archivo completo en memoria:
//  - el archivo original se guarda en GridFS (bucket "historico_files");
//  - el Excel/CSV se lee por streaming, fila por fila;
//  - las filas se guardan por bloques en historico_row_chunks.
// Los registros antiguos ("inline", con las filas dentro de "sheets") se
// siguen leyendo igual: las funciones de lectura aceptan ambos formatos.

const fs = require("fs");
const mongoose = require("mongoose");
const ExcelJS = require("exceljs");
const PizZip = require("pizzip");
const { parse: parseCsv } = require("@fast-csv/parse");
const HistoricoRowChunk = require("../models/historicoRowChunks");
const { findMatriculadosSheet, createMatriculadosAccumulator, isMatriculadosFile } = require("./historicoResumen");
const {
  getStudentProgramsByIds,
  isStudentIdHeader,
  normalizeId,
  normalizeHeader: normalizeStudentHeader,
  PROGRAMA_ESTUDIANTE_HEADER,
} = require("./studentsDirectory");

const BUCKET_NAME = "historico_files";
const ROWS_PER_CHUNK = 1000;
// Un bloque también se cierra al llegar a ~4 MB (filas muy anchas), lejos
// del límite de 16 MB por documento.
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const HEADER_SCAN_ROWS = 10;

const getBucket = () =>
  new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET_NAME });

const toObjectId = (id) => (id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(String(id)));

const isChunked = (doc) => doc?.storage === "chunked";

// Dueño de los bloques de filas (las copias clonadas reutilizan los del original).
const rowsKey = (doc) => doc.rows_source || doc._id;

const sheetRowCount = (sheet) =>
  typeof sheet?.totalRows === "number" ? sheet.totalRows : (Array.isArray(sheet?.rows) ? sheet.rows.length : 0);

const normalizeHeader = (h) =>
  (h || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const getCellText = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) {
    const dd = String(value.getUTCDate()).padStart(2, "0");
    const mm = String(value.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = value.getUTCFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  if (Array.isArray(value)) return value.map(getCellText).join(", ");
  if (typeof value === "object") {
    if (Array.isArray(value.richText))
      return value.richText.map((i) => getCellText(i?.text)).join("").trim();
    if (value.text !== undefined) return getCellText(value.text);
    if (value.result !== undefined) return getCellText(value.result);
    if (value.value !== undefined) return getCellText(value.value);
    return "";
  }
  return "";
};

// ── GridFS ────────────────────────────────────────────────────────────────

const saveFileToGridFS = (filePath, filename, contentType) =>
  new Promise((resolve, reject) => {
    const upload = getBucket().openUploadStream(filename, { contentType });
    fs.createReadStream(filePath)
      .on("error", reject)
      .pipe(upload)
      .on("error", reject)
      .on("finish", () => resolve(upload.id));
  });

const saveBufferToGridFS = (buffer, filename, contentType, metadata) =>
  new Promise((resolve, reject) => {
    const upload = getBucket().openUploadStream(filename, { contentType, metadata });
    upload.on("error", reject).on("finish", () => resolve(upload.id));
    upload.end(buffer);
  });

const getGridFSFileInfo = async (fileId) =>
  (await getBucket().find({ _id: toObjectId(fileId) }).limit(1).toArray())[0] || null;

const openGridFSStream = (fileId) => getBucket().openDownloadStream(toObjectId(fileId));

const readGridFSBuffer = (fileId) =>
  new Promise((resolve, reject) => {
    const parts = [];
    openGridFSStream(fileId)
      .on("data", (part) => parts.push(part))
      .on("error", reject)
      .on("end", () => resolve(Buffer.concat(parts)));
  });

const deleteGridFSFile = async (fileId) => {
  try {
    await getBucket().delete(toObjectId(fileId));
  } catch (error) {
    if (!/FileNotFound|File not found/i.test(error?.message || "")) throw error;
  }
};

// ── Escritura por bloques ───────────────────────────────────────────────────

const createSheetWriter = (archivoId, sheetIndex, headers, onChunk) => {
  const yearIndex = headers.findIndex((h) => normalizeHeader(h) === "ano");
  const availableYears = new Set();
  let buffer = [];
  let bufferBytes = 0;
  let chunkYears = new Set();
  let chunkNumber = 0;
  let totalRows = 0;

  const flush = async () => {
    if (buffer.length === 0) return;
    await HistoricoRowChunk.collection.insertOne({
      archivo: archivoId,
      sheet: sheetIndex,
      chunk: chunkNumber,
      start: totalRows - buffer.length,
      end: totalRows,
      years: [...chunkYears],
      rows: buffer,
    });
    chunkNumber += 1;
    buffer = [];
    bufferBytes = 0;
    chunkYears = new Set();
    if (onChunk) await onChunk();
  };

  return {
    async add(row) {
      buffer.push(row);
      totalRows += 1;
      for (const cell of row) bufferBytes += String(cell ?? "").length + 8;
      if (yearIndex >= 0) {
        const year = (row[yearIndex] || "").toString().trim();
        if (year) {
          chunkYears.add(year);
          availableYears.add(year);
        }
      }
      if (buffer.length >= ROWS_PER_CHUNK || bufferBytes >= MAX_CHUNK_BYTES) await flush();
    },
    async finish() {
      await flush();
      return { totalRows, availableYears: [...availableYears].sort() };
    },
  };
};

// Guarda por bloques, tal cual, las filas (arreglos) de una hoja que ya
// están en memoria (usado al migrar registros "inline" antiguos).
const writeRowsToChunks = async (archivoId, sheetIndex, headers, rows) => {
  const writer = createSheetWriter(archivoId, sheetIndex, headers);
  for (const row of rows) await writer.add(row);
  return writer.finish();
};

// Igual criterio que el parser anterior (parseSheetsFromBuffer): la fila de
// encabezados es, entre las 10 primeras, la que tiene más celdas con valor.
const pickHeaderRow = (headRows) => {
  let best = null;
  let maxCells = 0;
  for (const row of headRows) {
    const count = row.values.filter((v) => v !== null && v !== undefined).length;
    if (count > maxCells) {
      maxCells = count;
      best = row;
    }
  }
  return best;
};

const buildHeaders = (headerValues) => {
  const headers = [];
  for (let c = 1; c < headerValues.length; c++) {
    headers[c - 1] = getCellText(headerValues[c]) || `Columna ${c}`;
  }
  while (headers.length > 0 && !headers[headers.length - 1]) headers.pop();
  return headers;
};

const toRowData = (values, headers) => {
  const rowData = [];
  let hasData = false;
  for (let c = 1; c <= headers.length; c++) {
    const val = getCellText(values[c]);
    rowData.push(val);
    if (val) hasData = true;
  }
  return hasData ? rowData : null;
};

// El lector por streaming de ExcelJS necesita que xl/workbook.xml (y las
// cadenas compartidas y estilos) vengan en el zip ANTES de las hojas. Los
// Excel que genera Miró al descargar (y otras herramientas) los dejan al
// final y la lectura falla con "Cannot read properties of undefined
// (reading 'sheets')". Aquí se reescribe el zip en el orden esperado.
const ZIP_FIRST_ENTRIES = [
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels",
  "xl/sharedStrings.xml",
  "xl/styles.xml",
];

const reorderXlsxZip = (filePath) => {
  const source = new PizZip(fs.readFileSync(filePath));
  const target = new PizZip();
  const names = Object.keys(source.files).filter((name) => !source.files[name].dir);
  const ordered = [
    ...ZIP_FIRST_ENTRIES.filter((name) => names.includes(name)),
    ...names.filter((name) => !ZIP_FIRST_ENTRIES.includes(name)),
  ];
  ordered.forEach((name) => target.file(name, source.files[name].asUint8Array(), { binary: true }));
  const orderedPath = `${filePath}.ordenado.xlsx`;
  fs.writeFileSync(orderedPath, target.generate({ type: "nodebuffer", compression: "DEFLATE" }));
  return orderedPath;
};

// Recorre un .xlsx/.xlsm por streaming y guarda sus filas por bloques.
// Devuelve los metadatos de cada hoja ({ name, headers, rows: [], totalRows, availableYears }).
// Si el zip no viene en el orden que necesita el streaming, se reordena y se
// vuelve a leer (descartando lo que alcanzó a guardarse).
const parseExcelToChunks = async (filePath, archivoId, onProgress) => {
  try {
    return await parseExcelStream(filePath, archivoId, onProgress);
  } catch (error) {
    let orderedPath = null;
    try {
      orderedPath = reorderXlsxZip(filePath);
    } catch (_) {
      throw error;
    }
    console.warn("[historicoStorage] El Excel no se pudo leer en su orden original, se reintenta reordenado:", error.message);
    try {
      await HistoricoRowChunk.deleteMany({ archivo: toObjectId(archivoId) });
      return await parseExcelStream(orderedPath, archivoId, onProgress);
    } finally {
      fs.unlink(orderedPath, () => {});
    }
  }
};

const parseExcelStream = async (filePath, archivoId, onProgress) => {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    sharedStrings: "cache",
    // Con estilos se reconocen las celdas de fecha (como en la carga anterior).
    styles: "cache",
    hyperlinks: "ignore",
    worksheets: "emit",
    entries: "emit",
  });

  const sheets = [];
  let processedRows = 0;

  for await (const worksheetReader of reader) {
    const sheetIndex = sheets.length;
    const headRows = [];
    let headers = null;
    let writer = null;

    const addValues = async (values) => {
      const rowData = toRowData(values, headers);
      if (!rowData) return;
      await writer.add(rowData);
      processedRows += 1;
    };

    const startWriter = async () => {
      const headerRow = pickHeaderRow(headRows);
      headers = headerRow ? buildHeaders(headerRow.values) : [];
      writer = createSheetWriter(archivoId, sheetIndex, headers, () => onProgress?.(processedRows));
      for (const row of headRows) {
        if (headerRow && row.number > headerRow.number) await addValues(row.values);
      }
    };

    for await (const row of worksheetReader) {
      if (!writer && row.number <= HEADER_SCAN_ROWS) {
        headRows.push({ number: row.number, values: row.values });
        continue;
      }
      if (!writer) await startWriter();
      await addValues(row.values);
    }
    if (!writer) await startWriter();

    const { totalRows, availableYears } = await writer.finish();
    sheets.push({ name: worksheetReader.name, headers, rows: [], totalRows, availableYears });
  }

  return sheets;
};

// Separador más frecuente en la primera línea (Excel en español exporta con ";").
const detectCsvDelimiter = (filePath) => {
  const fd = fs.openSync(filePath, "r");
  try {
    const sample = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, sample, 0, sample.length, 0);
    const firstLine = sample.toString("utf8", 0, bytes).split(/\r?\n/)[0] || "";
    const candidates = [";", ",", "\t", "|"];
    return candidates
      .map((d) => ({ d, count: firstLine.split(d).length - 1 }))
      .sort((a, b) => b.count - a.count)[0].d;
  } finally {
    fs.closeSync(fd);
  }
};

// Un CSV es una sola hoja; la primera fila son los encabezados.
const parseCsvToChunks = async (filePath, archivoId, sheetName, onProgress) => {
  const delimiter = detectCsvDelimiter(filePath);
  const stream = fs.createReadStream(filePath).pipe(parseCsv({ delimiter, ignoreEmpty: true, trim: true }));

  let headers = null;
  let writer = null;
  let processedRows = 0;

  for await (const record of stream) {
    // fast-csv entrega arreglos base 0; se alinean con el formato base 1 de ExcelJS.
    const values = [undefined, ...record.map((v) => (v === "" ? null : v))];
    if (!headers) {
      if (processedRows === 0 && record.length > 0) record[0] = String(record[0]).replace(/^﻿/, "");
      headers = buildHeaders([undefined, ...record]);
      writer = createSheetWriter(archivoId, 0, headers, () => onProgress?.(processedRows));
      continue;
    }
    const rowData = toRowData(values, headers);
    if (!rowData) continue;
    await writer.add(rowData);
    processedRows += 1;
  }

  if (!writer) return [];
  const { totalRows, availableYears } = await writer.finish();
  return [{ name: sheetName, headers, rows: [], totalRows, availableYears }];
};

// ── Lectura ───────────────────────────────────────────────────────────────

const chunkCursor = (key, sheetIndex, extraFilter = {}) =>
  HistoricoRowChunk.find({ archivo: toObjectId(key), sheet: sheetIndex, ...extraFilter })
    .sort({ chunk: 1 })
    .lean()
    .cursor();

// Ejecuta fn(row) para cada fila de una hoja, sin cargar la hoja completa.
const forEachSheetRow = async (doc, sheetIndex, fn) => {
  if (!isChunked(doc)) {
    for (const row of doc.sheets?.[sheetIndex]?.rows || []) await fn(row);
    return;
  }
  for await (const chunk of chunkCursor(rowsKey(doc), sheetIndex)) {
    for (const row of chunk.rows) await fn(row);
  }
};

// Filas [start, start + limit) de una hoja guardada por bloques.
const readRowsRange = async (doc, sheetIndex, start, limit) => {
  const end = start + limit;
  const chunks = await HistoricoRowChunk.find({
    archivo: toObjectId(rowsKey(doc)),
    sheet: sheetIndex,
    start: { $lt: end },
    end: { $gt: start },
  }).sort({ chunk: 1 }).lean();

  const rows = [];
  for (const chunk of chunks) {
    const from = Math.max(0, start - chunk.start);
    const to = Math.min(chunk.rows.length, end - chunk.start);
    rows.push(...chunk.rows.slice(from, to));
  }
  return rows;
};

// Recorre los bloques que pasan chunkFilter, filtra filas con predicate y
// devuelve el total de coincidencias y la página [offset, offset + limit).
const scanRows = async (doc, sheetIndex, chunkFilter, predicate, offset, limit) => {
  let total = 0;
  const rows = [];
  for await (const chunk of chunkCursor(rowsKey(doc), sheetIndex, chunkFilter || {})) {
    for (const row of chunk.rows) {
      if (!predicate(row)) continue;
      if (total >= offset && rows.length < limit) rows.push(row);
      total += 1;
    }
  }
  return { total, rows };
};

// Devuelve el documento con las filas de todas sus hojas dentro de "sheets",
// para los servicios que necesitan el archivo completo (Tablero, CNA). Úsese
// solo con documentos lean().
const hydrateSheets = async (doc) => {
  if (!isChunked(doc)) return doc;
  const sheets = (doc.sheets || []).map((s) => ({ ...s, rows: [] }));
  for await (const chunk of HistoricoRowChunk.find({ archivo: toObjectId(rowsKey(doc)) }).sort({ sheet: 1, chunk: 1 }).lean().cursor()) {
    const target = sheets[chunk.sheet];
    if (target) for (const row of chunk.rows) target.rows.push(row);
  }
  return { ...doc, sheets };
};

// ── Cálculos fijos sobre los bloques ────────────────────────────────────────

const buildResumenFromChunks = async (doc, sheets) => {
  try {
    if (!isMatriculadosFile(doc.file_name)) return null;
    const sheet = findMatriculadosSheet(sheets);
    if (!sheet || sheetRowCount(sheet) === 0) return null;
    const accumulator = createMatriculadosAccumulator(sheet.headers || []);
    await forEachSheetRow({ ...doc, sheets }, sheets.indexOf(sheet), (row) => accumulator.add(row));
    return accumulator.result();
  } catch (error) {
    console.error("[historicoStorage] Error calculando resumen de", doc.file_name, error.message);
    return null;
  }
};

// Mismo resultado que addStudentProgramColumn (services/studentsDirectory),
// pero sobre los bloques: primero recolecta los documentos, consulta el
// programa una sola vez y luego reescribe cada bloque con la columna nueva.
// Si algo falla, el archivo queda guardado sin esa columna.
const addStudentProgramColumnToChunks = async (doc, sheets) => {
  const targets = sheets
    .map((sheet, index) => ({ index, idIndex: (sheet.headers || []).findIndex(isStudentIdHeader) }))
    .filter(({ idIndex }) => idIndex >= 0);
  if (targets.length === 0) return sheets;

  try {
    const ids = new Set();
    for (const { index, idIndex } of targets) {
      await forEachSheetRow({ ...doc, sheets }, index, (row) => { ids.add(row?.[idIndex]); });
    }
    const programs = await getStudentProgramsByIds([...ids]);
    console.log(`[historicoStorage] ${PROGRAMA_ESTUDIANTE_HEADER}: programa resuelto para ${programs.size} estudiante(s).`);

    const updated = sheets.map((sheet) => ({ ...sheet }));
    for (const { index, idIndex } of targets) {
      const headers = [...(updated[index].headers || [])];
      let programIndex = headers.findIndex(
        (h) => normalizeStudentHeader(h) === normalizeStudentHeader(PROGRAMA_ESTUDIANTE_HEADER)
      );
      if (programIndex < 0) {
        headers.push(PROGRAMA_ESTUDIANTE_HEADER);
        programIndex = headers.length - 1;
      }

      let ops = [];
      for await (const chunk of chunkCursor(rowsKey(doc), index)) {
        const rows = chunk.rows.map((row) => {
          const next = [...(row || [])];
          while (next.length < headers.length) next.push("");
          next[programIndex] = programs.get(normalizeId(next[idIndex])) || "";
          return next;
        });
        ops.push({ updateOne: { filter: { _id: chunk._id }, update: { $set: { rows } } } });
        if (ops.length >= 50) {
          await HistoricoRowChunk.bulkWrite(ops, { ordered: false });
          ops = [];
        }
      }
      if (ops.length > 0) await HistoricoRowChunk.bulkWrite(ops, { ordered: false });
      updated[index].headers = headers;
    }
    return updated;
  } catch (error) {
    console.error(`[historicoStorage] Error calculando ${PROGRAMA_ESTUDIANTE_HEADER}, se guarda sin esa columna:`, error.message);
    return sheets;
  }
};

// ── Borrado ───────────────────────────────────────────────────────────────

// Borra los bloques y el archivo GridFS de un registro, salvo que otro
// registro (una copia clonada o el original) todavía los use.
const deleteStoredData = async (doc) => {
  const HistoricoDocentes = mongoose.model("HistoricoDocentes");
  const others = { _id: { $ne: doc._id } };

  if (isChunked(doc)) {
    const key = toObjectId(rowsKey(doc));
    const inUse = await HistoricoDocentes.exists({ ...others, $or: [{ _id: key }, { rows_source: key }] });
    if (!inUse) await HistoricoRowChunk.deleteMany({ archivo: key });
  }

  if (doc.file_id) {
    const inUse = await HistoricoDocentes.exists({ ...others, file_id: doc.file_id });
    if (!inUse) await deleteGridFSFile(doc.file_id);
  }
};

module.exports = {
  isChunked,
  rowsKey,
  sheetRowCount,
  getCellText,
  saveFileToGridFS,
  saveBufferToGridFS,
  writeRowsToChunks,
  getGridFSFileInfo,
  openGridFSStream,
  readGridFSBuffer,
  parseExcelToChunks,
  parseCsvToChunks,
  forEachSheetRow,
  readRowsRange,
  scanRows,
  hydrateSheets,
  buildResumenFromChunks,
  addStudentProgramColumnToChunks,
  deleteStoredData,
};
