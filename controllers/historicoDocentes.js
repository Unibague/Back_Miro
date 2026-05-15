const fs = require("fs");
const ExcelJS = require("exceljs");
const HistoricoDocentes = require("../models/historicoDocentes");
const UserService = require("../services/users");
const {
  uploadFileToGoogleDrive,
  downloadDriveFileBuffer,
} = require("../config/googleDrive");

const controller = {};

const parseSheetsFromBuffer = async (buffer) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const sheets = [];

  workbook.worksheets.forEach((worksheet) => {
    const headers = [];
    const rows = [];

    let headerRowIndex = 1;

    // Buscar la fila con más encabezados en las primeras 10 filas
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

    // Quitar encabezados vacíos al final
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

    sheets.push({
      name: worksheet.name,
      headers,
      rows,
    });
  });

  return sheets;
};

const getCellText = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
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

// POST /historico-docentes/upload
controller.upload = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "El email es requerido." });
  }

  if (!req.file) {
    return res.status(400).json({ message: "El archivo Excel es requerido." });
  }

  let user;
  try {
    user = await UserService.findUserByEmail(email, null);
  } catch (error) {
    return res.status(404).json({ message: "Usuario no encontrado." });
  }

  const fileName = req.file.originalname;
  const ext = fileName.toLowerCase();
  if (!ext.endsWith(".xlsx") && !ext.endsWith(".xlsm")) {
    fs.unlinkSync(req.file.path);
    return res
      .status(400)
      .json({ message: "Solo se aceptan archivos .xlsx o .xlsm." });
  }

  try {
    // Parsear el Excel
    const buffer = fs.readFileSync(req.file.path);
    const sheets = await parseSheetsFromBuffer(buffer);

    if (sheets.length < 1) {
      fs.unlinkSync(req.file.path);
      return res
        .status(400)
        .json({ message: "El archivo no contiene hojas válidas." });
    }

    // Subir a Google Drive
    const uploaded = await uploadFileToGoogleDrive(
      req.file,
      "Formatos/Historico Docentes",
      fileName
    );

    // Eliminar registros anteriores
    await HistoricoDocentes.deleteMany({});

    // Guardar en MongoDB
    const registro = new HistoricoDocentes({
      file_name: fileName,
      uploaded_by: {
        full_name: user.full_name || user.name,
        email: user.email,
      },
      drive_file_id: uploaded.id,
      drive_file_link: uploaded.webViewLink,
      drive_file_download: uploaded.webContentLink,
      sheets,
      active: true,
    });

    await registro.save();

    fs.unlinkSync(req.file.path);

    return res.status(201).json({
      message: "Histórico de docentes cargado correctamente.",
      registro: {
        _id: registro._id,
        file_name: registro.file_name,
        uploaded_by: registro.uploaded_by,
        drive_file_link: registro.drive_file_link,
        sheets: registro.sheets.map((s) => ({ name: s.name, headers: s.headers, totalRows: s.rows.length })),
        createdAt: registro.createdAt,
      },
    });
  } catch (error) {
    console.error("Error al cargar histórico de docentes:", error);
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res
      .status(500)
      .json({ message: "Error al procesar el archivo.", error: error.message });
  }
};

const normalizeHeader = (h) =>
  (h || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

// GET /historico-docentes/data
controller.getData = async (req, res) => {
  const { email, sheet, page = 1, limit = 100, year } = req.query;

  if (!email) {
    return res.status(400).json({ message: "El email es requerido." });
  }

  try {
    const registro = await HistoricoDocentes.findOne({ active: true }).sort({ createdAt: -1 });

    if (!registro) {
      return res.status(200).json({ data: null, message: "No hay histórico cargado aún." });
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 100;
    const sheetIndex = sheet !== undefined ? parseInt(sheet, 10) : 0;

    const sheetData = registro.sheets[sheetIndex];
    if (!sheetData) {
      return res.status(404).json({ message: "Hoja no encontrada." });
    }

    // Detectar columna de año por nombre (ano, año, AÑO, ANO, etc.)
    const yearColIndex = sheetData.headers.findIndex(
      (h) => normalizeHeader(h) === "ano"
    );

    // Años únicos disponibles en esta hoja
    let availableYears = [];
    if (yearColIndex >= 0) {
      const yearSet = new Set();
      sheetData.rows.forEach((row) => {
        const val = (row[yearColIndex] || "").toString().trim();
        if (val) yearSet.add(val);
      });
      availableYears = Array.from(yearSet).sort();
    }

    // Filtrar filas por año y/o búsqueda de texto
    let filteredRows = sheetData.rows;
    if (year && yearColIndex >= 0) {
      filteredRows = filteredRows.filter(
        (row) => (row[yearColIndex] || "").toString().trim() === year
      );
    }
    if (req.query.search) {
      const searchTerm = req.query.search.toString().trim().toLowerCase();
      if (searchTerm) {
        filteredRows = filteredRows.filter((row) =>
          row.some((cell) =>
            (cell || "").toString().toLowerCase().includes(searchTerm)
          )
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
    console.error("Error al obtener histórico de docentes:", error);
    return res.status(500).json({ message: "Error al obtener los datos.", error: error.message });
  }
};

// GET /historico-docentes/download
controller.downloadFile = async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ message: "El email es requerido." });
  }

  try {
    const registro = await HistoricoDocentes.findOne({ active: true }).sort({ createdAt: -1 });

    if (!registro || !registro.drive_file_id) {
      return res.status(404).json({ message: "No hay archivo disponible para descargar." });
    }

    const buffer = await downloadDriveFileBuffer(registro.drive_file_id);

    res.setHeader("Content-Disposition", `attachment; filename="${registro.file_name}"`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return res.send(buffer);
  } catch (error) {
    console.error("Error al descargar histórico de docentes:", error);
    return res.status(500).json({ message: "Error al descargar el archivo.", error: error.message });
  }
};

module.exports = controller;
