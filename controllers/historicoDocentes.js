const fs = require("fs");
const ExcelJS = require("exceljs");
const HistoricoDocentes = require("../models/historicoDocentes");
const mongoose = require("mongoose");
const Dependency = require("../models/dependencies");
const Dimension = require("../models/dimensions");
const User = require("../models/users");
const UserService = require("../services/users");
const { buildResumenArchivo } = require("../services/historicoResumen");
const { findSniesMatch, applyToSnies } = require("../services/consultaSnies");
const PublishedTemplate = require("../models/publishedTemplates");
const Period = require("../models/periods");
const {
  isChunked,
  rowsKey,
  sheetRowCount,
  saveFileToGridFS,
  getGridFSFileInfo,
  openGridFSStream,
  readGridFSBuffer,
  parseExcelToChunks,
  parseCsvToChunks,
  forEachSheetRow,
  readRowsRange,
  scanRows,
  buildResumenFromChunks,
  addStudentProgramColumnToChunks,
  deleteStoredData,
} = require("../services/historicoStorage");
const {
  downloadDriveFileBuffer,
} = require("../config/googleDrive");

const controller = {};

const VALID_CATEGORIES = ['snies', 'plantillas', 'informes'];
const EXCEL_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_CONTENT_TYPE = "application/pdf";
const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

// Procesamiento en segundo plano de las cargas: el registro queda en
// "procesando" con un latido periódico. Si el latido se detiene (el proceso
// se reinició a mitad de la carga) se reporta como error.
const HEARTBEAT_MS = 30 * 1000;
const PROGRESS_UPDATE_MS = 5 * 1000;
const STALE_PROCESSING_MS = 5 * 60 * 1000;
// Por encima de este tamaño el Excel original se entrega tal cual, sin
// resaltar el encabezado (hacerlo exige cargar el libro completo en memoria).
const DOWNLOAD_STYLE_MAX_BYTES = 20 * 1024 * 1024;

// Los miembros de AYUDAS EDUCATIVAS (sin importar si su rol es Responsable o
// Productor) pueden cargar Plantillas en Consulta de Información, solo dentro
// del ámbito "Recursos Físicos y Tecnológicos". El resto de cargas (Informes,
// SNIES, otros ámbitos) siguen siendo exclusivas del Administrador.
const AYUDAS_EDUCATIVAS_DEP_CODE = "040";
const AYUDAS_EDUCATIVAS_DIMENSION_NAME = "recursos fisicos y tecnologicos";

