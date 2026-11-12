const path = require("path");
const PizZip = require("pizzip");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");

// Llena un Excel KPI editando directamente el XML de las hojas de datos.
// No se usa ExcelJS para escribir porque al reescribir el archivo pierde
// gráficos, tablas dinámicas y segmentaciones; aquí solo se tocan los valores
// de las celdas de datos y todo lo demás del archivo queda intacto.

const HEADER_SCAN_ROWS = 30;
const SHEET_REL_TYPE = "/worksheet";
const TABLE_REL_TYPE = "/table";
const SHARED_STRINGS_REL_TYPE = "/sharedStrings";
const STYLES_REL_TYPE = "/styles";

const compact = (value = "") =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const colToNumber = (letters) =>
  letters.split("").reduce((acc, ch) => acc * 26 + ch.charCodeAt(0) - 64, 0);

const numberToCol = (number) => {
  let letters = "";
  let n = number;
  while (n > 0) {
    const mod = (n - 1) % 26;
    letters = String.fromCharCode(65 + mod) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
};

const parseRef = (ref) => {
  const match = /^\$?([A-Z]+)\$?(\d+)$/.exec(String(ref || "").trim());
  return match ? { col: colToNumber(match[1]), row: Number(match[2]) } : null;
};

const parseRange = (range) => {
  const [start, end] = String(range || "").split(":");
  const from = parseRef(start);
  const to = parseRef(end || start);
  return from && to ? { from, to } : null;
};

const formatRange = ({ from, to }) =>
  `${numberToCol(from.col)}${from.row}:${numberToCol(to.col)}${to.row}`;

// ── Utilidades DOM ──────────────────────────────────────────────────────────

const nodeName = (node) => node.localName || node.nodeName;

const childElements = (node, name) => {
  const result = [];
  const nodes = node?.childNodes;
  if (!nodes) return result;
  for (let i = 0; i < nodes.length; i += 1) {
    const item = nodes.item(i);
    if (item.nodeType === 1 && (!name || nodeName(item) === name)) result.push(item);
  }
  return result;
};

const firstChild = (node, name) => childElements(node, name)[0] || null;

const descendants = (node, name) => {
  const result = [];
  const walk = (current) => {
    childElements(current).forEach((item) => {
      if (nodeName(item) === name) result.push(item);
      walk(item);
    });
  };
  walk(node);
  return result;
};

const textOf = (node) => (node ? node.textContent || "" : "");

const createElement = (doc, name) =>
  doc.createElementNS(doc.documentElement.namespaceURI, name);

const removeChildren = (node, names) => {
  childElements(node)
    .filter((item) => names.includes(nodeName(item)))
    .forEach((item) => node.removeChild(item));
};

// ── Valores ─────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const PLAIN_NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;

// Convierte lo guardado en Miró al tipo de celda que espera Excel, para que
// las fórmulas del archivo KPI (SUMA, CONTAR.SI, fechas…) funcionen.
const toCellValue = (raw) => {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "boolean") return raw;
  const text = String(raw).trim();
  if (!text || text === "[object Object]") return null;
  if (ISO_DATE.test(text)) {
    const date = new Date(text.length === 10 ? `${text}T00:00:00Z` : text);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (PLAIN_NUMBER.test(text)) return Number(text);
  return text;
};

// Las fechas a medianoche UTC se toman tal cual; las demás se pasan a la hora
// de Colombia (UTC-5, sin horario de verano), que es como se guardan en Miró.
const BOGOTA_OFFSET_MS = 5 * 3600000;
const dateToSerial = (date) => {
  const midnightUtc = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0;
  const local = new Date(midnightUtc ? date.getTime() : date.getTime() - BOGOTA_OFFSET_MS);
  return (Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(),
    local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds()) -
    Date.UTC(1899, 11, 30)) / 86400000;
};

