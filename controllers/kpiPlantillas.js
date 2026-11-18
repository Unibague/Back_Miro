const fs = require("fs");
const os = require("os");
const path = require("path");
const mongoose = require("mongoose");
const XLSX = require("xlsx");
const KpiPlantilla = require("../models/kpiPlantillas");
const KpiBase = require("../models/kpiBases");
const KpiCarpeta = require("../models/kpiCarpetas");
const HistoricoRowChunk = require("../models/historicoRowChunks");
const HistoricoDocentes = require("../models/historicoDocentes");
require("../models/periods");
const UserService = require("../services/users");
const { forEachSheetRow, parseExcelToChunks, parseCsvToChunks, writeRowsToChunks } = require("../services/historicoStorage");
const { KpiWorkbook, compact, matchSheet, matchSheetTo, fillSheet, toCellValue } = require("../services/kpiWorkbook");
const { FormulaEngine } = require("../services/kpiFormulaEngine");
const {
  uploadFileToGoogleDrive,
  deleteDriveFile,
  downloadDriveFileBuffer,
} = require("../config/googleDrive");

const controller = {};

const ALLOWED_ROLES = ["Administrador"];
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const XLSM_MIME = "application/vnd.ms-excel.sheet.macroEnabled.12";
const DRIVE_FOLDER = "Formatos/Plantillas/KPI";
const DRIVE_BASES_FOLDER = "Formatos/Plantillas/KPI/Bases";

// .xlsx y .xlsm se guardan tal cual (se llenan editando su XML, sin perder
// gráficos ni tablas dinámicas). Los demás formatos se convierten a .xlsx al
// subirlos: conservan valores y fórmulas, pero no gráficos ni tablas dinámicas.
const NATIVE_EXTENSIONS = [".xlsx", ".xlsm"];
const CONVERTED_EXTENSIONS = [".xls", ".xlsb", ".ods", ".csv"];
const ALLOWED_EXTENSIONS = [...NATIVE_EXTENSIONS, ...CONVERTED_EXTENSIONS];

const decodeFileName = (name = "") => Buffer.from(name, "latin1").toString("utf8");

const CSV_MIME = "text/csv";

const mimeOf = (fileName = "") => {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".csv") return CSV_MIME;
  return ext === ".xlsm" ? XLSM_MIME : XLSX_MIME;
};

// Deja el archivo subido listo para guardarse: lo convierte a .xlsx si hace
// falta y valida que se pueda abrir. Devuelve { file, converted } o { error }.
const prepareUpload = (file) => {
  if (!file) return { error: "Debes adjuntar el archivo Excel." };
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { error: `Formato no permitido. Usa ${ALLOWED_EXTENSIONS.join(", ")}.` };
  }

  let prepared = file;
  let converted = false;
  if (CONVERTED_EXTENSIONS.includes(ext)) {
    try {
      // En CSV se conserva el texto tal cual: si no, encabezados como "1998-1" se vuelven fechas
      const source = XLSX.read(fs.readFileSync(file.path), { type: "buffer", cellFormula: true, cellStyles: true, cellDates: true, raw: ext === ".csv" });
      const convertedPath = `${file.path}.xlsx`;
      fs.writeFileSync(convertedPath, XLSX.write(source, { type: "buffer", bookType: "xlsx", cellStyles: true }));
      // originalname viene en latin1 (multer): se conserva esa codificación
      prepared = { ...file, path: convertedPath, originalname: `${file.originalname.slice(0, -ext.length)}.xlsx` };
      converted = true;
    } catch (error) {
      return { error: "No fue posible abrir el archivo para convertirlo a Excel." };
    }
  }

  try {
    const book = new KpiWorkbook(fs.readFileSync(prepared.path));
    if (!book.sheets.length) return { error: "El archivo no tiene hojas.", file: prepared };
  } catch (error) {
    return { error: "No fue posible abrir el archivo. Verifica que sea un Excel válido.", file: prepared };
  }
  return { file: { ...prepared, mimetype: mimeOf(prepared.originalname) }, converted };
};

// Borra el archivo temporal subido y, si se convirtió, también la copia .xlsx
const cleanupUpload = (file, prepared) => {
  if (file?.path) fs.unlink(file.path, () => {});
  if (prepared?.path && prepared.path !== file?.path) fs.unlink(prepared.path, () => {});
};

// ── Información del módulo Consulta de Información ─────────────────────────

// Archivos Excel/CSV de Consulta de Información (SNIES histórico y plantillas
// de todos los períodos). Las copias clonadas a otros ámbitos se omiten para
// no duplicar filas.
const SOURCE_FILTER = {
  active: true,
  status: { $nin: ["procesando", "error"] },
  file_type: { $ne: "pdf" },
  category: { $in: ["snies", "plantillas", null] },
  cloned_from: null,
};

const MAX_EXCEL_ROWS = 1048576;
// Celdas (filas × columnas de la hoja) que se pueden escribir en una hoja. Más
// que eso no cabe en la memoria del servidor y Excel tampoco podría recalcular
// las fórmulas de tantas filas.
const MAX_SHEET_CELLS = 2500000;
const HIDDEN_SHEETS = new Set(["listas", "lista", "listados"]);
const SAME_SHEET_SIMILARITY = 0.6;

