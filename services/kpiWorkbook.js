const path = require("path");
const { Readable } = require("stream");
const PizZip = require("pizzip");
const archiver = require("archiver");
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

const createElement = (doc, name) =>
  doc.createElementNS(doc.documentElement.namespaceURI, name);

// ── Valores ─────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const PLAIN_NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;
const COMMA_DECIMAL = /^-?(0|[1-9]\d{0,14}),\d+$/;
const PERCENT = /^(-?(?:0|[1-9]\d{0,14})(?:[.,]\d+)?)\s*%$/;

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
  // CSV en español: coma decimal y porcentajes escritos como texto
  if (COMMA_DECIMAL.test(text)) return Number(text.replace(",", "."));
  const percent = PERCENT.exec(text);
  if (percent) return Number(percent[1].replace(",", ".")) / 100;
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

// ── Texto XML ───────────────────────────────────────────────────────────────

// Las hojas se manejan como texto y no como DOM: una hoja de datos con
// fórmulas preparadas para decenas de miles de filas pesa más de 100 MB de XML
// y como árbol DOM ocupa varios GB. Solo se reconstruyen las filas que cambian.

const XML_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
const unescapeXml = (text = "") =>
  text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (match, entity) => {
    if (entity[0] !== "#") return XML_ENTITIES[entity.toLowerCase()] ?? match;
    const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
// eslint-disable-next-line no-control-regex
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const escapeXml = (text = "") =>
  String(text)
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const attrOf = (attrs, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
const withoutAttr = (attrs, name) => attrs.replace(new RegExp(`\\s*\\b${name}="[^"]*"`), "");
const withAttr = (attrs, name, value) =>
  attrOf(attrs, name) === undefined
    ? `${attrs} ${name}="${value}"`
    : attrs.replace(new RegExp(`\\b${name}="[^"]*"`), `${name}="${value}"`);

const ROW_RE = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const FORMULA_RE = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/;
const HAS_VALUE_RE = /<v>[^<]+<\/v>|<is>/;
const HAS_FORMULA_RE = /<f[\s>/]/;

const sheetDataBounds = (xml) => {
  const open = /<sheetData\b[^>]*?(\/>|>)/.exec(xml);
  if (!open) return null;
  const bodyStart = open.index + open[0].length;
  if (open[1] === "/>") return { headEnd: open.index, bodyStart, bodyEnd: bodyStart, tailStart: bodyStart };
  const bodyEnd = xml.indexOf("</sheetData>", bodyStart);
  return { headEnd: open.index, bodyStart, bodyEnd, tailStart: bodyEnd + "</sheetData>".length };
};

class KpiWorkbook {
  constructor(buffer) {
    this.zip = new PizZip(buffer);
    this.parser = new DOMParser();
    this.dirty = new Map(); // ruta → documento DOM modificado (archivos pequeños)
    this.dirtySheets = new Set(); // hojas modificadas (texto)
    this.streamedSheets = new Map(); // ruta → función que genera la hoja por partes

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

  // Textos de las cadenas compartidas (sin las guías fonéticas <rPh>)
  readSharedStrings(filePath) {
    const file = filePath ? this.zip.file(filePath) : null;
    if (!file) return [];
    const strings = [];
    for (const match of file.asText().matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
      const inner = (match[1] || "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
      let text = "";
      for (const t of inner.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) text += t[1] || "";
      strings.push(unescapeXml(text));
    }
    return strings;
  }

  // Textos de las primeras filas, para buscar el encabezado sin cargar toda la hoja
  headTexts(sheet, maxRow) {
    if (sheet.headTexts) return sheet.headTexts;
    const texts = new Map();
    const cellsByRow = new Map();
    const xml = this.zip.file(sheet.path).asText();
    const bounds = sheetDataBounds(xml);
    // Última fila que declara la hoja (hasta dónde vienen preparadas sus fórmulas)
    const dimension = parseRange(attrOf(/<dimension\b([^>]*?)\/>/.exec(xml)?.[1] || "", "ref"));
    sheet.lastDeclaredRow = dimension?.to.row || 0;
    if (bounds) {
      const re = new RegExp(ROW_RE.source, "g");
      re.lastIndex = bounds.bodyStart;
      let lastRow = 0;
      let match;
      while ((match = re.exec(xml)) && match.index < bounds.bodyEnd) {
        const rowNumber = Number(attrOf(match[1], "r")) || lastRow + 1;
        lastRow = rowNumber;
        if (rowNumber > maxRow) break;
        const cells = this.parseCells(match[2] || "", rowNumber);
        cellsByRow.set(rowNumber, cells);
        texts.set(rowNumber, this.textsOfCells(cells));
      }
    }
    sheet.headTexts = texts;
    sheet.headCells = cellsByRow;
    return texts;
  }

  // Valor de una celda con su tipo (número, texto, booleano, error o null)
  cellValue(cell) {
    if (!cell) return null;
    const type = attrOf(cell.attrs, "t");
    if (type === "s" || type === "inlineStr" || type === "str") return this.cellText(cell);
    const raw = /<v>([\s\S]*?)<\/v>/.exec(cell.inner)?.[1];
    if (raw === undefined || raw === "") return null;
    if (type === "b") return raw === "1";
    if (type === "e") return { error: unescapeXml(raw) };
    const number = Number(raw);
    return Number.isFinite(number) ? number : unescapeXml(raw);
  }

  // Cambia la fórmula de una celda por su resultado (ya no se recalcula)
  replaceFormulaWithValue(sheet, rowNumber, cell, value) {
    cell.inner = "";
    cell.attrs = withoutAttr(cell.attrs, "t");
    if (value && typeof value === "object" && value.error) {
      cell.attrs = withAttr(cell.attrs, "t", "e");
      cell.inner = `<v>${escapeXml(value.error)}</v>`;
      this.touch(sheet, rowNumber);
      return;
    }
    this.writeValue(sheet, rowNumber, cell, value);
  }

  // Carga la hoja completa: cada fila queda como texto y sus celdas se leen
  // solo cuando se necesitan.
  loadSheet(sheet) {
    if (sheet.rows) return sheet;
    const xml = this.zip.file(sheet.path).asText();
    const bounds = sheetDataBounds(xml);
    if (!bounds) throw new Error(`La hoja "${sheet.name}" no tiene datos.`);
    sheet.head = xml.slice(0, bounds.headEnd);
    sheet.tail = xml.slice(bounds.tailStart);
    sheet.rows = new Map();

    let lastRow = 0;
    const body = xml.slice(bounds.bodyStart, bounds.bodyEnd);
    for (const match of body.matchAll(ROW_RE)) {
      const rowNumber = Number(attrOf(match[1], "r")) || lastRow + 1;
      lastRow = rowNumber;
      sheet.rows.set(rowNumber, {
        raw: match[0],
        attrs: withoutAttr(match[1], "r"),
        inner: match[2] || "",
        cells: null,
        dirty: !attrOf(match[1], "r"),
      });
    }
    sheet.rowNumbers = [...sheet.rows.keys()].sort((a, b) => a - b);
    return sheet;
  }

  parseCells(inner, rowNumber) {
    const cells = new Map();
    let lastCol = 0;
    for (const match of inner.matchAll(CELL_RE)) {
      const ref = parseRef(attrOf(match[1], "r"));
      const col = ref && ref.row === rowNumber ? ref.col : lastCol + 1;
      lastCol = col;
      cells.set(col, { attrs: withoutAttr(match[1], "r"), inner: match[2] || "" });
    }
    return cells;
  }

  cellsOf(sheet, rowNumber) {
    const row = sheet.rows.get(rowNumber);
    if (!row) return null;
    if (!row.cells) row.cells = this.parseCells(row.inner, rowNumber);
    return row.cells;
  }

  cell(sheet, row, col) {
    return this.cellsOf(sheet, row)?.get(col) || null;
  }

  cellText(cell) {
    if (!cell) return "";
    const type = attrOf(cell.attrs, "t");
    if (type === "inlineStr") {
      let text = "";
      for (const t of cell.inner.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) text += t[1] || "";
      return unescapeXml(text);
    }
    const value = /<v>([\s\S]*?)<\/v>/.exec(cell.inner)?.[1] ?? "";
    if (type === "s") return this.sharedStrings[Number(value)] ?? "";
    return unescapeXml(value);
  }

  textsOfCells(cells) {
    const texts = new Map();
    cells.forEach((cell, col) => {
      const text = this.cellText(cell).trim();
      if (text) texts.set(col, text);
    });
    return texts;
  }

  hasValue(cell) {
    return Boolean(cell && HAS_VALUE_RE.test(cell.inner));
  }

  hasFormula(cell) {
    return Boolean(cell && HAS_FORMULA_RE.test(cell.inner));
  }

  rowTexts(sheet, row) {
    const cells = this.cellsOf(sheet, row);
    return cells ? this.textsOfCells(cells) : new Map();
  }

  touch(sheet, rowNumber) {
    sheet.rows.get(rowNumber).dirty = true;
  }

  ensureRow(sheet, rowNumber) {
    const existing = sheet.rows.get(rowNumber);
    if (existing) return existing;
    const entry = { raw: "", attrs: "", inner: "", cells: new Map(), dirty: true };
    sheet.rows.set(rowNumber, entry);
    const numbers = sheet.rowNumbers;
    if (!numbers.length || numbers[numbers.length - 1] < rowNumber) {
      numbers.push(rowNumber);
    } else {
      let low = 0;
      let high = numbers.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (numbers[mid] < rowNumber) low = mid + 1;
        else high = mid;
      }
      numbers.splice(low, 0, rowNumber);
    }
    return entry;
  }

  ensureCell(sheet, rowNumber, col, styleId) {
    this.ensureRow(sheet, rowNumber);
    const cells = this.cellsOf(sheet, rowNumber);
    const existing = cells.get(col);
    if (existing) return existing;
    const cell = { attrs: styleId ? ` s="${styleId}"` : "", inner: "" };
    cells.set(col, cell);
    this.touch(sheet, rowNumber);
    return cell;
  }

  clearValue(cell) {
    cell.inner = cell.inner.replace(/<v\/>|<v>[\s\S]*?<\/v>|<is>[\s\S]*?<\/is>/g, "");
    cell.attrs = withoutAttr(cell.attrs, "t");
  }

  writeValue(sheet, rowNumber, cell, value) {
    this.clearValue(cell);
    this.touch(sheet, rowNumber);
    if (value === null || value === undefined || value === "") return;

    if (value instanceof Date) {
      cell.attrs = withAttr(cell.attrs, "s", this.dateStyleFor(attrOf(cell.attrs, "s")));
      value = dateToSerial(value);
    }
    if (typeof value === "number") {
      cell.inner += `<v>${value}</v>`;
      return;
    }
    if (typeof value === "boolean") {
      cell.attrs = withAttr(cell.attrs, "t", "b");
      cell.inner += `<v>${value ? 1 : 0}</v>`;
      return;
    }
    cell.attrs = withAttr(cell.attrs, "t", "inlineStr");
    cell.inner += `<is><t xml:space="preserve">${escapeXml(value)}</t></is>`;
  }

  writeFormula(sheet, rowNumber, cell, formula) {
    cell.inner = `<f>${escapeXml(formula)}</f>`;
    cell.attrs = withoutAttr(cell.attrs, "t");
    this.touch(sheet, rowNumber);
  }

  // Fórmula efectiva de una celda (resuelve las fórmulas compartidas)
  // { text, row, col }: la fórmula y la celda donde está escrita (en las
  // compartidas, la celda maestra; las demás celdas del grupo la desplazan).
  formulaOf(sheet, cell, row, col = null) {
    const f = FORMULA_RE.exec(cell?.inner || "");
    if (!f) return null;
    const type = attrOf(f[1], "t");
    if (type && type !== "shared") return null; // matriciales / tablas de datos
    const text = unescapeXml(f[2] || "");
    if (text) return { text, row, col };
    if (type !== "shared") return null;

    if (!sheet.sharedFormulas) {
      sheet.sharedFormulas = new Map();
      sheet.rows.forEach(({ inner }, rowNumber) => {
        if (!inner.includes('t="shared"')) return;
        for (const master of inner.matchAll(/<f\b([^>]*)>([^<]+)<\/f>/g)) {
          if (attrOf(master[1], "t") !== "shared") continue;
          const si = attrOf(master[1], "si");
          if (si !== undefined && !sheet.sharedFormulas.has(si)) {
            const origin = parseRange(attrOf(master[1], "ref"))?.from;
            sheet.sharedFormulas.set(si, { text: unescapeXml(master[2]), row: origin?.row || rowNumber, col: origin?.col || null });
          }
        }
      });
    }
    return sheet.sharedFormulas.get(attrOf(f[1], "si")) || null;
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
    this.dirtySheets.add(sheet);
  }

  // Después de llenar: tablas dinámicas se actualizan y fórmulas se recalculan al abrir
  finalize(filledSheets) {
    const headerRows = new Map(filledSheets.map((sheet) => [sheet.name, sheet]));

    // Las definiciones de caché de tablas dinámicas pueden ser grandes: se
    // editan como texto (solo el rango de origen y refreshOnLoad).
    this.zip.file(/^xl\/pivotCache\/pivotCacheDefinition\d+\.xml$/).forEach((file) => {
      let xml = file.asText();
      const source = /<worksheetSource\b([^>]*?)\/?>/.exec(xml);
      const sheetName = source ? unescapeXml(attrOf(source[1], "sheet") || "") : "";
      const filled = headerRows.get(sheetName);
      if (!filled) return;

      const range = parseRange(attrOf(source[1], "ref"));
      if (range && range.from.row === filled.headerRow && filled.lastRow > range.to.row) {
        range.to.row = filled.lastRow;
        const attrs = withAttr(source[1], "ref", formatRange(range));
        xml = xml.slice(0, source.index) + source[0].replace(source[1], attrs) + xml.slice(source.index + source[0].length);
      }
      xml = xml.replace(/<pivotCacheDefinition\b([^>]*)>/, (match, attrs) =>
        `<pivotCacheDefinition${withAttr(attrs, "refreshOnLoad", "1")}>`);
      this.zip.file(file.name, xml);
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

  serializeRow(rowNumber, row) {
    if (!row.dirty) return row.raw;
    const cells = row.cells || this.parseCells(row.inner, rowNumber);
    const cols = [...cells.keys()].sort((a, b) => a - b);
    const parts = cols.map((col) => {
      const cell = cells.get(col);
      const ref = `${numberToCol(col)}${rowNumber}`;
      return cell.inner ? `<c r="${ref}"${cell.attrs}>${cell.inner}</c>` : `<c r="${ref}"${cell.attrs}/>`;
    });
    // El atributo "spans" es solo una pista de rendimiento y puede quedar desfasado
    return `<row r="${rowNumber}"${withoutAttr(row.attrs, "spans")}>${parts.join("")}</row>`;
  }

  // Reemplaza las filas de datos de una hoja (desde keepUntilRow + 1) por las
  // dadas, ya en XML, sin cargar la hoja completa. Ajusta la dimensión y las
  // tablas de Excel que empiezan en el encabezado.
  // rowChunks: iterable de textos XML de filas; se recorre al generar el
  // archivo, sin tener toda la hoja en memoria a la vez.
  replaceSheetRows(sheet, keepUntilRow, rowChunks, lastRow, lastCol) {
    const xml = this.zip.file(sheet.path).asText();
    const bounds = sheetDataBounds(xml);
    if (!bounds) throw new Error(`La hoja "${sheet.name}" no tiene datos.`);
    const kept = [];
    const re = new RegExp(ROW_RE.source, "g");
    re.lastIndex = bounds.bodyStart;
    let match;
    while ((match = re.exec(xml)) && match.index < bounds.bodyEnd) {
      if (Number(attrOf(match[1], "r")) > keepUntilRow) break;
      kept.push(match[0]);
    }
    // Copias propias: un trozo de un texto mantiene vivo el texto completo (100+ MB)
    const own = (text) => Buffer.from(text, "utf8");
    const head = own(`${xml.slice(0, bounds.headEnd).replace(/<dimension\b[^>]*\/>/, `<dimension ref="A1:${numberToCol(lastCol)}${lastRow}"/>`)}<sheetData>${kept.join("")}`);
    const tail = own(`</sheetData>${xml.slice(bounds.tailStart)}`);
    this.streamedSheets.set(sheet.path, function* sheetChunks() {
      yield head;
      for (const chunk of rowChunks) yield Buffer.from(chunk, "utf8");
      yield tail;
    });

    this.tablesOf(sheet).forEach((table) => {
      const root = table.doc.documentElement;
      const range = parseRange(root.getAttribute("ref"));
      if (!range || range.from.row > keepUntilRow) return;
      range.to.row = Math.max(lastRow, range.from.row + 1);
      root.setAttribute("ref", formatRange(range));
      const autoFilter = firstChild(root, "autoFilter");
      if (autoFilter) autoFilter.setAttribute("ref", formatRange(range));
      this.dirty.set(table.path, table.doc);
    });
    this.removeCalcChain();
  }

  // calcChain.xml lista las celdas con fórmula en el orden en que Excel las
  // calcula. Si se agregan o quitan fórmulas deja de coincidir y Excel dice que
  // el archivo tiene "un problema con el contenido". Sin ella, Excel la rearma.
  removeCalcChain() {
    const relsPath = relsPathOf(this.workbookPath);
    const rels = this.zip.file(relsPath)?.asText();
    const rel = rels && /<Relationship\b[^>]*\/calcChain"[^>]*\/>/.exec(rels);
    if (!rel) return;
    const target = resolveTarget(this.workbookPath, attrOf(rel[0], "Target"));
    this.zip.remove(target);
    this.zip.file(relsPath, rels.replace(rel[0], ""));
    const types = this.zip.file("[Content_Types].xml")?.asText();
    if (types) this.zip.file("[Content_Types].xml", types.replace(new RegExp(`<Override\\b[^>]*PartName="/${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/>`), ""));
  }

  // Genera el .xlsx. Se comprime parte por parte (con archiver) para no tener
  // a la vez en memoria el contenido completo y el comprimido de cada hoja.
  async toBuffer() {
    const serializer = new XMLSerializer();
    this.dirty.forEach((doc, filePath) => {
      this.zip.file(filePath, serializer.serializeToString(doc));
    });
    this.dirtySheets.forEach((sheet) => {
      const rows = sheet.rowNumbers.map((rowNumber) => this.serializeRow(rowNumber, sheet.rows.get(rowNumber)));
      this.zip.file(sheet.path, `${sheet.head}<sheetData>${rows.join("")}</sheetData>${sheet.tail}`);
      // Ya escrita: se liberan sus filas
      sheet.rows = null;
    });
    if (this.dirtySheets.size || this.streamedSheets.size) this.removeCalcChain();

    const archive = archiver("zip", { zlib: { level: 6 } });
    const chunks = [];
    archive.on("data", (chunk) => chunks.push(chunk));
    const done = new Promise((resolve, reject) => {
      archive.on("end", resolve);
      archive.on("error", reject);
      archive.on("warning", reject);
    });
    // Mismo orden de la plantilla ([Content_Types].xml primero)
    Object.keys(this.zip.files).forEach((name) => {
      const entry = this.zip.files[name];
      if (entry.dir) return;
      const streamed = this.streamedSheets.get(name);
      archive.append(streamed ? Readable.from(streamed(), { objectMode: false }) : entry.asNodeBuffer(), { name });
    });
    archive.finalize();
    await done;
    return Buffer.concat(chunks);
  }
}

// ── Emparejar hojas del KPI con las fuentes ─────────────────────────────────

// Busca en las primeras filas de la hoja el encabezado que mejor coincide con
// los campos de alguna fuente. Devuelve null si ninguna coincide. Solo lee
// esas primeras filas, no la hoja completa.
const matchSheet = (book, sheet, candidates) => {
  const headRows = book.headTexts(sheet, HEADER_SCAN_ROWS);
  const sheetKey = compact(sheet.name);
  let best = null;

  headRows.forEach((texts, row) => {
    if (texts.size === 0) return;

    candidates.forEach((candidate) => {
      let score = 0;
      texts.forEach((text) => {
        if (candidate.fieldKeys.has(compact(text))) score += 1;
      });
      if (score === 0) return;

      const nameMatch = candidate.nameKeys.some((key) =>
        key === sheetKey || (sheetKey.length >= 10 && key.startsWith(sheetKey))
      );
      // Proporción de encabezados del KPI que existen en la hoja de origen: la
      // hoja del KPI suele usar solo algunas columnas de una fuente muy ancha.
      const ratio = score / texts.size;
      const valid = score >= Math.min(2, candidate.fieldKeys.size) && (ratio >= 0.5 || (nameMatch && score >= 1));
      if (!valid) return;

      const rank = (nameMatch ? 1000 : 0) + score + ratio;
      if (!best || rank > best.rank) best = { candidate, headerRow: row, headers: texts, rank };
    });
  });
  return best;
};

// Encabezado de la hoja para una fuente elegida por el usuario: la fila (entre
// las primeras) con más encabezados que existen en esa fuente.
const matchSheetTo = (book, sheet, candidate) => {
  let best = null;
  book.headTexts(sheet, HEADER_SCAN_ROWS).forEach((texts, row) => {
    let score = 0;
    texts.forEach((text) => {
      if (candidate.fieldKeys.has(compact(text))) score += 1;
    });
    if (score > 0 && (!best || score > best.score)) best = { candidate, headerRow: row, headers: texts, score };
  });
  return best;
};

// Escribe las filas en la hoja bajo el encabezado. Solo toca las columnas cuyo
// encabezado coincide con un campo; las celdas con fórmula nunca se sobrescriben.
const fillSheet = (book, sheet, match, rows, extraColumns = {}) => {
  book.loadSheet(sheet);
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

  // Solo advertir por valores previos: las fórmulas preparadas se conservan,
  // incluso cuando incluyen un resultado calculado en caché.
  for (let row = oldLast + 1; row <= newLast; row += 1) {
    if (!sheet.rows.has(row)) continue;
    const occupied = mappedCols.some((col) => {
      const cell = book.cell(sheet, row, col);
      return !book.hasFormula(cell) && book.hasValue(cell);
    });
    if (occupied) {
      advertencias.push(`Hoja "${sheet.name}": había contenido en la fila ${row}, debajo de los datos anteriores; revisa que no se haya mezclado con la información nueva.`);
      break;
    }
  }

  // Estilo de referencia de cada columna: primera fila de datos
  const styleOf = (col) => attrOf(book.cell(sheet, dataStart, col)?.attrs || "", "s") || null;
  const styles = new Map(mappedCols.map((col) => [col, styleOf(col)]));

  rows.forEach((record, index) => {
    const rowNumber = dataStart + index;
    mapped.forEach(({ col, key }) => {
      const existing = book.cell(sheet, rowNumber, col);
      if (book.hasFormula(existing)) return;
      const value = toCellValue(extraColumns[key] ? extraColumns[key](record) : record.get(key));
      if (value === null && !existing) return;
      const cell = existing || book.ensureCell(sheet, rowNumber, col, styles.get(col));
      book.writeValue(sheet, rowNumber, cell, value);
    });
  });

  // Limpia lo que sobra de la información anterior
  for (let row = newLast + 1; row <= oldLast; row += 1) {
    mappedCols.forEach((col) => {
      const cell = book.cell(sheet, row, col);
      if (cell && !book.hasFormula(cell) && book.hasValue(cell)) {
        book.clearValue(cell);
        book.touch(sheet, row);
      }
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
      const cell = book.cell(sheet, row, col);
      if (book.hasFormula(cell) || book.hasValue(cell)) continue;
      const target = cell || book.ensureCell(sheet, row, col, attrOf(first.attrs, "s"));
      book.writeFormula(sheet, row, target, shiftFormula(formula.text, row - formula.row));
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

  sheet.tail = sheet.tail.replace(/<autoFilter\b([^>]*?)(\/?>)/, (whole, attrs, end) => {
    const range = parseRange(attrOf(attrs, "ref"));
    if (!range || range.from.row !== headerRow || lastRow <= range.to.row) return whole;
    range.to.row = lastRow;
    return `<autoFilter${withAttr(attrs, "ref", formatRange(range))}${end}`;
  });

  sheet.head = sheet.head.replace(/<dimension\b([^>]*?)\/>/, (whole, attrs) => {
    const range = parseRange(attrOf(attrs, "ref"));
    if (!range) return whole;
    const maxCol = Math.max(range.to.col, ...mappedCols);
    if (lastRow <= range.to.row && maxCol <= range.to.col) return whole;
    range.to.row = Math.max(range.to.row, lastRow);
    range.to.col = maxCol;
    return `<dimension${withAttr(attrs, "ref", formatRange(range))}/>`;
  });

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
  colToNumber,
  numberToCol,
  matchSheet,
  matchSheetTo,
  fillSheet,
  shiftFormula,
  toCellValue,
  escapeXml,
  dateToSerial,
};