// Desplaza las referencias relativas de una fórmula (A2 → A5) sin tocar
// textos entre comillas ni nombres de hoja.
const shiftFormula = (formula, rowOffset) => {
  if (!rowOffset) return formula;
  return String(formula)
    .split(/("(?:[^"]|"")*"|'(?:[^']|'')*')/)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part.replace(
        /(?<![A-Za-z0-9_.$])(\$?)([A-Z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(![])/g,
        (match, colAbs, col, rowAbs, row) =>
          rowAbs ? match : `${colAbs}${col}${rowAbs}${Number(row) + rowOffset}`
      );
    })
    .join("");
};

// ── Libro ───────────────────────────────────────────────────────────────────

const resolveTarget = (basePath, target) => {
  const clean = String(target || "").replace(/\\/g, "/");
  if (clean.startsWith("/")) return clean.replace(/^\/+/, "");
  return path.posix.normalize(path.posix.join(path.posix.dirname(basePath), clean));
};

const relsPathOf = (filePath) =>
  `${path.posix.dirname(filePath)}/_rels/${path.posix.basename(filePath)}.rels`;

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

class KpiWorkbook {
  constructor(buffer) {
    this.zip = new PizZip(buffer);
    this.parser = new DOMParser();
    this.dirty = new Map(); // ruta → documento modificado

    this.workbookPath = "xl/workbook.xml";
    this.workbookDoc = this.parse(this.workbookPath);
    if (!this.workbookDoc) throw new Error("El archivo no es un Excel .xlsx válido.");

    const rels = this.readRels(this.workbookPath);
    this.sheets = descendants(this.workbookDoc.documentElement, "sheet")
      .map((sheetNode) => {
        const relId = sheetNode.getAttributeNS(
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"
        ) || sheetNode.getAttribute("r:id");
        const rel = rels.find((item) => item.id === relId && item.type.endsWith(SHEET_REL_TYPE));
        return rel ? { name: sheetNode.getAttribute("name"), path: rel.path } : null;
      })
      .filter((sheet) => sheet && this.zip.file(sheet.path));

    const sharedRel = rels.find((item) => item.type.endsWith(SHARED_STRINGS_REL_TYPE));
    this.sharedStrings = this.readSharedStrings(sharedRel?.path);
    this.stylesPath = rels.find((item) => item.type.endsWith(STYLES_REL_TYPE))?.path || null;
    this.dateStyleCache = new Map();
  }

  parse(filePath) {
    const file = this.zip.file(filePath);
    return file ? this.parser.parseFromString(file.asText(), "application/xml") : null;
  }

  readRels(filePath) {
    const doc = this.parse(relsPathOf(filePath));
    if (!doc) return [];
    return descendants(doc.documentElement, "Relationship").map((rel) => ({
      id: rel.getAttribute("Id"),
      type: rel.getAttribute("Type") || "",
      path: rel.getAttribute("TargetMode") === "External"
        ? null
        : resolveTarget(filePath, rel.getAttribute("Target")),
    }));
  }

  readSharedStrings(filePath) {
    const doc = filePath ? this.parse(filePath) : null;
    if (!doc) return [];
    return childElements(doc.documentElement, "si").map((si) => {
      const direct = firstChild(si, "t");
      if (direct) return textOf(direct);
      return childElements(si, "r").map((run) => textOf(firstChild(run, "t"))).join("");
    });
  }

  // Carga una hoja y arma los índices fila → celdas
  loadSheet(sheet) {
    if (sheet.doc) return sheet;
    sheet.doc = this.parse(sheet.path);
    sheet.sheetData = descendants(sheet.doc.documentElement, "sheetData")[0];
    sheet.rows = new Map();

    let lastRow = 0;
    childElements(sheet.sheetData, "row").forEach((rowNode) => {
      const rowNumber = Number(rowNode.getAttribute("r")) || lastRow + 1;
      rowNode.setAttribute("r", String(rowNumber));
      lastRow = rowNumber;
      const cells = new Map();
      let lastCol = 0;
      childElements(rowNode, "c").forEach((cellNode) => {
        const col = parseRef(cellNode.getAttribute("r"))?.col || lastCol + 1;
        cellNode.setAttribute("r", `${numberToCol(col)}${rowNumber}`);
        lastCol = col;
        cells.set(col, cellNode);
      });
      sheet.rows.set(rowNumber, { node: rowNode, cells });
    });
    sheet.rowNumbers = [...sheet.rows.keys()].sort((a, b) => a - b);
    return sheet;
  }