const baseName = (fileName = "") => String(fileName).replace(/\.[^.]+$/, "");
const timeOf = (file) => new Date(file.createdAt || 0).getTime();

const jaccard = (a, b) => {
  let common = 0;
  a.forEach((key) => { if (b.has(key)) common += 1; });
  return common / (a.size + b.size - common || 1);
};

// Una "candidata" por hoja de Consulta de Información. Las hojas con el mismo
// nombre y encabezados parecidos (la misma plantilla cargada en distintos
// períodos o años) se juntan para traer todo el histórico en una sola tabla.
const buildCandidates = (files) => {
  const groups = new Map();

  files.forEach((file) => {
    (file.sheets || []).forEach((sheet, sheetIndex) => {
      const sheetKey = compact(sheet?.name);
      if (!sheetKey || HIDDEN_SHEETS.has(sheetKey)) return;
      const fieldKeys = new Set((sheet.headers || []).map(compact).filter(Boolean));
      if (!fieldKeys.size) return;

      if (!groups.has(sheetKey)) groups.set(sheetKey, []);
      const variants = groups.get(sheetKey);
      let candidate = variants.find((item) => jaccard(item.fieldKeys, fieldKeys) >= SAME_SHEET_SIMILARITY);
      if (!candidate) {
        candidate = {
          key: `${sheetKey}|${variants.length}`,
          name: sheet.name,
          fieldKeys: new Set(),
          nameKeys: [sheetKey],
          sources: [],
        };
        variants.push(candidate);
      }
      fieldKeys.forEach((key) => candidate.fieldKeys.add(key));
      const fileKey = compact(baseName(file.file_name));
      if (fileKey && !candidate.nameKeys.includes(fileKey)) candidate.nameKeys.push(fileKey);
      candidate.sources.push({ file, sheetIndex, headers: sheet.headers || [] });
    });
  });

  const candidates = [...groups.values()].flat();
  candidates.forEach((candidate) => candidate.sources.sort((x, y) => timeOf(y.file) - timeOf(x.file)));
  return candidates;
};

const textValue = (value) => String(value ?? "").trim();

const cleanSemestre = (value) => (/^\d+$/.test(value) ? String(Number(value)) : value);

// Período de cada fila: el que traen sus columnas (PERIODO / AÑO + SEMESTRE),
// como en el histórico SNIES, o el período al que se cargó el archivo.
const periodOf = (record, file) => {
  const periodo = textValue(record.get("periodo"));
  if (periodo) return periodo;
  const ano = textValue(record.get("ano") ?? record.get("anio") ?? record.get("annio") ?? record.get("year"));
  const semestre = cleanSemestre(textValue(record.get("semestre")));
  if (ano && semestre) return semestre.includes(ano) ? semestre : `${ano}-${semestre}`;
  return ano || file.period?.name || semestre;
};

const PERIOD_COLLATOR = new Intl.Collator("es", { numeric: true });
const periodSort = (a, b) => PERIOD_COLLATOR.compare(a, b);

// Filas de todas las cargas de la hoja, con las llaves normalizadas. Si un
// mismo período está en varias cargas (p. ej. un histórico 2014-2024 y otro
// más nuevo 2014-2025, o la misma plantilla subida dos veces), se toman solo
// las filas de la carga más reciente para no duplicar información.
// Fila de una fuente: sus valores tal como se guardaron y un índice llave →
// columna compartido por todas las filas de la carga (un Map por fila ocupa
// demasiada memoria con cientos de miles de filas).
class SourceRecord {
  constructor(index, values) {
    this.index = index;
    this.values = values;
    this.periodo = "";
  }

  get(key) {
    const position = this.index.get(key);
    return position === undefined ? undefined : this.values[position];
  }
}

// Columnas con las que se deduce el período de cada fila
const PERIOD_KEYS = ["periodo", "ano", "anio", "annio", "year", "semestre"];

// pickKeys: solo se guardan esas columnas (y las del período) de cada fila,
// para no tener en memoria columnas que la hoja no usa.
const collectRows = async (candidate, advertencias, pickKeys = null) => {
  const owners = new Map(); // período → carga más reciente que lo trae
  const loaded = [];
  const wanted = pickKeys ? new Set([...pickKeys, ...PERIOD_KEYS]) : null;
  for (const { file, sheetIndex, headers } of candidate.sources) {
    try {
      const index = new Map();
      const positions = [];
      headers.forEach((header, position) => {
        const key = compact(header);
        if (!key || index.has(key) || (wanted && !wanted.has(key))) return;
        index.set(key, wanted ? positions.length : position);
        positions.push(position);
      });
      const doc = file.kpiBase
        ? { _id: file._id, storage: "chunked", sheets: file.sheets }
        : await HistoricoDocentes.findById(file._id).select("storage rows_source sheets").lean();
      const rows = [];
      await forEachSheetRow(doc, sheetIndex, (row) => {
        const values = Array.isArray(row) ? row : headers.map((header) => row?.[header]);
        const record = new SourceRecord(index, wanted ? positions.map((position) => values[position]) : values);
        record.periodo = periodOf(record, file);
        rows.push(record);
      });
      rows.forEach(({ periodo }) => { if (!owners.has(periodo)) owners.set(periodo, file._id); });
      loaded.push({ file, rows });
    } catch (error) {
      advertencias.push(`No se pudo leer "${file.file_name}": ${error.message}`);
    }
  }

  const rows = [];
  loaded.reverse().forEach(({ file, rows: fileRows }) => {
    const propias = fileRows.filter((record) => owners.get(record.periodo) === file._id);
    for (const record of propias) rows.push(record);
  });
  rows.sort((a, b) => periodSort(a.periodo, b.periodo));
  const periodos = [...new Set(rows.map((record) => record.periodo).filter(Boolean))].sort(periodSort);
  return { rows, periodos };
};

