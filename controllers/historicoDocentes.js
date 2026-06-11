const fs = require("fs");
const ExcelJS = require("exceljs");
const HistoricoDocentes = require("../models/historicoDocentes");
const UserService = require("../services/users");
const {
  downloadDriveFileBuffer,
} = require("../config/googleDrive");

const controller = {};

const VALID_CATEGORIES = ['snies', 'plantillas', 'informes'];

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
  if (value instanceof Date) return value.toLocaleDateString("es-CO");
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

// GET /historico-docentes/list?category=&email=&periodId=
controller.listFiles = async (req, res) => {
  const { category = 'snies', email, periodId } = req.query;

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

    const files = await HistoricoDocentes.find(query)
      .select('_id file_name uploaded_by updatedAt createdAt category file_type sheets anexos')
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
      pdf_data: isPdf ? buffer : null,
      sheets,
      category,
      period: (category !== 'snies' && req.body.periodId) ? req.body.periodId : null,
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
        headers: sheetData.headers,
        rows: paginatedRows,
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

    if (!registro || !registro.drive_file_id) {
      return res.status(404).json({ message: "No hay archivo disponible para descargar." });
    }

    const buffer = await downloadDriveFileBuffer(registro.drive_file_id);
    res.setHeader("Content-Disposition", `attachment; filename="${registro.file_name}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
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