  cell(sheet, row, col) {
    return sheet.rows.get(row)?.cells.get(col) || null;
  }

  cellText(cellNode) {
    if (!cellNode) return "";
    const type = cellNode.getAttribute("t");
    if (type === "inlineStr") {
      return descendants(firstChild(cellNode, "is"), "t").map(textOf).join("");
    }
    const value = textOf(firstChild(cellNode, "v"));
    if (type === "s") return this.sharedStrings[Number(value)] ?? "";
    return value;
  }

  hasValue(cellNode) {
    return Boolean(cellNode && (firstChild(cellNode, "v") || firstChild(cellNode, "is")));
  }

  hasFormula(cellNode) {
    return Boolean(cellNode && firstChild(cellNode, "f"));
  }

  rowTexts(sheet, row) {
    const texts = new Map();
    sheet.rows.get(row)?.cells.forEach((cellNode, col) => {
      const text = this.cellText(cellNode).trim();
      if (text) texts.set(col, text);
    });
    return texts;
  }

  ensureRow(sheet, rowNumber) {
    const existing = sheet.rows.get(rowNumber);
    if (existing) return existing;

    const rowNode = createElement(sheet.doc, "row");
    rowNode.setAttribute("r", String(rowNumber));
    const next = sheet.rowNumbers.find((number) => number > rowNumber);
    if (next) {
      sheet.sheetData.insertBefore(rowNode, sheet.rows.get(next).node);
      sheet.rowNumbers.splice(sheet.rowNumbers.indexOf(next), 0, rowNumber);
    } else {
      sheet.sheetData.appendChild(rowNode);
      sheet.rowNumbers.push(rowNumber);
    }
    const entry = { node: rowNode, cells: new Map() };
    sheet.rows.set(rowNumber, entry);
    return entry;
  }

  ensureCell(sheet, rowNumber, col, styleId) {
    const row = this.ensureRow(sheet, rowNumber);
    const existing = row.cells.get(col);
    if (existing) return existing;

    const cellNode = createElement(sheet.doc, "c");
    cellNode.setAttribute("r", `${numberToCol(col)}${rowNumber}`);
    if (styleId) cellNode.setAttribute("s", styleId);

    const nextCol = [...row.cells.keys()].filter((c) => c > col).sort((a, b) => a - b)[0];
    if (nextCol) row.node.insertBefore(cellNode, row.cells.get(nextCol));
    else row.node.appendChild(cellNode);
    // El atributo "spans" es solo una pista de rendimiento y puede quedar desfasado
    row.node.removeAttribute("spans");
    row.cells.set(col, cellNode);
    return cellNode;
  }

  clearValue(cellNode) {
    removeChildren(cellNode, ["v", "is"]);
    cellNode.removeAttribute("t");
  }

  writeValue(sheet, cellNode, value) {
    this.clearValue(cellNode);
    if (value === null || value === undefined || value === "") return;
    const doc = sheet.doc;

    if (value instanceof Date) {
      cellNode.setAttribute("s", this.dateStyleFor(cellNode.getAttribute("s")));
      value = dateToSerial(value);
    }
    if (typeof value === "number") {
      const v = createElement(doc, "v");
      v.appendChild(doc.createTextNode(String(value)));
      cellNode.appendChild(v);
      return;
    }
    if (typeof value === "boolean") {
      cellNode.setAttribute("t", "b");
      const v = createElement(doc, "v");
      v.appendChild(doc.createTextNode(value ? "1" : "0"));
      cellNode.appendChild(v);
      return;
    }
    cellNode.setAttribute("t", "inlineStr");
    const is = createElement(doc, "is");
    const t = createElement(doc, "t");
    t.setAttribute("xml:space", "preserve");
    t.appendChild(doc.createTextNode(String(value)));
    is.appendChild(t);
    cellNode.appendChild(is);
  }

  writeFormula(sheet, cellNode, formula) {
    this.clearValue(cellNode);
    removeChildren(cellNode, ["f"]);
    const f = createElement(sheet.doc, "f");
    f.appendChild(sheet.doc.createTextNode(formula));
    cellNode.insertBefore(f, cellNode.firstChild);
  }