// ── Bases externas (SPADIES…) ───────────────────────────────────────────────

// Encabezados que son un período: 1998-1, 2002-2, 2024 1, 2025A, 2025-II… o
// solo el año (2019, 2020…) en bases anuales.
const PERIOD_HEADER = /^((?:19|20)\d{2})(?:\s*[-_/ ]?\s*(0?[12]|[ab]|i{1,2}))?$/i;
const MIN_PERIOD_COLUMNS = 2;
const PERIOD_SHEET_SUFFIX = " (por período)";

const periodFromHeader = (header) => {
  const match = PERIOD_HEADER.exec(String(header || "").trim());
  if (!match) return null;
  if (!match[2]) return match[1];
  const term = match[2].toLowerCase();
  const number = term === "a" || term === "i" ? 1 : term === "b" || term === "ii" ? 2 : Number(term);
  return `${match[1]}-${number}`;
};

// Las bases como SPADIES traen un período por columna (1998-1, 1998-2…). Por
// cada hoja así se agrega otra con esas columnas convertidas en filas
// (… | PERIODO | VALOR), para cruzarla por período con lo calculado en el KPI.
const addPeriodSheets = async (baseId, sheets) => {
  const result = [...sheets];
  for (const [sheetIndex, sheet] of sheets.entries()) {
    const periodCols = sheet.headers
      .map((header, index) => ({ index, periodo: periodFromHeader(header) }))
      .filter((item) => item.periodo);
    if (periodCols.length < MIN_PERIOD_COLUMNS) continue;

    const periodIndexes = new Set(periodCols.map((item) => item.index));
    const keepIndexes = sheet.headers.map((_, index) => index).filter((index) => !periodIndexes.has(index));
    const headers = [...keepIndexes.map((index) => sheet.headers[index]), "PERIODO", "VALOR"];
    const rows = [];
    await forEachSheetRow({ _id: baseId, storage: "chunked" }, sheetIndex, (row) => {
      const fixed = keepIndexes.map((index) => row[index] ?? "");
      periodCols.forEach(({ index, periodo }) => {
        const value = row[index];
        if (value !== null && value !== undefined && String(value).trim() !== "") rows.push([...fixed, periodo, value]);
      });
    });
    const { totalRows } = await writeRowsToChunks(baseId, result.length, headers, rows);
    result.push({ name: `${sheet.name}${PERIOD_SHEET_SUFFIX}`, headers, totalRows, derived_from: sheet.name });
  }
  return result;
};

const baseAsSource = (base) => ({
  _id: base._id,
  file_name: base.file_name,
  category: "kpi",
  period: null,
  createdAt: base.createdAt,
  sheets: base.sheets,
  kpiBase: true,
});

// Todas las fuentes con las que se puede llenar una hoja: Consulta de
// Información (todos los períodos) y las bases externas del módulo.
// Vuelve a leer una base desde su archivo original en Drive cuando sus filas
// ya no están (p. ej. si se restauró la base de datos desde una copia que no
// las tenía). Devuelve la base con sus hojas actualizadas.
const repairBase = async (base) => {
  const ext = path.extname(base.file_name).toLowerCase();
  const tmp = path.join(os.tmpdir(), `kpi-base-${base._id}-${Date.now()}${ext || ".xlsx"}`);
  try {
    fs.writeFileSync(tmp, await downloadDriveFileBuffer(base.drive_file_id));
    await HistoricoRowChunk.deleteMany({ archivo: base._id });
    const parsed = ext === ".csv"
      ? await parseCsvToChunks(tmp, base._id, base.file_name.replace(/\.[^.]+$/, ""))
      : await parseExcelToChunks(tmp, base._id);
    const sheets = await addPeriodSheets(base._id, parsed);
    await KpiBase.updateOne({ _id: base._id }, { $set: { sheets } });
    return { ...base, sheets };
  } finally {
    fs.unlink(tmp, () => {});
  }
};

const loadBases = async (advertencias = []) => {
  const bases = await KpiBase.find({}).lean();
  return Promise.all(bases.map(async (base) => {
    const expected = (base.sheets || []).some((sheet) => sheet.totalRows > 0);
    if (!expected || !base.drive_file_id || await HistoricoRowChunk.exists({ archivo: base._id })) return base;
    try {
      const repaired = await repairBase(base);
      advertencias.push(`La base "${base.name}" no tenía sus filas guardadas; se volvió a leer desde su archivo original.`);
      return repaired;
    } catch (error) {
      advertencias.push(`La base "${base.name}" no tiene sus filas guardadas y no se pudo volver a leer (${error.message}); cárgala de nuevo.`);
      return base;
    }
  }));
};

