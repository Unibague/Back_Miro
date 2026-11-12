const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const KpiPlantilla = require("../models/kpiPlantillas");
const PublishedTemplate = require("../models/publishedTemplates");
const UserService = require("../services/users");
const publishedTemplatesController = require("./publishedTemplates");
const { KpiWorkbook, compact, matchSheet, fillSheet } = require("../services/kpiWorkbook");
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

// .xlsx y .xlsm se guardan tal cual (se llenan editando su XML, sin perder
// gráficos ni tablas dinámicas). Los demás formatos se convierten a .xlsx al
// subirlos: conservan valores y fórmulas, pero no gráficos ni tablas dinámicas.
const NATIVE_EXTENSIONS = [".xlsx", ".xlsm"];
const CONVERTED_EXTENSIONS = [".xls", ".xlsb", ".ods", ".csv"];
const ALLOWED_EXTENSIONS = [...NATIVE_EXTENSIONS, ...CONVERTED_EXTENSIONS];

const decodeFileName = (name = "") => Buffer.from(name, "latin1").toString("utf8");

const mimeOf = (fileName = "") =>
  path.extname(fileName).toLowerCase() === ".xlsm" ? XLSM_MIME : XLSX_MIME;

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
      const source = XLSX.read(fs.readFileSync(file.path), { type: "buffer", cellFormula: true, cellStyles: true, cellDates: true });
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

// ── Información de las plantillas del sistema ───────────────────────────────

// Reutiliza la descarga consolidada de plantillas publicadas (sin modificar ese
// módulo) para traer exactamente la misma información que ve el administrador.
const fetchMergedRows = (pubTemId, email, sheetName) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) {
        if (this.statusCode >= 400) reject(new Error(payload?.error || payload?.status || "Error consultando la plantilla"));
        else resolve(payload?.data || []);
        return this;
      },
    };
    const query = { pubTem_id: String(pubTemId), email };
    if (sheetName) query.sheetName = sheetName;
    publishedTemplatesController
      .getFilledDataMergedForDimension({ query, ip: "", get: () => "KPI" }, res)
      .catch(reject);
  });

const periodSort = (a, b) => String(a.period?.name || "").localeCompare(String(b.period?.name || ""));

// Una "candidata" por plantilla (o por hoja, en plantillas de varias hojas),
// con los campos que deben aparecer como encabezados en el Excel KPI.
const buildCandidates = (publishedTemplates) => {
  const candidates = new Map();

  publishedTemplates.forEach((published) => {
    const template = published.template || {};
    const workbookSheets = (template.workbook_sheets || []).filter((sheet) => sheet?.name);
    const multiSheet = workbookSheets.length > 1;
    const variants = workbookSheets.length
      ? workbookSheets.map((sheet) => ({ sheetName: multiSheet ? sheet.name : null, label: sheet.name, fields: sheet.fields || [] }))
      : [{ sheetName: null, label: null, fields: template.fields || [] }];

    variants.forEach(({ sheetName, label, fields }) => {
      const fieldKeys = new Set(fields.map((field) => compact(field?.name)).filter(Boolean));
      if (!fieldKeys.size) return;
      const key = `${compact(published.name)}|${sheetName || ""}`;
      if (!candidates.has(key)) {
        const nameKeys = [compact(published.name)];
        if (label) nameKeys.push(compact(label), compact(`${published.name}${label}`));
        candidates.set(key, {
          key,
          name: published.name,
          sheetName,
          sheetLabel: multiSheet ? label : null,
          fieldKeys: new Set(),
          nameKeys,
          published: [],
        });
      }
      const candidate = candidates.get(key);
      fieldKeys.forEach((fieldKey) => candidate.fieldKeys.add(fieldKey));
      candidate.published.push(published);
    });
  });

  candidates.forEach((candidate) => candidate.published.sort(periodSort));
  return [...candidates.values()];
};

// Filas de todos los períodos de la plantilla, con las llaves normalizadas
const collectRows = async (candidate, email, advertencias) => {
  const rows = [];
  const periodos = [];
  for (const published of candidate.published) {
    try {
      const data = await fetchMergedRows(published._id, email, candidate.sheetName);
      if (data.length) periodos.push(published.period?.name || "Sin período");
      data.forEach((row) => {
        const record = new Map(Object.entries(row).map(([key, value]) => [compact(key), value]));
        record.periodo = published.period?.name || "";
        rows.push(record);
      });
    } catch (error) {
      advertencias.push(`No se pudo leer "${published.name}" (${published.period?.name || "sin período"}): ${error.message}`);
    }
  }
  return { rows, periodos };
};

// ── Endpoints ────────────────────────────────────────────────────────────────

controller.getPlantillas = async (req, res) => {
  try {
    await UserService.findUserByEmailAndRoles(req.query.email, ALLOWED_ROLES);
    const plantillas = await KpiPlantilla.find({}).sort({ createdAt: -1 }).lean();
    return res.status(200).json(plantillas);
  } catch (error) {
    console.error("[KPI] Error listando plantillas:", error);
    return res.status(500).json({ error: error.message });
  }
};