  // Fórmula efectiva de una celda (resuelve las fórmulas compartidas)
  formulaOf(sheet, cellNode, row) {
    const f = firstChild(cellNode, "f");
    if (!f) return null;
    const type = f.getAttribute("t");
    if (type && type !== "shared") return null; // matriciales / tablas de datos
    const text = textOf(f);
    if (text) return { text, row };
    if (type !== "shared") return null;

    if (!sheet.sharedFormulas) {
      sheet.sharedFormulas = new Map();
      sheet.rows.forEach(({ cells }, rowNumber) => {
        cells.forEach((node) => {
          const master = firstChild(node, "f");
          if (master?.getAttribute("t") === "shared" && textOf(master)) {
            sheet.sharedFormulas.set(master.getAttribute("si"), { text: textOf(master), row: rowNumber });
          }
        });
      });
    }
    return sheet.sharedFormulas.get(f.getAttribute("si")) || null;
  }

  // Estilo de fecha que conserva bordes/fuente del estilo original de la celda
  dateStyleFor(styleId) {
    const key = styleId || "0";
    if (this.dateStyleCache.has(key)) return this.dateStyleCache.get(key);
    const doc = this.stylesPath ? this.dirty.get(this.stylesPath) || this.parse(this.stylesPath) : null;
    const cellXfs = doc ? descendants(doc.documentElement, "cellXfs")[0] : null;
    if (!cellXfs) {
      this.dateStyleCache.set(key, key);
      return key;
    }

    const xfs = childElements(cellXfs, "xf");
    const base = xfs[Number(key)] || xfs[0];
    const numFmtId = Number(base?.getAttribute("numFmtId") || 0);
    const customFormats = new Map(
      descendants(doc.documentElement, "numFmt").map((fmt) => [Number(fmt.getAttribute("numFmtId")), fmt.getAttribute("formatCode") || ""])
    );
    const isDate = BUILTIN_DATE_FORMATS.has(numFmtId) ||
      (customFormats.has(numFmtId) && /[dmy]/i.test(customFormats.get(numFmtId).replace(/"[^"]*"|\[[^\]]*\]/g, "")));
    if (isDate) {
      this.dateStyleCache.set(key, key);
      return key;
    }

    const xf = base ? base.cloneNode(true) : createElement(doc, "xf");
    xf.setAttribute("numFmtId", "14");
    xf.setAttribute("applyNumberFormat", "1");
    cellXfs.appendChild(xf);
    const index = String(childElements(cellXfs, "xf").length - 1);
    cellXfs.setAttribute("count", String(Number(index) + 1));
    this.dirty.set(this.stylesPath, doc);
    this.dateStyleCache.set(key, index);
    return index;
  }

  tablesOf(sheet) {
    return this.readRels(sheet.path)
      .filter((rel) => rel.path && rel.type.endsWith(TABLE_REL_TYPE) && this.zip.file(rel.path))
      .map((rel) => ({ path: rel.path, doc: this.dirty.get(rel.path) || this.parse(rel.path) }));
  }

  markDirty(sheet) {
    this.dirty.set(sheet.path, sheet.doc);
  }

  // Después de llenar: tablas dinámicas se actualizan y fórmulas se recalculan al abrir
  finalize(filledSheets) {
    const filledNames = new Set(filledSheets.map((sheet) => sheet.name));
    const headerRows = new Map(filledSheets.map((sheet) => [sheet.name, sheet]));

    this.zip.file(/^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/).forEach((file) => {
      const doc = this.parse(file.name);
      const source = descendants(doc.documentElement, "worksheetSource")[0];
      const sheetName = source?.getAttribute("sheet");
      if (!sheetName || !filledNames.has(sheetName)) return;

      doc.documentElement.setAttribute("refreshOnLoad", "1");
      const range = parseRange(source.getAttribute("ref"));
      const filled = headerRows.get(sheetName);
      if (range && filled && range.from.row === filled.headerRow && filled.lastRow > range.to.row) {
        range.to.row = filled.lastRow;
        source.setAttribute("ref", formatRange(range));
      }
      this.dirty.set(file.name, doc);
    });

    const workbook = this.workbookDoc.documentElement;
    let calcPr = descendants(workbook, "calcPr")[0];
    if (!calcPr) {
      calcPr = createElement(this.workbookDoc, "calcPr");
      const after = ["oleSize", "customWorkbookViews", "pivotCaches", "smartTagPr", "smartTagTypes",
        "webPublishing", "fileRecoveryPr", "webPublishObjects", "extLst"];
      const next = childElements(workbook).find((node) => after.includes(nodeName(node)));
      if (next) workbook.insertBefore(calcPr, next);
      else workbook.appendChild(calcPr);
    }
    calcPr.setAttribute("fullCalcOnLoad", "1");
    this.dirty.set(this.workbookPath, this.workbookDoc);
  }

  toBuffer() {
    const serializer = new XMLSerializer();
    this.dirty.forEach((doc, filePath) => {
      this.zip.file(filePath, serializer.serializeToString(doc));
    });
    return this.zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
  }
}

// ── Emparejar hojas del KPI con plantillas del sistema ──────────────────────

// Busca en las primeras filas de la hoja el encabezado que mejor coincide con
// los campos de alguna plantilla. Devuelve null si ninguna coincide.
const matchSheet = (book, sheet, candidates) => {
  book.loadSheet(sheet);
  const sheetKey = compact(sheet.name);
  let best = null;

  for (let row = 1; row <= HEADER_SCAN_ROWS; row += 1) {
    const texts = book.rowTexts(sheet, row);
    if (texts.size === 0) continue;

    candidates.forEach((candidate) => {
      let score = 0;
      texts.forEach((text) => {
        if (candidate.fieldKeys.has(compact(text))) score += 1;
      });
      if (score === 0) return;

      const nameMatch = candidate.nameKeys.some((key) =>
        key === sheetKey || (sheetKey.length >= 10 && key.startsWith(sheetKey))
      );
      const ratio = score / candidate.fieldKeys.size;
      const valid = score >= Math.min(2, candidate.fieldKeys.size) && (ratio >= 0.5 || (nameMatch && score >= 1));
      if (!valid) return;

      const rank = (nameMatch ? 1000 : 0) + score + ratio;
      if (!best || rank > best.rank) best = { candidate, headerRow: row, headers: texts, rank };
    });
  }
  return best;
};

// Escribe las filas en la hoja bajo el encabezado. Solo toca las columnas cuyo
// encabezado coincide con un campo; las celdas con fórmula nunca se sobrescriben.
const fillSheet = (book, sheet, match, rows, extraColumns = {}) => {
  const { headerRow, headers } = match;
  const dataStart = headerRow + 1;
  const advertencias = [];

  const mapped = [];
  const sinCoincidencia = [];
  headers.forEach((text, col) => {
    const key = compact(text);
    if (match.candidate.fieldKeys.has(key) || extraColumns[key]) mapped.push({ col, key, text });
    else sinCoincidencia.push({ col, text });
  });
  const mappedCols = mapped.map((item) => item.col);

  // Datos anteriores en la hoja: bloque continuo bajo el encabezado
  let oldLast = headerRow;
  for (let row = dataStart; sheet.rows.has(row); row += 1) {
    const filled = mappedCols.some((col) => book.hasValue(book.cell(sheet, row, col)));
    if (!filled) break;
    oldLast = row;
  }
  const newLast = headerRow + rows.length;

  // Contenido que estaba debajo de los datos y que las filas nuevas alcanzan
  for (let row = oldLast + 1; row <= newLast; row += 1) {
    const occupied = mappedCols.some((col) => {
      const cellNode = book.cell(sheet, row, col);
      return book.hasValue(cellNode) || book.hasFormula(cellNode);
    });
    if (occupied) {
      advertencias.push(`Hoja "${sheet.name}": había contenido en la fila ${row}, debajo de los datos anteriores; revisa que no se haya mezclado con la información nueva.`);
      break;
    }
  }

  // Estilo de referencia de cada columna: primera fila de datos
  const styleOf = (col) => book.cell(sheet, dataStart, col)?.getAttribute("s") || null;

  rows.forEach((record, index) => {
    const rowNumber = dataStart + index;
    mapped.forEach(({ col, key }) => {
      const existing = book.cell(sheet, rowNumber, col);
      if (book.hasFormula(existing)) return;
      const value = toCellValue(extraColumns[key] ? extraColumns[key](record) : record.get(key));
      if (value === null && !existing) return;
      const cellNode = existing || book.ensureCell(sheet, rowNumber, col, styleOf(col));
      book.writeValue(sheet, cellNode, value);
    });
  });

  // Limpia lo que sobra de la información anterior
  for (let row = newLast + 1; row <= oldLast; row += 1) {
    mappedCols.forEach((col) => {
      const cellNode = book.cell(sheet, row, col);
      if (cellNode && !book.hasFormula(cellNode)) book.clearValue(cellNode);
    });
  }

  // Columnas calculadas del KPI: se extiende la fórmula a las filas nuevas
  const formulasExtendidas = [];
  sinCoincidencia.forEach(({ col, text }) => {
    const first = book.cell(sheet, dataStart, col);
    const formula = first ? book.formulaOf(sheet, first, dataStart) : null;
    if (!formula) return;
    let extendida = false;
    for (let row = dataStart + 1; row <= newLast; row += 1) {
      const cellNode = book.cell(sheet, row, col);
      if (book.hasFormula(cellNode) || book.hasValue(cellNode)) continue;
      const target = cellNode || book.ensureCell(sheet, row, col, first.getAttribute("s"));
      book.writeFormula(sheet, target, shiftFormula(formula.text, row - formula.row));
      extendida = true;
    }
    if (extendida) formulasExtendidas.push(text);
  });

  const lastRow = Math.max(newLast, dataStart);

  // Tablas de Excel y autofiltro que arrancan en el encabezado crecen con los datos
  book.tablesOf(sheet).forEach((table) => {
    const root = table.doc.documentElement;
    const range = parseRange(root.getAttribute("ref"));
    if (!range || range.from.row !== headerRow || lastRow <= range.to.row) return;
    if (Number(root.getAttribute("totalsRowCount") || 0) > 0) {
      advertencias.push(`Hoja "${sheet.name}": la tabla "${root.getAttribute("displayName")}" tiene fila de totales y no se amplió; amplíala en Excel para incluir todas las filas.`);
      return;
    }
    range.to.row = lastRow;
    root.setAttribute("ref", formatRange(range));
    const autoFilter = firstChild(root, "autoFilter");
    if (autoFilter) autoFilter.setAttribute("ref", formatRange(range));
    book.dirty.set(table.path, table.doc);
  });

  const sheetRoot = sheet.doc.documentElement;
  const sheetFilter = firstChild(sheetRoot, "autoFilter");
  const filterRange = parseRange(sheetFilter?.getAttribute("ref"));
  if (filterRange && filterRange.from.row === headerRow && lastRow > filterRange.to.row) {
    filterRange.to.row = lastRow;
    sheetFilter.setAttribute("ref", formatRange(filterRange));
  }

  const dimension = firstChild(sheetRoot, "dimension");
  const dimRange = parseRange(dimension?.getAttribute("ref"));
  if (dimRange) {
    const maxCol = Math.max(dimRange.to.col, ...mappedCols);
    if (lastRow > dimRange.to.row || maxCol > dimRange.to.col) {
      dimRange.to.row = Math.max(dimRange.to.row, lastRow);
      dimRange.to.col = maxCol;
      dimension.setAttribute("ref", formatRange(dimRange));
    }
  }

  book.markDirty(sheet);
  return {
    headerRow,
    lastRow,
    columnas: mapped.map((item) => item.text),
    sinCoincidencia: sinCoincidencia
      .filter(({ col }) => !book.hasFormula(book.cell(sheet, dataStart, col)))
      .map((item) => item.text),
    formulasExtendidas,
    advertencias,
  };
};

module.exports = {
  KpiWorkbook,
  compact,
  matchSheet,
  fillSheet,
  shiftFormula,
  toCellValue,
};