const loadCandidates = async (advertencias) => {
  const archivos = await HistoricoDocentes.find(SOURCE_FILTER)
    .select("file_name category period createdAt sheets.name sheets.headers sheets.totalRows")
    .populate("period", "name")
    .lean();
  const bases = await loadBases(advertencias);
  archivos.push(...bases.map(baseAsSource));
  return buildCandidates(archivos);
};

const candidateLabel = (candidate) => {
  const archivos = [...new Set(candidate.sources.map(({ file }) => baseName(file.file_name)))];
  const sheetKey = compact(candidate.name);
  // Si el archivo se llama igual que la hoja (CSV), basta con un nombre
  const extra = archivos.filter((name) => compact(name) !== sheetKey);
  return extra.length ? `${candidate.name} · ${extra.slice(0, 2).join(", ")}${extra.length > 2 ? "…" : ""}` : candidate.name;
};

const candidateGroup = (candidate) =>
  candidate.sources.some(({ file }) => file.kpiBase) ? "Bases externas" : "Consulta de Información";

// Columnas de la hoja del KPI que se llenan con la fuente (y "Período")
const mappedKeys = (match) => {
  const keys = [];
  match.headers.forEach((text, col) => {
    const key = compact(text);
    if (match.candidate.fieldKeys.has(key) || key === "periodo") keys.push({ col, key });
  });
  return keys;
};

// ¿La primera fila de datos tiene fórmulas en columnas que no vienen de la fuente?
const hasHelperFormulas = (book, sheet, match) => {
  book.headTexts(sheet, match.headerRow + 1);
  const mapped = new Set(mappedKeys(match).map(({ col }) => col));
  const cells = sheet.headCells.get(match.headerRow + 1);
  if (!cells) return false;
  return [...cells.entries()].some(([col, cell]) => !mapped.has(col) && book.hasFormula(cell));
};

// ── Endpoints ────────────────────────────────────────────────────────────────

const isObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value || ""));

// Carpeta válida del período: toda plantilla debe ir dentro de una carpeta
const resolveFolder = async (folderId, periodId) => {
  if (!folderId) throw new Error("Primero crea una carpeta y carga la plantilla dentro de ella.");
  const carpeta = isObjectId(folderId) ? await KpiCarpeta.findById(folderId).lean() : null;
  if (!carpeta || String(carpeta.period) !== String(periodId)) throw new Error("La carpeta no existe en este período.");
  return carpeta._id;
};

// Carpetas y plantillas de un período
controller.getPlantillas = async (req, res) => {
  try {
    const { email, periodId } = req.query;
    await UserService.findUserByEmailAndRoles(email, ALLOWED_ROLES);
    if (!isObjectId(periodId)) return res.status(400).json({ error: "Selecciona un período." });

    // Las plantillas cargadas antes de los períodos pasan al primero que se abre
    await KpiPlantilla.updateMany({ period: null }, { $set: { period: periodId } });

    const [carpetas, plantillas] = await Promise.all([
      KpiCarpeta.find({ period: periodId }).sort({ name: 1 }).lean(),
      KpiPlantilla.find({ period: periodId }).sort({ createdAt: -1 }).lean(),
    ]);
    return res.status(200).json({ carpetas, plantillas });
  } catch (error) {
    console.error("[KPI] Error listando plantillas:", error);
    return res.status(500).json({ error: error.message });
  }
};

controller.uploadPlantilla = async (req, res) => {
  const file = req.file;
  let prepared = null;
  try {
    const { email, name, periodId, folderId } = req.body;
    await UserService.findUserByEmailAndRoles(email, ALLOWED_ROLES);
    if (!isObjectId(periodId)) return res.status(400).json({ error: "Selecciona un período." });
    let folder;
    try {
      folder = await resolveFolder(folderId, periodId);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }

    const result = prepareUpload(file);
    prepared = result.file || null;
    if (result.error) return res.status(400).json({ error: result.error });

    const uploaded = await uploadFileToGoogleDrive(prepared, DRIVE_FOLDER, prepared.originalname);

    const plantilla = await KpiPlantilla.create({
      name: String(name || "").trim() || decodeFileName(file.originalname).replace(/\.[^.]+$/, ""),
      file_name: decodeFileName(prepared.originalname),
      drive_file_id: uploaded.id,
      drive_file_link: uploaded.webViewLink || "",
      uploaded_by: email,
      period: periodId,
      folder,
    });

    return res.status(200).json({ ...plantilla.toObject(), converted: result.converted });
  } catch (error) {
    console.error("[KPI] Error subiendo plantilla:", error);
    return res.status(500).json({ error: error.message });
  } finally {
    cleanupUpload(file, prepared);
  }
};

