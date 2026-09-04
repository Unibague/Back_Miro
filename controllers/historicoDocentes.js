const fs = require("fs");
const axios = require("axios");
const ExcelJS = require("exceljs");
const HistoricoDocentes = require("../models/historicoDocentes");
const User = require("../models/users");
const Student = require("../models/students");
const UserService = require("../services/users");
const {
  downloadDriveFileBuffer,
} = require("../config/googleDrive");

const controller = {};

const VALID_CATEGORIES = ['snies', 'plantillas', 'informes'];
const EXCEL_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_CONTENT_TYPE = "application/pdf";

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

const parseSheetsFromBuffer = async (buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheets = [];

  workbook.worksheets.forEach((worksheet) => {
    const headers = [];
    const rows = [];

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
    headerRow.eachCell({ includeEmpty: true }, (cell, colIndex) => {
      const val = getCellText(cell.value);
      headers[colIndex - 1] = val || `Columna ${colIndex}`;
    });

    while (headers.length > 0 && !headers[headers.length - 1]) {
      headers.pop();
    }

    for (let r = headerRowIndex + 1; r <= worksheet.rowCount; r++) {
      const row = worksheet.getRow(r);
      const rowData = [];
      let hasData = false;

      for (let c = 1; c <= headers.length; c++) {
        const cell = row.getCell(c);
        const val = getCellText(cell.value);
        rowData.push(val);
        if (val) hasData = true;
      }

      if (hasData) {
        rows.push(rowData);
      }
    }

    sheets.push({ name: worksheet.name, headers, rows });
  });

  return sheets;
};

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

// GET /historico-docentes/list?category=&email=&periodId=&dimensionId=
controller.listFiles = async (req, res) => {
  const { category = 'snies', email, periodId, dimensionId } = req.query;

  if (!email) return res.status(400).json({ message: "El email es requerido." });

  try {
    const query = {
      active: true,
      $or: [
        { category },
        ...(category === 'snies' ? [{ category: { $exists: false } }] : [])
      ]
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
      .select('_id file_name uploaded_by updatedAt createdAt category file_type sheets anexos dimension cloned_from')
      .sort({ createdAt: -1 });

    return res.status(200).json({
      files: files.map(f => ({
        _id: f._id,
        file_name: f.file_name,
        uploaded_by: f.uploaded_by,
        updatedAt: f.updatedAt,
        createdAt: f.createdAt,
        category: f.category || 'snies',
        file_type: f.file_type || 'excel',
        dimension: f.dimension || null,
        cloned_from: f.cloned_from || null,
        anexosCount: (f.anexos || []).length,
        anexosNames: (f.anexos || []).map(a => a.file_name),
        sheetsInfo: (f.sheets || []).map((s, i) => ({
          index: i,
          name: s.name,
          totalRows: s.rows.length,
        })),
      }))
    });
  } catch (error) {
    console.error("Error listando archivos:", error);
    return res.status(500).json({ message: "Error al listar los archivos.", error: error.message });
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
          sheets: source.sheets,
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
    const registro = await HistoricoDocentes.findById(id);
    if (!registro) return res.status(404).json({ message: "Archivo no encontrado." });

    await HistoricoDocentes.findByIdAndDelete(id);
    return res.status(200).json({ message: "Archivo eliminado correctamente." });
  } catch (error) {
    console.error("Error eliminando archivo:", error);
    return res.status(500).json({ message: "Error al eliminar el archivo.", error: error.message });
  }
};

// POST /historico-docentes/upload
controller.upload = async (req, res) => {
  const { email, category = 'snies' } = req.body;

  if (!email) return res.status(400).json({ message: "El email es requerido." });
  if (!VALID_CATEGORIES.includes(category)) return res.status(400).json({ message: "Categoría no válida." });
  if (!req.file) return res.status(400).json({ message: "El archivo es requerido." });

  let user;
  try {
    user = await UserService.findUserByEmail(email, null);
  } catch (error) {
    return res.status(404).json({ message: "Usuario no encontrado." });
  }

  const fileName = req.file.originalname;
  const ext = fileName.toLowerCase();
  const isPdf = ext.endsWith(".pdf");
  const isExcel = ext.endsWith(".xlsx") || ext.endsWith(".xlsm");

  // PDF solo permitido en informes
  if (isPdf && category !== 'informes') {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ message: "Los archivos PDF solo se pueden cargar en la categoría Informes." });
  }
  if (!isPdf && !isExcel) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ message: "Solo se aceptan archivos .xlsx, .xlsm o .pdf." });
  }

  try {
    const buffer = fs.readFileSync(req.file.path);

    let sheets = [];
    if (isExcel) {
      sheets = await parseSheetsFromBuffer(buffer);
      if (sheets.length < 1) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ message: "El archivo no contiene hojas válidas." });
      }
    }

    // Solo para SNIES se reemplaza el archivo anterior
    if (category === 'snies') {
      await HistoricoDocentes.deleteMany({ $or: [{ category: 'snies' }, { category: { $exists: false } }] });
    }

    const registro = new HistoricoDocentes({
      file_name: fileName,
      uploaded_by: { full_name: user.full_name || user.name, email: user.email },
      file_type: isPdf ? 'pdf' : 'excel',
      excel_data: isExcel ? buffer : null,
      pdf_data: isPdf ? buffer : null,
      sheets,
      category,
      period: (category !== 'snies' && req.body.periodId) ? req.body.periodId : null,
      dimension: (category !== 'snies' && req.body.dimensionId) ? req.body.dimensionId : null,
      active: true,
    });

    await registro.save();
    fs.unlinkSync(req.file.path);

    return res.status(201).json({
      message: "Archivo cargado correctamente.",
      registro: {
        _id: registro._id,
        file_name: registro.file_name,
        uploaded_by: registro.uploaded_by,
        file_type: registro.file_type,
        category: registro.category,
        sheetsInfo: registro.sheets.map((s) => ({ name: s.name, headers: s.headers, totalRows: s.rows.length })),
        createdAt: registro.createdAt,
      },
    });
  } catch (error) {
    console.error("Error al cargar archivo:", error);
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    return res.status(500).json({ message: "Error al procesar el archivo.", error: error.message });
  }
};