// Períodos que tienen plantillas publicadas con información cargada
controller.getOpciones = async (req, res) => {
  try {
    await UserService.findUserByEmailAndRoles(req.query.email, ALLOWED_ROLES);
    const publicadas = await PublishedTemplate.find({
      $or: [{ "loaded_data.0": { $exists: true } }, { "qr_draft_data.0": { $exists: true } }],
    })
      .select("period")
      .populate("period", "name")
      .lean();

    const periodMap = new Map();
    publicadas.forEach(({ period }) => {
      if (!period?._id) return;
      const id = String(period._id);
      if (!periodMap.has(id)) periodMap.set(id, { value: id, label: period.name, plantillas: 0 });
      periodMap.get(id).plantillas += 1;
    });

    const periodos = [...periodMap.values()].sort((a, b) => String(b.label).localeCompare(String(a.label)));
    return res.status(200).json({ periodos });
  } catch (error) {
    console.error("[KPI] Error consultando opciones:", error);
    return res.status(500).json({ error: error.message });
  }
};

controller.uploadPlantilla = async (req, res) => {
  const file = req.file;
  let prepared = null;
  try {
    const { email, name } = req.body;
    await UserService.findUserByEmailAndRoles(email, ALLOWED_ROLES);

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

// Llena el Excel KPI con la información de las plantillas del sistema. Cada
// hoja del Excel se empareja con la plantilla cuyos campos coinciden con sus
// encabezados; las hojas que no coinciden (cálculos, gráficos, tableros) y
// todas las fórmulas quedan exactamente como estaban.
controller.traerInformacion = async (req, res) => {
  try {
    const { email, periodIds = [] } = req.body || {};
    await UserService.findUserByEmailAndRoles(email, ALLOWED_ROLES);

    const plantilla = await KpiPlantilla.findById(req.params.id);
    if (!plantilla) return res.status(404).json({ error: "Plantilla no encontrada" });

    const query = { $or: [{ "loaded_data.0": { $exists: true } }, { "qr_draft_data.0": { $exists: true } }] };
    const selectedPeriods = Array.isArray(periodIds) ? periodIds.filter(Boolean) : [];
    if (selectedPeriods.length) query.period = { $in: selectedPeriods };
    const publicadas = await PublishedTemplate.find(query)
      .select("name period template.fields template.workbook_sheets")
      .populate("period", "name")
      .lean();

    if (!publicadas.length) {
      return res.status(400).json({ error: "No hay plantillas con información cargada en los períodos seleccionados." });
    }

    const book = new KpiWorkbook(await downloadDriveFileBuffer(plantilla.drive_file_id));
    const candidates = buildCandidates(publicadas);
    const advertencias = [];
    const hojas = [];
    const hojasSinCambios = [];
    const filledSheets = [];
    const rowsCache = new Map();

    for (const sheet of book.sheets) {
      const match = matchSheet(book, sheet, candidates);
      if (!match) {
        hojasSinCambios.push(sheet.name);
        continue;
      }

      const { candidate } = match;
      if (!rowsCache.has(candidate.key)) rowsCache.set(candidate.key, await collectRows(candidate, email, advertencias));
      const { rows, periodos } = rowsCache.get(candidate.key);

      // "Dependencia" y "Período" se llenan aunque no sean campos de la
      // plantilla, para distinguir las filas de cada productor y período.
      const extraColumns = {};
      if (!candidate.fieldKeys.has("dependencia")) extraColumns.dependencia = (record) => record.get("dependencia");
      if (!candidate.fieldKeys.has("periodo")) extraColumns.periodo = (record) => record.periodo;

      const result = fillSheet(book, sheet, match, rows, extraColumns);
      advertencias.push(...result.advertencias);
      filledSheets.push({ name: sheet.name, headerRow: result.headerRow, lastRow: result.lastRow });
      hojas.push({
        hoja: sheet.name,
        plantilla: candidate.sheetLabel ? `${candidate.name} · ${candidate.sheetLabel}` : candidate.name,
        periodos,
        filas: rows.length,
        columnas: result.columnas.length,
        sinCoincidencia: result.sinCoincidencia.slice(0, 15),
        formulasExtendidas: result.formulasExtendidas.slice(0, 15),
      });
    }

    if (!hojas.length) {
      return res.status(400).json({
        error: "Ninguna hoja del Excel tiene encabezados que coincidan con los campos de las plantillas del sistema. Los encabezados deben llamarse igual que los campos de la plantilla.",
      });
    }

    book.finalize(filledSheets);
    const outputBuffer = book.toBuffer();

    plantilla.last_run_at = new Date();
    plantilla.last_run_by = email;
    await plantilla.save();

    const resumen = { hojas, hojasSinCambios: hojasSinCambios.slice(0, 30), advertencias: advertencias.slice(0, 20) };
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

module.exports = controller;