// Reemplaza el archivo Excel de una tarjeta existente
controller.replacePlantilla = async (req, res) => {
  const file = req.file;
  let prepared = null;
  try {
    const { email } = req.body;
    await UserService.findUserByEmailAndRoles(email, ALLOWED_ROLES);

    const plantilla = await KpiPlantilla.findById(req.params.id);
    if (!plantilla) return res.status(404).json({ error: "Plantilla no encontrada" });

    const result = prepareUpload(file);
    prepared = result.file || null;
    if (result.error) return res.status(400).json({ error: result.error });

    const uploaded = await uploadFileToGoogleDrive(prepared, DRIVE_FOLDER, prepared.originalname);
    const previousId = plantilla.drive_file_id;

    plantilla.file_name = decodeFileName(prepared.originalname);
    plantilla.drive_file_id = uploaded.id;
    plantilla.drive_file_link = uploaded.webViewLink || "";
    plantilla.uploaded_by = email;
    await plantilla.save();

    if (previousId && previousId !== uploaded.id) await deleteDriveFile(previousId);
    return res.status(200).json({ ...plantilla.toObject(), converted: result.converted });
  } catch (error) {
    console.error("[KPI] Error reemplazando plantilla:", error);
    return res.status(500).json({ error: error.message });
  } finally {
    cleanupUpload(file, prepared);
  }
};