// GET /historico-docentes/:id/pdf  — sirve el PDF principal
controller.viewPdf = async (req, res) => {
  const { id } = req.params;
  try {
    const registro = await HistoricoDocentes.findById(id).select('file_name file_type pdf_data');
    if (!registro || registro.file_type !== 'pdf' || !registro.pdf_data)
      return res.status(404).json({ message: "PDF no encontrado." });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${registro.file_name}"`);
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

const EMAIL_HEADER_NAMES = new Set(["EMAILINSTITUCIONAL", "EMAIL", "CORREO", "CORREOINSTITUCIONAL"]);
// Mismos nombres que HIDDEN_COLUMN_NAMES en el frontend (FileLibraryPanel.tsx):
// si la hoja ya trae una de estas columnas, no se agrega una nueva.
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

const safeGetEndpoint = async (endpoint, timeout = 15000) => {
  if (!endpoint) return [];
  try {
    const response = await axios.get(endpoint, { timeout });
    return Array.isArray(response.data) ? response.data : [];
  } catch (error) {
    console.warn(`[historico-docentes] No fue posible consultar endpoint externo: ${error.message}`);
    return [];
  }
};

// Resuelve la cedula de cada correo consultando primero las bases locales
// (User/Student) y, de respaldo, la API en vivo de SIGA (USERS_ENDPOINT /
// STUDENTS_ENDPOINT) — mismo mecanismo que ya usa el cruce de apoyos
// SIGA/Iceberg (controllers/supportTemplates.js) para resolver personas por
// correo cuando el numero de documento no vino en el archivo.
const resolveIdentificationsByEmail = async (emails) => {
  const normalizedEmails = [...new Set(emails.map((e) => String(e || "").trim().toLowerCase()).filter(Boolean))];
  const byEmail = new Map();
  if (normalizedEmails.length === 0) return byEmail;

  const [usersDb, studentsDb, usersApi, studentsApi] = await Promise.all([
    User.find({ email: { $in: normalizedEmails } }, "email identification").lean(),
    Student.find({ email: { $in: normalizedEmails } }, "email identification").lean(),
    safeGetEndpoint(process.env.USERS_ENDPOINT),
    safeGetEndpoint(process.env.STUDENTS_ENDPOINT),
  ]);

  // Las bases locales tienen prioridad sobre la API externa (se procesan
  // al final, para que sobrescriban con Map.set si hay coincidencia).
  const put = (email, identification) => {
    const key = String(email || "").trim().toLowerCase();
    const id = String(identification || "").trim();
    if (key && id) byEmail.set(key, id);
  };
  usersApi.forEach((u) => put(u.email, u.identification));
  studentsApi.forEach((s) => put(s.email, s.identification));
  usersDb.forEach((u) => put(u.email, u.identification));
  studentsDb.forEach((s) => put(s.email, s.identification));

  return byEmail;
};

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

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 100;
    const sheetIndex = sheet !== undefined ? parseInt(sheet, 10) : 0;

    const sheetData = registro.sheets[sheetIndex];
    if (!sheetData) return res.status(404).json({ message: "Hoja no encontrada." });

    const yearColIndex = sheetData.headers.findIndex(
      (h) => normalizeHeader(h) === "ano"
    );

    let availableYears = [];
    if (yearColIndex >= 0) {
      const yearSet = new Set();
      sheetData.rows.forEach((row) => {
        const val = (row[yearColIndex] || "").toString().trim();
        if (val) yearSet.add(val);
      });
      availableYears = Array.from(yearSet).sort();
    }

    let filteredRows = sheetData.rows;
    if (year && yearColIndex >= 0) {
      filteredRows = filteredRows.filter(
        (row) => (row[yearColIndex] || "").toString().trim() === year
      );
    } else if ((yearFrom || yearTo) && yearColIndex >= 0) {
      filteredRows = filteredRows.filter((row) => {
        const val = (row[yearColIndex] || "").toString().trim();
        if (yearFrom && val < yearFrom) return false;
        if (yearTo && val > yearTo) return false;
        return true;
      });
    }
    if (req.query.search) {
      const searchTerm = req.query.search.toString().trim().toLowerCase();
      if (searchTerm) {
        filteredRows = filteredRows.filter((row) =>
          row.some((cell) => (cell || "").toString().toLowerCase().includes(searchTerm))
        );
      }
    }

    const totalRows = filteredRows.length;
    const start = (pageNum - 1) * limitNum;
    const paginatedRows = filteredRows.slice(start, start + limitNum);

    // La cedula (numero de documento) esta oculta para todos los roles en
    // Consulta de Informacion, salvo Administrador. Algunas plantillas (ej.
    // Docentes_IES) no traen esa columna en el Excel original, solo el
    // correo institucional — para el Administrador se resuelve la cedula a
    // partir del correo (bases locales + API en vivo de SIGA) y se agrega
    // como columna extra, igual que si hubiera venido en el archivo.
    let outputHeaders = sheetData.headers;
    let outputRows = paginatedRows;

    const collapsedHeaders = sheetData.headers.map(collapseHeader);
    const emailColIndex = collapsedHeaders.findIndex((h) => EMAIL_HEADER_NAMES.has(h));
    const hasDocumentColumn = collapsedHeaders.some((h) => DOCUMENT_HEADER_NAMES.has(h));

    if (emailColIndex >= 0 && !hasDocumentColumn) {
      let isAdmin = false;
      try {
        await UserService.findUserByEmailAndRoles(email, ["Administrador"]);
        isAdmin = true;
      } catch {
        isAdmin = false;
      }

      if (isAdmin) {
        const idByEmail = await resolveIdentificationsByEmail(
          paginatedRows.map((row) => row[emailColIndex])
        );
        const tipoDocIndex = collapsedHeaders.findIndex((h) => h.includes("TIPODOCUMENTO"));
        const insertAt = tipoDocIndex >= 0 ? tipoDocIndex + 1 : sheetData.headers.length;

        outputHeaders = [...sheetData.headers];
        outputHeaders.splice(insertAt, 0, "DOCUMENTO");

        outputRows = paginatedRows.map((row) => {
          const rowEmail = String(row[emailColIndex] || "").trim().toLowerCase();
          const newRow = [...row];
          newRow.splice(insertAt, 0, idByEmail.get(rowEmail) || "");
          return newRow;
        });
      }
    }

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
        totalRows: s.rows.length,
        headers: s.headers,
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
      if (!registro.pdf_data) {
        return res.status(404).json({ message: "No hay PDF disponible para descargar." });
      }
      setAttachmentHeaders(res, registro.file_name || "archivo.pdf", PDF_CONTENT_TYPE);
      return res.send(registro.pdf_data);
    }

    let buffer = null;
    if (registro.drive_file_id) {
      try {
        buffer = await downloadDriveFileBuffer(registro.drive_file_id);
      } catch (driveError) {
        console.warn("No se pudo descargar desde Drive, usando respaldo local:", driveError?.message || driveError);
      }
    }

    if (!buffer && registro.excel_data) {
      buffer = registro.excel_data;
    }

    if (!buffer) {
      buffer = await buildWorkbookBufferFromSheets(registro.sheets);
    }

    if (!buffer) {
      return res.status(404).json({ message: "No hay archivo disponible para descargar." });
    }

    setAttachmentHeaders(res, registro.file_name || "archivo.xlsx", EXCEL_CONTENT_TYPE);
    return res.send(buffer);
  } catch (error) {
    console.error("Error al descargar archivo:", error);
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
  const { file_name } = req.body;

  if (!file_name?.trim()) return res.status(400).json({ message: "El nombre es requerido." });

  try {
    const registro = await HistoricoDocentes.findByIdAndUpdate(
      id,
      { file_name: file_name.trim() },
      { new: true }
    );
    if (!registro) return res.status(404).json({ message: "Archivo no encontrado." });
    return res.status(200).json({ message: "Nombre actualizado.", file_name: registro.file_name });
  } catch (error) {
    return res.status(500).json({ message: "Error al renombrar.", error: error.message });
  }
};

module.exports = controller;