const normalizeName = (name) =>
  String(name || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");

const isAyudasEducativasDimension = async (dimensionId) => {
  if (!dimensionId || !mongoose.isValidObjectId(dimensionId)) return false;
  const dimension = await Dimension.findById(dimensionId).select("name").lean();
  return normalizeName(dimension?.name) === AYUDAS_EDUCATIVAS_DIMENSION_NAME;
};

const isAdminUser = (user) =>
  user?.activeRole === "Administrador" || (user?.roles || []).includes("Administrador");

// La pertenencia puede estar en user.dep_code, user.additional_dependencies o
// dependencies.members/responsible (mismo criterio que publishedTemplates).
const isAyudasEducativasMember = async (user, email) => {
  const declaredCodes = [user?.dep_code, ...(user?.additional_dependencies || [])].filter(Boolean);
  if (declaredCodes.includes(AYUDAS_EDUCATIVAS_DEP_CODE)) return true;
  const dep = await Dependency.exists({
    dep_code: AYUDAS_EDUCATIVAS_DEP_CODE,
    $or: [{ members: email }, { responsible: email }],
  });
  return !!dep;
};

const getUploadPermissions = async (user, email, dimensionId) => {
  if (isAdminUser(user)) return { plantillas: true, informes: true, snies: true };
  const ayudas =
    (await isAyudasEducativasDimension(dimensionId)) && (await isAyudasEducativasMember(user, email));
  return { plantillas: ayudas, informes: false, snies: false };
};

// Correos (normalizados) de todos los miembros de AYUDAS EDUCATIVAS, con el
// mismo criterio de pertenencia que isAyudasEducativasMember.
const getAyudasEducativasEmails = async () => {
  const [users, dependency] = await Promise.all([
    User.find({
      $or: [
        { dep_code: AYUDAS_EDUCATIVAS_DEP_CODE },
        { additional_dependencies: AYUDAS_EDUCATIVAS_DEP_CODE },
      ],
    }).select("email").lean(),
    Dependency.findOne({ dep_code: AYUDAS_EDUCATIVAS_DEP_CODE }).select("members responsible").lean(),
  ]);
  return new Set(
    [
      ...users.map((u) => u.email),
      ...(dependency?.members || []),
      dependency?.responsible,
    ].filter(Boolean).map(normalizeName)
  );
};

// Renombrar/eliminar: el Administrador puede con cualquier archivo; los
// miembros de AYUDAS EDUCATIVAS (con permiso de carga en ese ámbito) pueden
// con cualquier archivo que haya cargado alguien de AYUDAS EDUCATIVAS.
// Devuelve una función registro -> boolean para evaluar varios archivos a la vez.
const buildFileManager = async (email, dimensionId) => {
  let user;
  try {
    user = await UserService.findUserByEmail(email, null);
  } catch {
    return () => false;
  }
  if (isAdminUser(user)) return () => true;
  const permissions = await getUploadPermissions(user, email, dimensionId);
  if (!Object.values(permissions).some(Boolean)) return () => false;
  const ayudasEmails = await getAyudasEducativasEmails();
  return (registro) =>
    !!permissions[registro.category || "snies"] &&
    ayudasEmails.has(normalizeName(registro.uploaded_by?.email));
};

const canManageFile = async (registro, email) =>
  (await buildFileManager(email, registro.dimension))(registro);

const INVALID_WORKSHEET_CHARS = /[\\/*?:\[\]]/g;

const sanitizeWorksheetName = (name, index, usedNames) => {
  const fallback = `Hoja ${index + 1}`;
  const baseName = String(name || fallback)
    .replace(INVALID_WORKSHEET_CHARS, " ")
    .trim()
    .slice(0, 31) || fallback;

  let candidate = baseName;
  let suffix = 1;
  while (usedNames.has(candidate.toLowerCase())) {
    const suffixText = ` ${suffix}`;
    candidate = `${baseName.slice(0, 31 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
};

const buildWorkbookBufferFromSheets = async (sheets = []) => {
  if (!Array.isArray(sheets) || sheets.length === 0) return null;

  const workbook = new ExcelJS.Workbook();
  const usedNames = new Set();

  sheets.forEach((sheet, index) => {
    const worksheetName = sanitizeWorksheetName(sheet?.name, index, usedNames);
    const worksheet = workbook.addWorksheet(worksheetName);
    const headers = Array.isArray(sheet?.headers) ? sheet.headers : [];
    const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];

    if (headers.length > 0) {
      worksheet.addRow(headers);
    }

    rows.forEach((row) => {
      const values = Array.isArray(row) ? row : [];
      worksheet.addRow(headers.length > 0 ? headers.map((_, i) => values[i] ?? "") : values);
    });
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
};

// Violeta institucional (el mismo acento usado en los iconos y titulos del
// modulo Consulta de Informacion), con texto blanco para que el encabezado
// resalte con fuerza en el Excel descargado.
const HEADER_FILL_COLOR = "FF7C3AED";
const HEADER_FONT_COLOR = "FFFFFFFF";

const applyHeaderRowStyle = (workbook) => {
  workbook.worksheets.forEach((worksheet) => {
    if (worksheet.rowCount === 0) return;

    let headerRowIndex = 1;
    let maxCells = 0;
    for (let r = 1; r <= Math.min(10, worksheet.rowCount); r++) {
      const row = worksheet.getRow(r);
      let cellCount = 0;
      row.eachCell({ includeEmpty: false }, () => cellCount++);
      if (cellCount > maxCells) {
        maxCells = cellCount;
        headerRowIndex = r;
      }
    }

    const headerRow = worksheet.getRow(headerRowIndex);
    headerRow.eachCell({ includeEmpty: false }, (cell) => {
      cell.font = { ...(cell.font || {}), bold: true, color: { argb: HEADER_FONT_COLOR } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL_COLOR } };
    });
  });
};

const safeDownloadFileName = (fileName, fallback = "archivo.xlsx") => {
  const cleanName = String(fileName || "").trim() || fallback;
  return cleanName.replace(/[\r\n"]/g, "");
};

const setAttachmentHeaders = (res, fileName, contentType) => {
  const safeName = safeDownloadFileName(fileName);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
  );
  res.setHeader("Content-Type", contentType);
};

const removeTempFile = (filePath) => {
  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
};

const effectiveStatus = (registro) => {
  if (registro.status !== "procesando") return registro.status || "listo";
  const heartbeat = registro.progress?.heartbeat || registro.updatedAt;
  const stale = heartbeat && Date.now() - new Date(heartbeat).getTime() > STALE_PROCESSING_MS;
  return stale ? "error" : "procesando";
};

const effectiveErrorMessage = (registro) => {
  if (effectiveStatus(registro) !== "error") return null;
  return registro.error_message || "El procesamiento del archivo se interrumpió. Vuelve a cargarlo.";
};

const pipeGridFS = (res, fileId) =>
  new Promise((resolve) => {
    openGridFSStream(fileId)
      .on("error", (error) => {
        console.error("Error leyendo archivo de GridFS:", error.message);
        if (!res.headersSent) res.status(404).json({ message: "Archivo no encontrado." });
        else res.destroy();
        resolve();
      })
      .on("end", resolve)
      .pipe(res);
  });

// GET /historico-docentes/list?category=&email=&periodId=&dimensionId=
controller.listFiles = async (req, res) => {
  const { category = 'snies', email, periodId, dimensionId } = req.query;

  if (!email) return res.status(400).json({ message: "El email es requerido." });

  try {
    // También se listan las cargas en proceso o fallidas, para que el usuario
    // vea su estado (y pueda eliminar las fallidas).
    const query = {
      $and: [
        { $or: [{ active: true }, { status: { $in: ['procesando', 'error'] } }] },
        {
          $or: [
            { category },
            ...(category === 'snies' ? [{ category: { $exists: false } }] : [])
          ]
        },
      ],
    };

    // Filtrar por período solo para plantillas e informes
    if (category !== 'snies' && periodId) {
      query.period = periodId;
    }

    // Filtrar por ámbito/dimensión (vista "Información enviada por Ámbitos").
    // Si no se pide, se mantiene el comportamiento anterior (todos los
    // archivos de la categoría, sin importar el ámbito).
    if (dimensionId) {
      query.dimension = dimensionId;
    }

    const files = await HistoricoDocentes.find(query)
      .select('_id file_name uploaded_by updatedAt createdAt category file_type sheets anexos dimension cloned_from status progress error_message')
      .sort({ createdAt: -1 });

    const canManage = await buildFileManager(email, dimensionId);

    return res.status(200).json({
      files: files.map(f => ({
        can_manage: canManage(f),
        _id: f._id,
        file_name: f.file_name,
        uploaded_by: f.uploaded_by,
        updatedAt: f.updatedAt,
        createdAt: f.createdAt,
        category: f.category || 'snies',
        file_type: f.file_type || 'excel',
        dimension: f.dimension || null,
        cloned_from: f.cloned_from || null,
        status: effectiveStatus(f),
        progress: { rows: f.progress?.rows || 0, step: f.progress?.step || null },
        error_message: effectiveErrorMessage(f),
        anexosCount: (f.anexos || []).length,
        anexosNames: (f.anexos || []).map(a => a.file_name),
        sheetsInfo: (f.sheets || []).map((s, i) => ({
          index: i,
          name: s.name,
          totalRows: sheetRowCount(s),
        })),
      }))
    });
  } catch (error) {
    console.error("Error listando archivos:", error);
    return res.status(500).json({ message: "Error al listar los archivos.", error: error.message });
  }
};

// GET /historico-docentes/upload-permissions?email=&dimensionId=
// Indica en qué categorías puede cargar archivos el usuario dentro del ámbito.
controller.uploadPermissions = async (req, res) => {
  const { email, dimensionId } = req.query;
  if (!email) return res.status(400).json({ message: "El email es requerido." });

  try {
    const user = await UserService.findUserByEmail(email, null);
    return res.status(200).json(await getUploadPermissions(user, email, dimensionId));
  } catch (error) {
    return res.status(200).json({ plantillas: false, informes: false, snies: false });
  }
};

// POST /historico-docentes/:id/clone-to-dimension
// Copia un archivo existente (ej. el Histórico Docentes SNIES) dentro de un
// ámbito, con la categoría indicada (por defecto "plantillas"). Si ya se
// habia agregado antes a ese mismo ámbito, REEMPLAZA la copia en vez de
// duplicarla (idéntico criterio que el envío final a SNIES).
controller.cloneToDimension = async (req, res) => {
  const { id } = req.params;
  const { dimensionId, category = "plantillas", email, periodId } = req.body;

  if (!dimensionId) return res.status(400).json({ message: "dimensionId es requerido." });
  if (!VALID_CATEGORIES.includes(category)) return res.status(400).json({ message: "Categoría no válida." });

  try {
    const source = await HistoricoDocentes.findById(id);
    if (!source) return res.status(404).json({ message: "Archivo de origen no encontrado." });
    if (effectiveStatus(source) !== "listo") {
      return res.status(409).json({ message: "El archivo de origen todavía no está listo." });
    }
    // Un archivo guardado por bloques no se copia: la copia reutiliza los
    // bloques y el archivo GridFS del original.
    const chunked = isChunked(source);

    let user = null;
    if (email) {
      try { user = await UserService.findUserByEmail(email, null); } catch {}
    }

    const clone = await HistoricoDocentes.findOneAndUpdate(
      { cloned_from: source._id, dimension: dimensionId },
      {
        $set: {
          file_name: source.file_name,
          uploaded_by: user ? { full_name: user.full_name || user.name, email: user.email } : source.uploaded_by,
          file_type: source.file_type,
          excel_data: source.excel_data,
          pdf_data: source.pdf_data,
          storage: source.storage || 'inline',
          file_id: source.file_id || null,
          rows_source: chunked ? rowsKey(source) : null,
          status: 'listo',
          sheets: source.sheets,
          resumen: source.resumen || (chunked ? null : buildResumenArchivo(source.file_name, source.sheets)),
          category,
          // El listado de un ámbito filtra por período seleccionado (igual
          // que las demás plantillas): sin esto, la copia quedaba con
          // period=null y no aparecía en el listado del período activo.
          period: periodId || null,
          dimension: dimensionId,
          cloned_from: source._id,
          active: true,
        },
      },
      { upsert: true, new: true }
    );

    return res.status(200).json({
      message: "Archivo agregado al ámbito correctamente.",
      registro: { _id: clone._id, file_name: clone.file_name },
    });
  } catch (error) {
    console.error("Error clonando archivo al ámbito:", error);
    return res.status(500).json({ message: "No se pudo agregar el archivo al ámbito.", error: error.message });
  }
};

// DELETE /historico-docentes/:id
controller.deleteFile = async (req, res) => {
  const { id } = req.params;
  const { email } = req.query;

  if (!email) return res.status(400).json({ message: "El email es requerido." });

  try {
    const registro = await HistoricoDocentes.findById(id).select("uploaded_by category dimension storage file_id rows_source");
    if (!registro) return res.status(404).json({ message: "Archivo no encontrado." });
    if (!(await canManageFile(registro, email))) {
      return res.status(403).json({ message: "No tienes permiso para eliminar este archivo." });
    }

    await HistoricoDocentes.findByIdAndDelete(id);
    await deleteStoredData(registro);
    return res.status(200).json({ message: "Archivo eliminado correctamente." });
  } catch (error) {
    console.error("Error eliminando archivo:", error);
    return res.status(500).json({ message: "Error al eliminar el archivo.", error: error.message });
  }
};

// Lleva el archivo ya procesado a su plantilla SNIES publicada y lo deja como
// la copia de esa plantilla en el ámbito (reemplaza la que dejó un envío final
// anterior, igual que hace saveToConsultaInformacion).
const syncWithSnies = async (registro, sheets, pubTemId, user) => {
  try {
    const stored = { _id: registro._id, storage: "chunked", file_name: registro.file_name, sheets };
    const result = await applyToSnies(stored, pubTemId, user);

    const previous = await HistoricoDocentes.find({
      _id: { $ne: registro._id },
      source_published_template: pubTemId,
      dimension: registro.dimension || null,
    }).select("_id storage file_id rows_source").lean();
    for (const old of previous) {
      await HistoricoDocentes.deleteOne({ _id: old._id });
      await deleteStoredData(old);
    }

    return {
      source_published_template: pubTemId,
      snies_sync: { published_template: pubTemId, name: result.name, status: "ok", filas: result.filas, dependencias: result.dependencias, date: new Date() },
    };
  } catch (error) {
    console.error("[HistoricoDocentes] Error cargando la plantilla en SNIES:", error);
    return {
      snies_sync: { published_template: pubTemId, status: "error", message: error.message, date: new Date() },
    };
  }
};

// Guarda el archivo en GridFS, lo lee por streaming y deja sus filas por
// bloques. Corre después de responder la carga; el resultado queda en el
// campo "status" del registro (ver uploadStatus).
const processUpload = async (registro, filePath, { isPdf, isCsv, sniesPubTemId = null, user = null }) => {
  const id = registro._id;
  const setFields = (fields) =>
    HistoricoDocentes.updateOne({ _id: id }, { $set: { ...fields, "progress.heartbeat": new Date() } });
  const heartbeat = setInterval(() => { setFields({}).catch(() => {}); }, HEARTBEAT_MS);

  let lastProgressAt = 0;
  const onProgress = async (rows) => {
    if (Date.now() - lastProgressAt < PROGRESS_UPDATE_MS) return;
    lastProgressAt = Date.now();
    await setFields({ "progress.rows": rows });
  };

  let fileId = null;
  try {
    const contentType = isPdf ? PDF_CONTENT_TYPE : isCsv ? CSV_CONTENT_TYPE : EXCEL_CONTENT_TYPE;
    fileId = await saveFileToGridFS(filePath, registro.file_name, contentType);
    await setFields({ file_id: fileId, "progress.step": isPdf ? "finalizando" : "leyendo" });

    let sheets = [];
    let resumen = null;
    if (!isPdf) {
      const csvSheetName = registro.file_name.replace(/\.csv$/i, "").slice(0, 31) || "Hoja 1";
      sheets = isCsv
        ? await parseCsvToChunks(filePath, id, csvSheetName, onProgress)
        : await parseExcelToChunks(filePath, id, onProgress);
      if (sheets.length < 1) {
        const error = new Error("El archivo no contiene hojas válidas.");
        error.userMessage = error.message;
        throw error;
      }
      const totalRows = sheets.reduce((sum, sheet) => sum + sheet.totalRows, 0);
      await setFields({ "progress.rows": totalRows, "progress.step": "calculando" });

      const stored = { _id: id, storage: "chunked", file_name: registro.file_name };
      // Programa de cada estudiante (ej. Trabajo de Grado) calculado UNA sola
      // vez al subir y guardado como columna fija PROGRAMA_ESTUDIANTE.
      sheets = await addStudentProgramColumnToChunks(stored, sheets);
      // Cifras fijas (ej. total de matriculados) calculadas una sola vez aquí.
      resumen = await buildResumenFromChunks(stored, sheets);
    }

    // Solo para SNIES se reemplaza el archivo anterior (una vez que el nuevo
    // quedó guardado completo).
    if (registro.category === "snies") {
      const previous = await HistoricoDocentes.find({
        _id: { $ne: id },
        $or: [{ category: "snies" }, { category: { $exists: false } }],
      }).select("_id storage file_id rows_source").lean();
      for (const old of previous) {
        await HistoricoDocentes.deleteOne({ _id: old._id });
        await deleteStoredData(old);
      }
    }

    // Plantilla SNIES: la información del archivo queda como envío final en
    // SNIES. Si falla, el archivo igual queda cargado en Consulta.
    let sniesFields = {};
    if (sniesPubTemId && !isPdf) {
      await setFields({ "progress.step": "snies" });
      sniesFields = await syncWithSnies(registro, sheets, sniesPubTemId, user);
    }

    await setFields({
      ...sniesFields,
      sheets,
      resumen,
      status: "listo",
      active: true,
      error_message: null,
      "progress.step": null,
    });
  } catch (error) {
    console.error("Error al procesar archivo cargado:", error);
    await setFields({
      status: "error",
      active: false,
      file_id: null,
      error_message: error.userMessage || `Error al procesar el archivo: ${error.message}`,
      "progress.step": null,
    }).catch(() => {});
    await deleteStoredData({ _id: id, storage: "chunked", file_id: fileId })
      .catch((cleanupError) => console.error("No se pudieron limpiar los datos de la carga fallida:", cleanupError.message));
  } finally {
    clearInterval(heartbeat);
    removeTempFile(filePath);
  }
};

// POST /historico-docentes/upload
// Recibe el archivo y responde 202 de inmediato; el procesamiento sigue en
// segundo plano y se consulta con GET /historico-docentes/:id/status.
controller.upload = async (req, res) => {
  const { email, category = 'snies' } = req.body;
  const tempPath = req.file?.path;

  if (!email) {
    removeTempFile(tempPath);
    return res.status(400).json({ message: "El email es requerido." });
  }
  if (!VALID_CATEGORIES.includes(category)) {
    removeTempFile(tempPath);
    return res.status(400).json({ message: "Categoría no válida." });
  }
  if (!req.file) return res.status(400).json({ message: "El archivo es requerido." });

  let user;
  try {
    user = await UserService.findUserByEmail(email, null);
  } catch (error) {
    removeTempFile(tempPath);
    return res.status(404).json({ message: "Usuario no encontrado." });
  }

  const permissions = await getUploadPermissions(user, email, req.body.dimensionId);
  if (!permissions[category]) {
    removeTempFile(tempPath);
    return res.status(403).json({ message: "No tienes permiso para cargar archivos en esta categoría." });
  }

  const fileName = req.file.originalname;
  const ext = fileName.toLowerCase();
  const isPdf = ext.endsWith(".pdf");
  const isCsv = ext.endsWith(".csv");
  const isExcel = ext.endsWith(".xlsx") || ext.endsWith(".xlsm");

  // PDF solo permitido en informes
  if (isPdf && category !== 'informes') {
    removeTempFile(tempPath);
    return res.status(400).json({ message: "Los archivos PDF solo se pueden cargar en la categoría Informes." });
  }
  if (!isPdf && !isExcel && !isCsv) {
    removeTempFile(tempPath);
    return res.status(400).json({ message: "Solo se aceptan archivos .xlsx, .xlsm, .csv o .pdf." });
  }

  // Plantilla SNIES (detectada con /snies-match): solo el Administrador puede
  // dejarla como envío final.
  const sniesPubTemId = req.body.sniesPubTemId || null;
  let periodId = req.body.periodId || null;
  if (sniesPubTemId) {
    if (!permissions.snies || category !== "plantillas" || isPdf || !mongoose.isValidObjectId(sniesPubTemId)) {
      removeTempFile(tempPath);
      return res.status(403).json({ message: "No tienes permiso para cargar esta plantilla en SNIES." });
    }
    // El archivo queda en el período de su plantilla SNIES
    const sniesTemplate = await PublishedTemplate.findById(sniesPubTemId).select("period").lean();
    if (sniesTemplate?.period) periodId = String(sniesTemplate.period);
  }

  // Plantillas e Informes siempre quedan en un período (igual que en SNIES).
  // Si no llegó el del selector, se usa el período activo más reciente, que
  // es el mismo que el selector escoge por defecto.
  if (category !== "snies") {
    if (periodId && !mongoose.isValidObjectId(periodId)) periodId = null;
    if (!periodId) {
      const active = await Period.findOne({ is_active: true }).sort({ end_date: -1 }).select("_id").lean();
      periodId = active?._id ? String(active._id) : null;
    }
    if (!periodId) {
      removeTempFile(tempPath);
      return res.status(400).json({ message: "Selecciona un período antes de cargar el archivo." });
    }
  }

  try {
    const registro = await HistoricoDocentes.create({
      file_name: fileName,
      uploaded_by: { full_name: user.full_name || user.name, email: user.email },
      file_type: isPdf ? 'pdf' : 'excel',
      storage: 'chunked',
      status: 'procesando',
      progress: { rows: 0, step: 'guardando', heartbeat: new Date() },
      sheets: [],
      category,
      period: (category !== 'snies' && periodId) ? periodId : null,
      dimension: (category !== 'snies' && req.body.dimensionId) ? req.body.dimensionId : null,
      // Queda inactivo (invisible para el Tablero y las consultas) hasta que
      // termine de procesarse.
      active: false,
    });

    processUpload(registro, tempPath, { isPdf, isCsv, sniesPubTemId, user });

    return res.status(202).json({
      message: "Archivo recibido. Se está procesando.",
      registro: {
        _id: registro._id,
        file_name: registro.file_name,
        uploaded_by: registro.uploaded_by,
        file_type: registro.file_type,
        category: registro.category,
        status: registro.status,
        createdAt: registro.createdAt,
      },
    });
  } catch (error) {
    console.error("Error al cargar archivo:", error);
    removeTempFile(tempPath);
    return res.status(500).json({ message: "Error al procesar el archivo.", error: error.message });
  }
};

// POST /historico-docentes/snies-match
// Indica si el archivo que se va a cargar en Plantillas corresponde a una
// plantilla SNIES publicada del período. El frontend envía el nombre del
// archivo y las primeras filas de cada hoja (candidatas a encabezado).
controller.sniesMatch = async (req, res) => {
  const { email, periodId, fileName, sheets } = req.body || {};
  try {
    const user = await UserService.findUserByEmail(email, null);
    const permissions = await getUploadPermissions(user, email, req.body?.dimensionId);
    if (!permissions.snies || (periodId && !mongoose.isValidObjectId(periodId))) {
      return res.status(200).json({ match: null });
    }

    const uploadedSheets = (Array.isArray(sheets) ? sheets : []).slice(0, 50).map((sheet) => ({
      name: String(sheet?.name || ""),
      headerOptions: (Array.isArray(sheet?.rows) ? sheet.rows : [])
        .slice(0, 10)
        .map((row) => (Array.isArray(row) ? row.slice(0, 500).map((cell) => String(cell ?? "")) : [])),
    }));

    const match = await findSniesMatch({ periodId: periodId || null, fileName, sheets: uploadedSheets });
    return res.status(200).json({ match });
  } catch (error) {
    console.error("Error detectando plantilla SNIES:", error);
    return res.status(500).json({ message: "No se pudo verificar si la plantilla es de SNIES.", error: error.message });
  }
};

// GET /historico-docentes/:id/status — estado del procesamiento de una carga
controller.uploadStatus = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return res.status(400).json({ message: "Id no válido." });

  try {
    const registro = await HistoricoDocentes.findById(id)
      .select("file_name status progress error_message snies_sync updatedAt")
      .lean();
    if (!registro) return res.status(404).json({ message: "Archivo no encontrado." });

    return res.status(200).json({
      _id: registro._id,
      file_name: registro.file_name,
      status: effectiveStatus(registro),
      progress: { rows: registro.progress?.rows || 0, step: registro.progress?.step || null },
      error_message: effectiveErrorMessage(registro),
      snies_sync: registro.snies_sync || null,
    });
  } catch (error) {
    return res.status(500).json({ message: "Error al consultar el estado del archivo.", error: error.message });
  }
};

// GET /historico-docentes/:id/pdf  — sirve el PDF principal
controller.viewPdf = async (req, res) => {
  const { id } = req.params;
  try {
    const registro = await HistoricoDocentes.findById(id).select('file_name file_type pdf_data file_id');
    if (!registro || registro.file_type !== 'pdf' || (!registro.pdf_data && !registro.file_id))
      return res.status(404).json({ message: "PDF no encontrado." });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${registro.file_name}"`);
    if (registro.file_id) return pipeGridFS(res, registro.file_id);
    return res.send(registro.pdf_data);
  } catch (error) {
    return res.status(500).json({ message: "Error al obtener el PDF.", error: error.message });
  }
};

// POST /historico-docentes/:id/anexos  — adjunta un PDF como anexo
controller.addAnexo = async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;
  if (!req.file) return res.status(400).json({ message: "El archivo PDF es requerido." });

  const ext = req.file.originalname.toLowerCase();
  const validAnexo = ext.endsWith(".pdf") || ext.endsWith(".xlsx") || ext.endsWith(".xlsm");
  if (!validAnexo) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ message: "Solo se aceptan archivos PDF o Excel como anexos." });
  }

  try {
    const registro = await HistoricoDocentes.findById(id);
    if (!registro) return res.status(404).json({ message: "Informe no encontrado." });

    let user = null;
    try { user = await UserService.findUserByEmail(email, null); } catch {}

    const buffer = fs.readFileSync(req.file.path);
    const anexo = {
      file_name: req.file.originalname,
      uploaded_by: user ? { full_name: user.full_name || user.name, email: user.email } : { email },
      pdf_data: buffer,
      createdAt: new Date(),
    };

    registro.anexos.push(anexo);
    await registro.save();
    fs.unlinkSync(req.file.path);

    const saved = registro.anexos[registro.anexos.length - 1];
    return res.status(201).json({
      message: "Anexo adjuntado correctamente.",
      anexo: { _id: saved._id, file_name: saved.file_name, uploaded_by: saved.uploaded_by, createdAt: saved.createdAt },
    });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(500).json({ message: "Error al adjuntar el anexo.", error: error.message });
  }
};

// GET /historico-docentes/:id/anexos/:anexoId  — sirve un anexo PDF
controller.viewAnexo = async (req, res) => {
  const { id, anexoId } = req.params;
  try {
    const registro = await HistoricoDocentes.findById(id).select('anexos');
    if (!registro) return res.status(404).json({ message: "Informe no encontrado." });
    const anexo = registro.anexos.id(anexoId);
    if (!anexo || !anexo.pdf_data) return res.status(404).json({ message: "Anexo no encontrado." });
    const fn = anexo.file_name.toLowerCase();
    const isPdf = fn.endsWith(".pdf");
    const contentType = isPdf ? "application/pdf"
      : fn.endsWith(".xlsx") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "application/vnd.ms-excel";
    const disposition = isPdf && !req.query.download ? "inline" : "attachment";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `${disposition}; filename="${anexo.file_name}"`);
    return res.send(anexo.pdf_data);
  } catch (error) {
    return res.status(500).json({ message: "Error al obtener el anexo.", error: error.message });
  }
};

// DELETE /historico-docentes/:id/anexos/:anexoId
controller.deleteAnexo = async (req, res) => {
  const { id, anexoId } = req.params;
  try {
    const registro = await HistoricoDocentes.findById(id);
    if (!registro) return res.status(404).json({ message: "Informe no encontrado." });
    const anexo = registro.anexos.id(anexoId);
    if (!anexo) return res.status(404).json({ message: "Anexo no encontrado." });
    anexo.deleteOne();
    await registro.save();
    return res.status(200).json({ message: "Anexo eliminado." });
  } catch (error) {
    return res.status(500).json({ message: "Error al eliminar el anexo.", error: error.message });
  }
};

// GET /historico-docentes/:id/anexos  — lista los anexos de un informe
controller.listAnexos = async (req, res) => {
  const { id } = req.params;
  try {
    const registro = await HistoricoDocentes.findById(id).select('anexos');
    if (!registro) return res.status(404).json({ message: "Informe no encontrado." });
    const list = (registro.anexos || []).map(a => ({
      _id: a._id,
      file_name: a.file_name,
      uploaded_by: a.uploaded_by,
      createdAt: a.createdAt,
    }));
    return res.status(200).json({ anexos: list });
  } catch (error) {
    return res.status(500).json({ message: "Error al listar los anexos.", error: error.message });
  }
};

const normalizeHeader = (h) =>
  (h || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// Igual que normalizeHeader, pero además colapsa espacios/guiones bajos para
// poder comparar encabezados por igualdad exacta sin importar el separador
// usado (ej. "Email Institucional" y "EMAIL_INSTITUCIONAL" coinciden).
const collapseHeader = (h) =>
  String(h || "").trim().toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Z]/g, "");

// Mismos nombres que HIDDEN_COLUMN_NAMES en el frontend (FileLibraryPanel.tsx):
// la cedula/documento ya viene en los datos guardados (ver saveToHistorico en
// controllers/publishedTemplates.js), pero solo debe salir del servidor para
// el rol Administrador — para cualquier otro rol se quita aqui antes de
// responder, tanto en la vista como en la descarga (ocultarla solo en el
// frontend no alcanza: el JSON/Excel seguirian trayendo el dato).
const DOCUMENT_HEADER_NAMES = new Set([
  "DOCUMENTO", "NUMDOCUMENTO", "NERODOCUMENTO", "NUMERODOCUMENTO",
  "NERODEDOCUMENTO", "NUMERODEDOCUMENTO", "NRODOCUMENTO", "NODOCUMENTO",
  "IDDOCUMENTO", "NDOCUMENTO",
  "IDENTIFICACION", "NUMEROIDENTIFICACION", "NUMERODEIDENTIFICACION",
  "NROIDENTIFICACION", "NOIDENTIFICACION", "IDIDENTIFICACION",
  "IDENTIFICACIONBENEFICIARIO", "IDENTIFICATION",
  "CEDULA", "NUMEROCEDULA", "CEDULACIUDADANIA", "CEDULADECIUDADANIA",
  "DOCIDENTIDAD",
]);
// Variantes con sufijo de rol (ej. "NUM_DOCUMENTO_Estudiante",
// "NUM_DOCUMENTO_Docente Tutor", "Cédula del director"): se ocultan por
// prefijo. Ninguno empieza por "TIPO", así que ID_TIPO_DOCUMENTO_* se conserva.
const DOCUMENT_HEADER_PREFIXES = [
  "NUMDOCUMENTO", "NUMERODOCUMENTO", "NUMERODEDOCUMENTO", "NRODOCUMENTO", "NODOCUMENTO",
  "NUMEROIDENTIFICACION", "NUMERODEIDENTIFICACION", "NROIDENTIFICACION", "NOIDENTIFICACION",
  "CEDULA", "NUMEROCEDULA",
];
const isDocumentHeader = (h) => {
  const collapsed = collapseHeader(h);
  return DOCUMENT_HEADER_NAMES.has(collapsed) || DOCUMENT_HEADER_PREFIXES.some((prefix) => collapsed.startsWith(prefix));
};

const isRequesterAdmin = async (email) => {
  try {
    await UserService.findUserByEmailAndRoles(email, ["Administrador"]);
    return true;
  } catch {
    return false;
  }
};

// Quita las columnas de documento/cedula de un header+rows (una sola hoja).
const documentColumnIndexes = (headers) =>
  headers
    .map((h, index) => (isDocumentHeader(h) ? index : -1))
    .filter((index) => index >= 0);

const stripDocumentColumn = (headers, rows) => {
  const dropIndexes = documentColumnIndexes(headers);
  if (dropIndexes.length === 0) return { headers, rows };

  const keep = (arr) => arr.filter((_, index) => !dropIndexes.includes(index));
  return { headers: keep(headers), rows: rows.map((row) => keep(row)) };
};

// Igual que stripDocumentColumn, pero para todas las hojas de un archivo
// (usado en la descarga completa del Excel).
const stripDocumentColumnFromSheets = (sheets) =>
  (sheets || []).map((sheet) => {
    const { headers, rows } = stripDocumentColumn(sheet.headers || [], sheet.rows || []);
    return { name: sheet.name, headers, rows };
  });

// GET /historico-docentes/data?email=&category=&id=&sheet=&page=&limit=&year=&search=
controller.getData = async (req, res) => {
  const { email, sheet, page = 1, limit = 100, year, yearFrom, yearTo, category = 'snies', id } = req.query;

  if (!email) return res.status(400).json({ message: "El email es requerido." });

  try {
    let registro;

    if (id) {
      // Consulta por ID específico (para plantillas/informes)
      registro = await HistoricoDocentes.findById(id);
    } else {
      // Consulta del más reciente (para SNIES)
      const query = {
        active: true,
        $or: [
          { category },
          ...(category === 'snies' ? [{ category: { $exists: false } }] : [])
        ]
      };
      registro = await HistoricoDocentes.findOne(query).sort({ createdAt: -1 });
    }

    if (!registro) {
      return res.status(200).json({ data: null, message: "No hay archivo cargado aún." });
    }

    const status = effectiveStatus(registro);
    if (status !== "listo") {
      return res.status(200).json({
        data: null,
        status,
        message: status === "procesando" ? "El archivo todavía se está procesando." : effectiveErrorMessage(registro),
      });
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 100;
    const sheetIndex = sheet !== undefined ? parseInt(sheet, 10) : 0;
    const chunked = isChunked(registro);

    const sheetData = registro.sheets[sheetIndex];
    if (!sheetData) return res.status(404).json({ message: "Hoja no encontrada." });

    const yearColIndex = sheetData.headers.findIndex(
      (h) => normalizeHeader(h) === "ano"
    );

    let availableYears = [];
    if (yearColIndex >= 0) {
      if (chunked) {
        availableYears = sheetData.availableYears || [];
      } else {
        const yearSet = new Set();
        sheetData.rows.forEach((row) => {
          const val = (row[yearColIndex] || "").toString().trim();
          if (val) yearSet.add(val);
        });
        availableYears = Array.from(yearSet).sort();
      }
    }

    const yearFilterActive = yearColIndex >= 0 && Boolean(year || yearFrom || yearTo);
    const matchesYear = (row) => {
      const val = (row[yearColIndex] || "").toString().trim();
      if (year) return val === year;
      if (yearFrom && val < yearFrom) return false;
      if (yearTo && val > yearTo) return false;
      return true;
    };
    const searchTerm = (req.query.search || "").toString().trim().toLowerCase();
    const matchesSearch = (row) =>
      !searchTerm || row.some((cell) => (cell || "").toString().toLowerCase().includes(searchTerm));
    const matchesRow = (row) => (!yearFilterActive || matchesYear(row)) && matchesSearch(row);

    const start = (pageNum - 1) * limitNum;
    let totalRows;
    let paginatedRows;
    if (!chunked) {
      const filteredRows = sheetData.rows.filter(matchesRow);
      totalRows = filteredRows.length;
      paginatedRows = filteredRows.slice(start, start + limitNum);
    } else if (!yearFilterActive && !searchTerm) {
      totalRows = sheetRowCount(sheetData);
      paginatedRows = await readRowsRange(registro, sheetIndex, start, limitNum);
    } else {
      // Con filtro por año solo se recorren los bloques que tienen ese año.
      const yearRange = { ...(yearFrom ? { $gte: yearFrom } : {}), ...(yearTo ? { $lte: yearTo } : {}) };
      const chunkFilter = !yearFilterActive ? null : year ? { years: year } : { years: { $elemMatch: yearRange } };
      ({ total: totalRows, rows: paginatedRows } = await scanRows(registro, sheetIndex, chunkFilter, matchesRow, start, limitNum));
    }

    // La cedula (numero de documento) solo debe salir del servidor para el
    // rol Administrador — para cualquier otro rol se quita aqui antes de
    // responder (ocultarla solo en el frontend no alcanza: el JSON seguiria
    // trayendo el dato para quien inspeccione la respuesta de red).
    const isAdmin = await isRequesterAdmin(email);
    const { headers: outputHeaders, rows: outputRows } = isAdmin
      ? { headers: sheetData.headers, rows: paginatedRows }
      : stripDocumentColumn(sheetData.headers, paginatedRows);

    return res.status(200).json({
      _id: registro._id,
      file_name: registro.file_name,
      uploaded_by: registro.uploaded_by,
      drive_file_link: registro.drive_file_link,
      drive_file_download: registro.drive_file_download,
      updatedAt: registro.updatedAt,
      category: registro.category || 'snies',
      sheetsInfo: registro.sheets.map((s, i) => ({
        index: i,
        name: s.name,
        totalRows: sheetRowCount(s),
        headers: isAdmin ? s.headers : stripDocumentColumn(s.headers, []).headers,
      })),
      availableYears,
      currentSheet: {
        index: sheetIndex,
        name: sheetData.name,
        headers: outputHeaders,
        rows: outputRows,
        totalRows,
        page: pageNum,
        totalPages: Math.ceil(totalRows / limitNum),
      },
    });
  } catch (error) {
    console.error("Error al obtener datos:", error);
    return res.status(500).json({ message: "Error al obtener los datos.", error: error.message });
  }
};

// Descarga de un archivo guardado por bloques. El Administrador recibe el
// original desde GridFS; el resto (o si no hay original) recibe un Excel
// reconstruido desde los bloques por streaming, sin las columnas de documento.
const downloadChunkedFile = async (res, registro, isAdmin) => {
  const fileName = registro.file_name || "archivo.xlsx";
  const isCsvOriginal = /\.csv$/i.test(fileName);

  if (isAdmin && registro.file_id) {
    const info = await getGridFSFileInfo(registro.file_id);
    if (info) {
      if (!isCsvOriginal && info.length <= DOWNLOAD_STYLE_MAX_BYTES) {
        let buffer = await readGridFSBuffer(registro.file_id);
        try {
          const workbook = new ExcelJS.Workbook();
          await workbook.xlsx.load(buffer);
          applyHeaderRowStyle(workbook);
          buffer = Buffer.from(await workbook.xlsx.writeBuffer());
        } catch (styleError) {
          console.warn("No se pudo resaltar el encabezado del Excel a descargar:", styleError?.message || styleError);
        }
        setAttachmentHeaders(res, fileName, EXCEL_CONTENT_TYPE);
        return res.send(buffer);
      }
      setAttachmentHeaders(res, fileName, isCsvOriginal ? CSV_CONTENT_TYPE : EXCEL_CONTENT_TYPE);
      res.setHeader("Content-Length", info.length);
      return pipeGridFS(res, registro.file_id);
    }
  }

  // Registros antiguos migrados cuyo original quedó en Drive.
  if (isAdmin && !registro.file_id && registro.drive_file_id) {
    try {
      let buffer = await downloadDriveFileBuffer(registro.drive_file_id);
      try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        applyHeaderRowStyle(workbook);
        buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      } catch (styleError) {
        console.warn("No se pudo resaltar el encabezado del Excel a descargar:", styleError?.message || styleError);
      }
      setAttachmentHeaders(res, fileName, EXCEL_CONTENT_TYPE);
      return res.send(buffer);
    } catch (driveError) {
      console.warn("No se pudo descargar desde Drive, se reconstruye desde los bloques:", driveError?.message || driveError);
    }
  }

  setAttachmentHeaders(res, fileName.replace(/\.(csv|xlsm)$/i, ".xlsx"), EXCEL_CONTENT_TYPE);
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true, useSharedStrings: false });
  const usedNames = new Set();
  const sheets = registro.sheets || [];
  for (let index = 0; index < sheets.length; index++) {
    const headers = sheets[index].headers || [];
    const dropIndexes = isAdmin ? [] : documentColumnIndexes(headers);
    const keep = (values) => (dropIndexes.length ? values.filter((_, i) => !dropIndexes.includes(i)) : values);

    const worksheet = workbook.addWorksheet(sanitizeWorksheetName(sheets[index].name, index, usedNames));
    if (headers.length > 0) {
      const headerRow = worksheet.addRow(keep(headers));
      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: HEADER_FONT_COLOR } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL_COLOR } };
      });
      headerRow.commit();
    }
    await forEachSheetRow(registro, index, (row) => {
      const values = Array.isArray(row) ? row : [];
      worksheet.addRow(keep(headers.length > 0 ? headers.map((_, i) => values[i] ?? "") : values)).commit();
    });
    worksheet.commit();
  }
  await workbook.commit();
};

// GET /historico-docentes/download
controller.downloadFile = async (req, res) => {
  const { email, category = 'snies', id } = req.query;

  if (!email) return res.status(400).json({ message: "El email es requerido." });

  try {
    let registro;
    if (id) {
      registro = await HistoricoDocentes.findById(id);
    } else {
      const query = {
        active: true,
        $or: [
          { category },
          ...(category === 'snies' ? [{ category: { $exists: false } }] : [])
        ]
      };
      registro = await HistoricoDocentes.findOne(query).sort({ createdAt: -1 });
    }

    if (!registro) {
      return res.status(404).json({ message: "No hay archivo disponible para descargar." });
    }

    if (registro.file_type === "pdf") {
      if (registro.file_id) {
        setAttachmentHeaders(res, registro.file_name || "archivo.pdf", PDF_CONTENT_TYPE);
        return await pipeGridFS(res, registro.file_id);
      }
      if (!registro.pdf_data) {
        return res.status(404).json({ message: "No hay PDF disponible para descargar." });
      }
      setAttachmentHeaders(res, registro.file_name || "archivo.pdf", PDF_CONTENT_TYPE);
      return res.send(registro.pdf_data);
    }

    // El Excel original (Drive/excel_data) trae la cédula tal como se subió:
    // solo se entrega al Administrador. Para cualquier otro rol se reconstruye
    // desde "sheets" sin las columnas de documento, igual que en getData.
    const isAdmin = await isRequesterAdmin(email);
    if (isChunked(registro)) return await downloadChunkedFile(res, registro, isAdmin);

    let buffer = null;
    if (isAdmin && registro.drive_file_id) {
      try {
        buffer = await downloadDriveFileBuffer(registro.drive_file_id);
      } catch (driveError) {
        console.warn("No se pudo descargar desde Drive, usando respaldo local:", driveError?.message || driveError);
      }
    }

    if (isAdmin && !buffer && registro.excel_data) {
      buffer = registro.excel_data;
    }

    if (!buffer) {
      const sheetsToExport = isAdmin ? registro.sheets : stripDocumentColumnFromSheets(registro.sheets);
      buffer = await buildWorkbookBufferFromSheets(sheetsToExport);
    }

    if (!buffer) {
      return res.status(404).json({ message: "No hay archivo disponible para descargar." });
    }

    try {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer);
      applyHeaderRowStyle(workbook);
      buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    } catch (styleError) {
      console.warn("No se pudo resaltar el encabezado del Excel a descargar:", styleError?.message || styleError);
    }

    setAttachmentHeaders(res, registro.file_name || "archivo.xlsx", EXCEL_CONTENT_TYPE);
    return res.send(buffer);
  } catch (error) {
    console.error("Error al descargar archivo:", error);
    // Si la descarga por streaming ya había empezado, solo se corta la conexión.
    if (res.headersSent) return res.destroy();
    return res.status(500).json({ message: "Error al descargar el archivo.", error: error.message });
  }
};

// PATCH /historico-docentes/:id/anexos/:anexoId/rename
controller.renameAnexo = async (req, res) => {
  const { id, anexoId } = req.params;
  const { file_name } = req.body;

  if (!file_name?.trim()) return res.status(400).json({ message: "El nombre es requerido." });

  try {
    const registro = await HistoricoDocentes.findById(id);
    if (!registro) return res.status(404).json({ message: "Informe no encontrado." });
    const anexo = registro.anexos.id(anexoId);
    if (!anexo) return res.status(404).json({ message: "Anexo no encontrado." });
    anexo.file_name = file_name.trim();
    await registro.save();
    return res.status(200).json({ message: "Nombre actualizado.", file_name: anexo.file_name });
  } catch (error) {
    return res.status(500).json({ message: "Error al renombrar el anexo.", error: error.message });
  }
};

// PATCH /historico-docentes/:id/rename
controller.renameFile = async (req, res) => {
  const { id } = req.params;
  const { file_name, email } = req.body;

  if (!email) return res.status(400).json({ message: "El email es requerido." });
  if (!file_name?.trim()) return res.status(400).json({ message: "El nombre es requerido." });

  try {
    const registro = await HistoricoDocentes.findById(id).select("uploaded_by category dimension");
    if (!registro) return res.status(404).json({ message: "Archivo no encontrado." });
    if (!(await canManageFile(registro, email))) {
      return res.status(403).json({ message: "No tienes permiso para editar este archivo." });
    }

    await HistoricoDocentes.findByIdAndUpdate(id, { file_name: file_name.trim() });
    return res.status(200).json({ message: "Nombre actualizado.", file_name: file_name.trim() });
  } catch (error) {
    return res.status(500).json({ message: "Error al renombrar.", error: error.message });
  }
};

module.exports = controller;