// Mueve una plantilla a otra carpeta del mismo período
controller.movePlantilla = async (req, res) => {
  try {
    const { email, folderId } = req.body || {};
    await UserService.findUserByEmailAndRoles(email, ALLOWED_ROLES);
    const plantilla = await KpiPlantilla.findById(req.params.id);
    if (!plantilla) return res.status(404).json({ error: "Plantilla no encontrada" });
    try {
      plantilla.folder = await resolveFolder(folderId, plantilla.period);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    await plantilla.save();
    return res.status(200).json(plantilla.toObject());
  } catch (error) {
    console.error("[KPI] Error moviendo plantilla:", error);
    return res.status(500).json({ error: error.message });
  }
};

// ── Carpetas ─────────────────────────────────────────────────────────────────

const cleanFolderName = (name) => String(name || "").trim().slice(0, 120);

controller.createCarpeta = async (req, res) => {
  try {
    const { email, name, periodId } = req.body || {};
    await UserService.findUserByEmailAndRoles(email, ALLOWED_ROLES);
    if (!isObjectId(periodId)) return res.status(400).json({ error: "Selecciona un período." });
    const nombre = cleanFolderName(name);
    if (!nombre) return res.status(400).json({ error: "Escribe el nombre de la carpeta." });
    const carpeta = await KpiCarpeta.create({ name: nombre, period: periodId, created_by: email });
    return res.status(200).json(carpeta.toObject());
  } catch (error) {
    console.error("[KPI] Error creando carpeta:", error);
    return res.status(500).json({ error: error.message });
  }
};

controller.renameCarpeta = async (req, res) => {
  try {
    const { email, name } = req.body || {};
    await UserService.findUserByEmailAndRoles(email, ALLOWED_ROLES);
    const nombre = cleanFolderName(name);
    if (!nombre) return res.status(400).json({ error: "Escribe el nombre de la carpeta." });
    const carpeta = await KpiCarpeta.findByIdAndUpdate(req.params.id, { name: nombre }, { new: true }).lean();
    if (!carpeta) return res.status(404).json({ error: "Carpeta no encontrada" });
    return res.status(200).json(carpeta);
  } catch (error) {
    console.error("[KPI] Error renombrando carpeta:", error);
    return res.status(500).json({ error: error.message });
  }
};

// Solo se eliminan carpetas vacías, para no borrar plantillas por accidente
controller.deleteCarpeta = async (req, res) => {
  try {
    await UserService.findUserByEmailAndRoles(req.query.email, ALLOWED_ROLES);
    const plantillas = await KpiPlantilla.countDocuments({ folder: req.params.id });
    if (plantillas) {
      return res.status(400).json({ error: `La carpeta tiene ${plantillas} plantilla(s). Muévelas o elimínalas primero.` });
    }
    const carpeta = await KpiCarpeta.findByIdAndDelete(req.params.id);
    if (!carpeta) return res.status(404).json({ error: "Carpeta no encontrada" });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[KPI] Error eliminando carpeta:", error);
    return res.status(500).json({ error: error.message });
  }
};

controller.downloadPlantilla = async (req, res) => {
  try {
    await UserService.findUserByEmailAndRoles(req.query.email, ALLOWED_ROLES);
    const plantilla = await KpiPlantilla.findById(req.params.id).lean();
    if (!plantilla) return res.status(404).json({ error: "Plantilla no encontrada" });

    const buffer = await downloadDriveFileBuffer(plantilla.drive_file_id);
    res.setHeader("Content-Type", mimeOf(plantilla.file_name));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="plantilla${path.extname(plantilla.file_name)}"; filename*=UTF-8''${encodeURIComponent(plantilla.file_name)}`
    );
    return res.send(buffer);
  } catch (error) {
    console.error("[KPI] Error descargando plantilla:", error);
    return res.status(500).json({ error: error.message });
  }
};

controller.deletePlantilla = async (req, res) => {
  try {
    await UserService.findUserByEmailAndRoles(req.query.email, ALLOWED_ROLES);
    const plantilla = await KpiPlantilla.findByIdAndDelete(req.params.id);
    if (!plantilla) return res.status(404).json({ error: "Plantilla no encontrada" });
    await deleteDriveFile(plantilla.drive_file_id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[KPI] Error eliminando plantilla:", error);
    return res.status(500).json({ error: error.message });
  }
};

// Llena el Excel KPI con toda la información histórica del módulo Consulta de
// Información (todos los años y períodos). Cada hoja del Excel se empareja con
// la hoja cuyos encabezados coinciden con los suyos; las hojas que no coinciden
// (cálculos, gráficos, tableros) y todas las fórmulas quedan como estaban.
controller.traerInformacion = async (req, res) => {
  try {
    const { email } = req.body || {};
    await UserService.findUserByEmailAndRoles(email, ALLOWED_ROLES);

    const plantilla = await KpiPlantilla.findById(req.params.id);
    if (!plantilla) return res.status(404).json({ error: "Plantilla no encontrada" });

    // Solo se llenan las hojas que el administrador configuró: emparejar solo
    // por encabezados puede escribir datos en hojas de cálculo que se parecen.
    if (!(plantilla.mapeo || []).length) {
      return res.status(400).json({ error: "Primero usa “Configurar hojas” para elegir qué hojas se llenan y con qué información." });
    }

    const advertencias = [];
    const candidates = await loadCandidates(advertencias);
    if (!candidates.length) {
      return res.status(400).json({ error: "No hay archivos con información en Consulta de Información ni bases externas cargadas." });
    }

    const book = new KpiWorkbook(await downloadDriveFileBuffer(plantilla.drive_file_id));
    const mapeo = new Map((plantilla.mapeo || []).map((item) => [item.hoja, item]));
    const hojas = [];
    const hojasSinCambios = [];
    const filledSheets = [];
    const rowsCache = new Map();
    const virtualSheets = new Map();

    for (const sheet of book.sheets) {
      let match = null;
      const config = mapeo.get(sheet.name);
      if (config) {
        const candidate = candidates.find((item) => item.key === config.fuente);
        if (!candidate) {
          advertencias.push(`Hoja "${sheet.name}": la fuente "${config.fuente_label || config.fuente}" ya no existe; vuelve a configurar la hoja.`);
        } else {
          match = matchSheetTo(book, sheet, candidate);
          // Se calcula antes de leer las filas, con el conteo guardado de cada carga
          const filasFuente = candidate.sources.reduce((total, { file, sheetIndex }) =>
            total + (file.sheets?.[sheetIndex]?.totalRows || 0), 0);
          const columnas = match ? Math.max(...match.headers.keys()) : 0;

          // Hoja de datos con columnas de fórmulas que recibe más filas de las
          // que la plantilla trae preparadas: Miró la calcula sin copiarla.
          if (match && hasHelperFormulas(book, sheet, match) && filasFuente > sheet.lastDeclaredRow - match.headerRow) {
            const keys = mappedKeys(match);
            const { rows, periodos } = await collectRows(candidate, advertencias, new Set(keys.map(({ key }) => key)));
            const inputs = new Map(keys.map(({ col, key }) => [
              col,
              rows.map((record) => toCellValue(key === "periodo" && !candidate.fieldKeys.has("periodo") ? record.periodo : record.get(key))),
            ]));
            virtualSheets.set(sheet.name, { headerRow: match.headerRow, count: rows.length, inputs });
            hojas.push({
              hoja: sheet.name,
              plantilla: candidateLabel(candidate),
              periodos,
              filas: rows.length,
              columnas: keys.length,
              sinCoincidencia: [],
              formulasExtendidas: [],
              calculada: true,
            });
            continue;
          }

          if (match && filasFuente * columnas > MAX_SHEET_CELLS) {
            return res.status(400).json({
              error: `La hoja "${sheet.name}" recibiría ${filasFuente.toLocaleString("es-CO")} filas de "${config.fuente_label || candidate.name}" con ${columnas} columnas: es demasiado grande para llenarla en Excel. Quita esa hoja en “Configurar hojas” o usa una fuente con menos filas.`,
            });
          }
          if (!match) advertencias.push(`Hoja "${sheet.name}": ningún encabezado coincide con "${config.fuente_label || candidate.name}".`);
        }
      }
      if (!match) {
        hojasSinCambios.push(sheet.name);
        continue;
      }

      const { candidate } = match;
      if (!rowsCache.has(candidate.key)) rowsCache.set(candidate.key, await collectRows(candidate, advertencias));
      const { periodos } = rowsCache.get(candidate.key);
      let { rows } = rowsCache.get(candidate.key);
      if (rows.length > MAX_EXCEL_ROWS - match.headerRow) {
        advertencias.push(`Hoja "${sheet.name}": hay ${rows.length} filas y Excel solo admite ${MAX_EXCEL_ROWS}; se dejaron las primeras.`);
        rows = rows.slice(0, MAX_EXCEL_ROWS - match.headerRow);
      }

      // "Período" se llena aunque no sea columna de la hoja de origen, para
      // distinguir las filas de cada año/período del histórico.
      const extraColumns = {};
      if (!candidate.fieldKeys.has("periodo")) extraColumns.periodo = (record) => record.periodo;

      const result = fillSheet(book, sheet, match, rows, extraColumns);
      advertencias.push(...result.advertencias);
      filledSheets.push({ name: sheet.name, headerRow: result.headerRow, lastRow: result.lastRow });
      hojas.push({
        hoja: sheet.name,
        plantilla: candidateLabel(candidate),
        periodos,
        filas: rows.length,
        columnas: result.columnas.length,
        sinCoincidencia: result.sinCoincidencia.slice(0, 15),
        formulasExtendidas: result.formulasExtendidas.slice(0, 15),
      });
    }

    if (!hojas.length) {
      return res.status(400).json({ error: `No se llenó ninguna hoja. ${advertencias.slice(0, 3).join(" ")}`.trim() });
    }

    let calculo = null;
    if (virtualSheets.size) {
      const engine = new FormulaEngine(book, virtualSheets);
      calculo = engine.materialize();
      // Las hojas grandes también quedan en el Excel, con sus valores ya calculados
      engine.writeVirtualSheets();
      engine.release();
      if (calculo.errores) advertencias.push(`${calculo.errores} celda(s) calculadas dieron error (#N/A, #DIV/0!…); revisa sus fórmulas.`);
      calculo.noSoportadas.forEach((detalle) => advertencias.push(`No se pudo calcular en Miró: ${detalle}. Esas celdas quedaron con su fórmula.`));
    }

    book.finalize(filledSheets);
    const outputBuffer = await book.toBuffer();

    plantilla.last_run_at = new Date();
    plantilla.last_run_by = email;
    await plantilla.save();

    const resumen = {
      hojas,
      hojasSinCambios: hojasSinCambios.slice(0, 30),
      advertencias: advertencias.slice(0, 20),
      calculo: calculo && { celdas: calculo.celdas, hojas: calculo.hojas },
    };
    const ext = path.extname(plantilla.file_name).toLowerCase() || ".xlsx";
    const fileName = `${plantilla.file_name.slice(0, -ext.length)}_${new Date().toISOString().slice(0, 10)}${ext}`;

    res.setHeader("Content-Type", mimeOf(plantilla.file_name));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="KPI${ext}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-KPI-Resumen");
    res.setHeader("X-KPI-Resumen", encodeURIComponent(JSON.stringify(resumen)));
    return res.send(outputBuffer);
  } catch (error) {
    console.error("[KPI] Error trayendo información:", error);
    return res.status(500).json({ error: error.message });
  }
};

// Hojas del Excel con la fuente configurada (o sugerida) y todas las fuentes
// disponibles, para la ventana "Configurar hojas".
// Archivos (nombre sin extensión) de los que sale una fuente
const candidateFiles = (candidate) => [...new Set(candidate.sources.map(({ file }) => baseName(file.file_name)))];

// Palabras de un nombre de hoja: "IN_Matriculados" → ["matriculados"]
const nameWords = (name) =>
  String(name || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !/^\d+$/.test(word));

// Palabra igual: 2 puntos; una contenida en la otra ("matric" / "matriculados"): 1
const nameSimilarity = (a, b) => {
  const wordsB = nameWords(b);
  return nameWords(a).reduce((total, word) => {
    if (wordsB.includes(word)) return total + 2;
    return total + (wordsB.some((other) => other.includes(word) || word.includes(other)) ? 1 : 0);
  }, 0);
};

// Para una hoja del KPI, la hoja más parecida de cada archivo: primero por
// encabezados en común y, si empatan (p. ej. UnoAUno de matriculados y de
// graduados), por el nombre ("IN_Matriculados" ↔ "UnoAUno_Matriculados").
const bestSheetByFile = (book, sheet, candidates) => {
  const best = {};
  candidates.forEach((candidate) => {
    const match = matchSheetTo(book, sheet, candidate);
    const score = (match?.score || 0) * 100 + nameSimilarity(sheet.name, candidate.name);
    if (!match) return;
    candidateFiles(candidate).forEach((archivo) => {
      if (!best[archivo] || score > best[archivo].score) best[archivo] = { key: candidate.key, score };
    });
  });
  return Object.fromEntries(Object.entries(best).map(([archivo, { key }]) => [archivo, key]));
};

controller.getHojas = async (req, res) => {
  try {
    await UserService.findUserByEmailAndRoles(req.query.email, ALLOWED_ROLES);
    const plantilla = await KpiPlantilla.findById(req.params.id).lean();
    if (!plantilla) return res.status(404).json({ error: "Plantilla no encontrada" });

    const [candidates, buffer] = await Promise.all([loadCandidates(), downloadDriveFileBuffer(plantilla.drive_file_id)]);
    const book = new KpiWorkbook(buffer);
    const mapeo = new Map((plantilla.mapeo || []).map((item) => [item.hoja, item.fuente]));
    const keys = new Set(candidates.map((candidate) => candidate.key));

    const hojas = book.sheets.map((sheet) => {
      const sugerida = matchSheet(book, sheet, candidates);
      const configurada = mapeo.get(sheet.name);
      return {
        hoja: sheet.name,
        fuente: configurada && keys.has(configurada) ? configurada : null,
        sugerida: sugerida?.candidate.key || null,
        encabezados: sugerida ? [...sugerida.headers.values()].slice(0, 12) : [],
        porArchivo: bestSheetByFile(book, sheet, candidates),
      };
    });

    const fuentes = candidates
      .map((candidate) => ({
        value: candidate.key,
        label: candidateLabel(candidate),
        group: candidateGroup(candidate),
        hoja: candidate.name,
        archivos: candidateFiles(candidate),
      }))
      .sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label, "es"));

    return res.status(200).json({ hojas, fuentes, configurada: (plantilla.mapeo || []).length > 0 });
  } catch (error) {
    console.error("[KPI] Error leyendo hojas:", error);
    return res.status(500).json({ error: error.message });
  }
};

controller.saveHojas = async (req, res) => {
  try {
    const { email, mapeo = [] } = req.body || {};
    await UserService.findUserByEmailAndRoles(email, ALLOWED_ROLES);
    const plantilla = await KpiPlantilla.findById(req.params.id);
    if (!plantilla) return res.status(404).json({ error: "Plantilla no encontrada" });

    const candidates = await loadCandidates();
    const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
    const limpio = (Array.isArray(mapeo) ? mapeo : [])
      .filter((item) => item?.hoja && byKey.has(item.fuente))
      .map((item) => ({ hoja: String(item.hoja), fuente: item.fuente, fuente_label: candidateLabel(byKey.get(item.fuente)) }));
    if (!limpio.length) return res.status(400).json({ error: "Elige la fuente de al menos una hoja." });

    plantilla.mapeo = limpio;
    await plantilla.save();
    return res.status(200).json(plantilla.toObject());
  } catch (error) {
    console.error("[KPI] Error guardando hojas:", error);
    return res.status(500).json({ error: error.message });
  }
};

controller.getBases = async (req, res) => {
  try {
    await UserService.findUserByEmailAndRoles(req.query.email, ALLOWED_ROLES);
    const bases = await KpiBase.find({}).sort({ createdAt: -1 }).lean();
    return res.status(200).json(bases);
  } catch (error) {
    console.error("[KPI] Error listando bases:", error);
    return res.status(500).json({ error: error.message });
  }
};

// Carga una base externa (SPADIES u otra). Sus filas se usan al traer la
// información de las plantillas KPI, junto con Consulta de Información.
controller.uploadBase = async (req, res) => {
  const file = req.file;
  let prepared = null;
  let baseId = null;
  try {
    const { email, name } = req.body;
    await UserService.findUserByEmailAndRoles(email, ALLOWED_ROLES);

    // Los CSV se leen directo como texto (con el separador que traigan) y su
    // única hoja toma el nombre del archivo, para no mezclar varios CSV que
    // de otro modo quedarían todos como "Sheet1".
    const isCsv = path.extname(file?.originalname || "").toLowerCase() === ".csv";
    const result = isCsv ? { file: { ...file, mimetype: CSV_MIME }, converted: false } : prepareUpload(file);
    prepared = result.file || null;
    if (result.error) return res.status(400).json({ error: result.error });

    const baseName = decodeFileName(file.originalname).replace(/\.[^.]+$/, "");
    const base = new KpiBase({
      name: String(name || "").trim() || baseName,
      file_name: decodeFileName(prepared.originalname),
      uploaded_by: email,
    });
    baseId = base._id;

    // Se guardan todas las hojas (aunque estén vacías): su posición es el
    // índice de hoja de los bloques de filas.
    const sheets = isCsv
      ? await parseCsvToChunks(prepared.path, baseId, baseName)
      : await parseExcelToChunks(prepared.path, baseId);
    if (!sheets.some((sheet) => sheet.totalRows > 0)) {
      await HistoricoRowChunk.deleteMany({ archivo: baseId });
      return res.status(400).json({ error: "El archivo no tiene filas con información." });
    }
    base.sheets = await addPeriodSheets(baseId, sheets);

    const uploaded = await uploadFileToGoogleDrive(prepared, DRIVE_BASES_FOLDER, prepared.originalname);
    base.drive_file_id = uploaded.id;
    base.drive_file_link = uploaded.webViewLink || "";
    await base.save();

    return res.status(200).json({ ...base.toObject(), converted: result.converted });
  } catch (error) {
    console.error("[KPI] Error subiendo base:", error);
    if (baseId) await HistoricoRowChunk.deleteMany({ archivo: baseId }).catch(() => {});
    return res.status(500).json({ error: error.message });
  } finally {
    cleanupUpload(file, prepared);
  }
};

controller.downloadBase = async (req, res) => {
  try {
    await UserService.findUserByEmailAndRoles(req.query.email, ALLOWED_ROLES);
    const base = await KpiBase.findById(req.params.id).lean();
    if (!base) return res.status(404).json({ error: "Base no encontrada" });

    const buffer = await downloadDriveFileBuffer(base.drive_file_id);
    res.setHeader("Content-Type", mimeOf(base.file_name));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="base${path.extname(base.file_name)}"; filename*=UTF-8''${encodeURIComponent(base.file_name)}`
    );
    return res.send(buffer);
  } catch (error) {
    console.error("[KPI] Error descargando base:", error);
    return res.status(500).json({ error: error.message });
  }
};

controller.deleteBase = async (req, res) => {
  try {
    await UserService.findUserByEmailAndRoles(req.query.email, ALLOWED_ROLES);
    const base = await KpiBase.findByIdAndDelete(req.params.id);
    if (!base) return res.status(404).json({ error: "Base no encontrada" });
    await HistoricoRowChunk.deleteMany({ archivo: base._id });
    if (base.drive_file_id) await deleteDriveFile(base.drive_file_id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[KPI] Error eliminando base:", error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports = controller;
