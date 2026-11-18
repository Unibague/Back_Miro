const { colToNumber } = require("./kpiWorkbook");

// Evalúa en el servidor las fórmulas de una plantilla KPI que leen hojas de
// datos demasiado grandes para Excel (p. ej. 384.000 matriculados). Esas hojas
// no se escriben en el archivo: quedan "virtuales", con sus columnas de datos
// en memoria y sus columnas calculadas evaluadas con la fórmula de su primera
// fila. Las celdas de las demás hojas que las leen (COUNTIFS, MINIFS…) se
// reemplazan por su resultado; el resto de fórmulas sigue siendo de Excel.

class XlError {
  constructor(code) {
    this.error = code;
  }
}
const NA = new XlError("#N/A");
const VALUE = new XlError("#VALUE!");
const DIV0 = new XlError("#DIV/0!");
const REF = new XlError("#REF!");
const isError = (value) => value instanceof XlError;

class UnsupportedFormula extends Error {}

// ── Análisis de fórmulas ────────────────────────────────────────────────────

const SHEET_CHARS = /[^\s'!(),&+\-*/^=<>:";{}%]/;
const CELL_REF = /^(\$?)([A-Z]{1,3})(\$?)(\d+)$/;
const COL_REF = /^(\$?)([A-Z]{1,3})$/;

const tokenize = (text) => {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '"') {
      let value = "";
      i += 1;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { value += '"'; i += 2; continue; }
          i += 1;
          break;
        }
        value += text[i];
        i += 1;
      }
      tokens.push({ type: "str", value });
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const match = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(text.slice(i));
      tokens.push({ type: "num", value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === "<=" || two === ">=" || two === "<>") { tokens.push({ type: "op", value: two }); i += 2; continue; }
    if ("+-*/^&=<>%".includes(ch)) { tokens.push({ type: "op", value: ch }); i += 1; continue; }
    if (ch === "(" || ch === ")" || ch === "," || ch === ":") { tokens.push({ type: ch }); i += 1; continue; }
    if (ch === "'") {
      let name = "";
      i += 1;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") { name += "'"; i += 2; continue; }
          i += 1;
          break;
        }
        name += text[i];
        i += 1;
      }
      if (text[i] !== "!") throw new UnsupportedFormula(`Referencia no reconocida: '${name}'`);
      i += 1;
      tokens.push({ type: "sheet", value: name });
      continue;
    }
    if (SHEET_CHARS.test(ch) || ch === "$") {
      let word = "";
      while (i < text.length && (SHEET_CHARS.test(text[i]) || text[i] === "$")) { word += text[i]; i += 1; }
      if (text[i] === "!") { tokens.push({ type: "sheet", value: word }); i += 1; continue; }
      if (text[i] === "(") { tokens.push({ type: "func", value: word.toUpperCase().replace(/^_XLFN\.|^_XLWS\./, "") }); continue; }
      tokens.push({ type: "word", value: word });
      continue;
    }
    throw new UnsupportedFormula(`Carácter no reconocido "${ch}"`);
  }
  return tokens;
};

const parseRefPart = (word) => {
  const cell = CELL_REF.exec(word);
  if (cell) return { col: colToNumber(cell[2]), colAbs: !!cell[1], row: Number(cell[4]), rowAbs: !!cell[3] };
  const col = COL_REF.exec(word);
  if (col) return { col: colToNumber(col[2]), colAbs: !!col[1], row: null, rowAbs: true };
  return null;
};

const parse = (text) => {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const isOp = (...ops) => peek()?.type === "op" && ops.includes(peek().value);

  const parseRef = (sheet) => {
    const first = next();
    if (first?.type !== "word") throw new UnsupportedFormula("Referencia incompleta");
    const start = parseRefPart(first.value);
    if (!start) throw new UnsupportedFormula(`Nombre no soportado: ${first.value}`);
    let end = start;
    if (peek()?.type === ":") {
      next();
      const second = next();
      end = second?.type === "word" ? parseRefPart(second.value) : null;
      if (!end) throw new UnsupportedFormula("Rango no soportado");
    } else if (start.row === null) {
      throw new UnsupportedFormula(`Referencia no soportada: ${first.value}`);
    }
    return { kind: "ref", sheet, start, end };
  };

  const primary = () => {
    const token = peek();
    if (!token) throw new UnsupportedFormula("Fórmula incompleta");
    if (token.type === "num") { next(); return { kind: "lit", value: token.value }; }
    if (token.type === "str") { next(); return { kind: "lit", value: token.value }; }
    if (token.type === "(") {
      next();
      const inner = expression();
      if (next()?.type !== ")") throw new UnsupportedFormula("Paréntesis sin cerrar");
      return inner;
    }
    if (token.type === "func") {
      next();
      next(); // (
      const args = [];
      if (peek()?.type !== ")") {
        for (;;) {
          if (peek()?.type === "," || peek()?.type === ")") args.push({ kind: "lit", value: null });
          else args.push(expression());
          if (peek()?.type === ",") { next(); continue; }
          break;
        }
      }
      if (next()?.type !== ")") throw new UnsupportedFormula(`Argumentos de ${token.value} sin cerrar`);
      return { kind: "call", name: token.value, args };
    }
    if (token.type === "sheet") { next(); return parseRef(token.value); }
    if (token.type === "word") {
      const upper = token.value.toUpperCase();
      if (upper === "TRUE" || upper === "FALSE") { next(); return { kind: "lit", value: upper === "TRUE" }; }
      return parseRef(null);
    }
    throw new UnsupportedFormula("Expresión no soportada");
  };

  const postfix = () => {
    let node = primary();
    while (isOp("%")) { next(); node = { kind: "bin", op: "/", left: node, right: { kind: "lit", value: 100 } }; }
    return node;
  };
  const unary = () => {
    if (isOp("-", "+")) {
      const op = next().value;
      const operand = unary();
      return op === "-" ? { kind: "neg", operand } : { kind: "pos", operand };
    }
    return postfix();
  };
  const binary = (sub, ops) => () => {
    let node = sub();
    while (isOp(...ops)) {
      const op = next().value;
      node = { kind: "bin", op, left: node, right: sub() };
    }
    return node;
  };
  const power = binary(unary, ["^"]);
  const multiplicative = binary(power, ["*", "/"]);
  const additive = binary(multiplicative, ["+", "-"]);
  const concat = binary(additive, ["&"]);
  const expression = binary(concat, ["=", "<>", "<", ">", "<=", ">="]);

  const tree = expression();
  if (pos < tokens.length) throw new UnsupportedFormula("Sobran elementos en la fórmula");
  return tree;
};

// ── Valores ─────────────────────────────────────────────────────────────────

class Range {
  constructor(sheet, c1, r1, c2, r2) {
    this.sheet = sheet;
    this.c1 = Math.min(c1, c2);
    this.c2 = Math.max(c1, c2);
    this.r1 = Math.min(r1, r2);
    this.r2 = Math.max(r1, r2);
  }

  get rows() { return this.r2 - this.r1 + 1; }

  get cols() { return this.c2 - this.c1 + 1; }

  get key() { return `${this.sheet}!${this.c1},${this.r1}:${this.c2},${this.r2}`; }
}

const isBlank = (value) => value === null || value === undefined;

// Sin "Math.max(...lista)": con cientos de miles de valores desborda la pila
const maxOf = (numbers) => numbers.reduce((a, b) => (b > a ? b : a), -Infinity);
const minOf = (numbers) => numbers.reduce((a, b) => (b < a ? b : a), Infinity);

const toNumber = (value) => {
  if (isError(value)) return value;
  if (isBlank(value) || value === "") return 0;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  const text = String(value).trim();
  if (text === "") return VALUE;
  const number = Number(text);
  return Number.isFinite(number) ? number : VALUE;
};

const toText = (value) => {
  if (isBlank(value)) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(15)));
  return String(value);
};

const toBool = (value) => {
  if (isError(value)) return value;
  if (isBlank(value)) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const upper = String(value).toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  return VALUE;
};

// Orden de Excel al comparar: números < textos < booleanos; vacío ≈ 0 o ""
const typeRank = (value) => (typeof value === "number" ? 0 : typeof value === "string" ? 1 : 2);
const compareValues = (a, b) => {
  if (isBlank(a)) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (isBlank(b)) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (ra === 2) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
};

// Llave para búsquedas exactas (MATCH, criterios de igualdad): "5" y 5 coinciden
const lookupKey = (value) => {
  if (isBlank(value) || value === "") return "";
  if (typeof value === "number") return `n${value}`;
  if (typeof value === "boolean") return `b${value}`;
  if (isError(value)) return `e${value.error}`;
  const text = String(value);
  const number = Number(text);
  if (text.trim() !== "" && Number.isFinite(number)) return `n${number}`;
  return `s${text.toLowerCase()}`;
};

// Criterio de COUNTIFS y similares: igualdad (con llave) o comparación
const parseCriterion = (criterion) => {
  if (isError(criterion)) return { error: criterion };
  if (typeof criterion !== "string") return { eq: lookupKey(criterion) };
  const match = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(criterion);
  const op = match[1] || "=";
  const operandText = match[2];
  if (/[*?~]/.test(operandText) && (op === "=" || op === "<>")) {
    throw new UnsupportedFormula("Criterios con comodines (*, ?) no soportados");
  }
  const number = Number(operandText);
  const operand = operandText.trim() !== "" && Number.isFinite(number) ? number : operandText;
  if (op === "=") return { eq: lookupKey(operand) };
  if (op === "<>") {
    const key = lookupKey(operand);
    return { test: (value) => lookupKey(value) !== key };
  }
  const numeric = typeof operand === "number";
  return {
    test: (value) => {
      if (isBlank(value) || isError(value)) return false;
      if (numeric !== (typeof value === "number")) return false;
      const cmp = compareValues(value, operand);
      return op === "<" ? cmp < 0 : op === ">" ? cmp > 0 : op === "<=" ? cmp <= 0 : cmp >= 0;
    },
  };
};

// ── Motor ───────────────────────────────────────────────────────────────────

class FormulaEngine {
  // virtualSheets: Map nombre → { headerRow, count, inputs: Map col → valores }
  constructor(book, virtualSheets) {
    this.book = book;
    this.virtual = new Map();
    this.sheetsByName = new Map(book.sheets.map((sheet) => [sheet.name, sheet]));
    this.compiled = new Map();
    this.cellCache = new Map();
    this.inProgress = new Set();
    this.matchIndexes = new Map();
    this.groupIndexes = new Map();
    this.unsupported = new Map();

    virtualSheets.forEach((config, name) => {
      const sheet = this.sheetsByName.get(name);
      book.headTexts(sheet, config.headerRow + 1);
      const dataRow = config.headerRow + 1;
      const formulas = new Map();
      (sheet.headCells.get(dataRow) || new Map()).forEach((cell, col) => {
        if (config.inputs.has(col)) return;
        const formula = this.headFormula(sheet, cell, dataRow, col);
        if (formula) formulas.set(col, formula);
      });
      this.virtual.set(name, { ...config, sheet, dataRow, lastRow: config.headerRow + config.count, formulas, columns: new Map() });
    });
  }

  // Fórmula de una celda de las primeras filas de una hoja virtual (sin cargarla entera)
  headFormula(sheet, cell, row, col) {
    const direct = this.book.formulaOf(sheet, cell, row, col);
    if (direct?.text) return direct;
    const si = /<f\b[^>]*\bsi="(\d+)"/.exec(cell.inner)?.[1];
    if (si === undefined) return null;
    for (const [rowNumber, cells] of sheet.headCells) {
      for (const [masterCol, master] of cells) {
        const f = /<f\b([^>]*)>([^<]+)<\/f>/.exec(master.inner);
        if (f && new RegExp(`\\bsi="${si}"`).test(f[1])) {
          return { ...this.book.formulaOf(sheet, master, rowNumber, masterCol), col: masterCol };
        }
      }
    }
    return null;
  }

  compile(text) {
    if (!this.compiled.has(text)) this.compiled.set(text, parse(text));
    return this.compiled.get(text);
  }

  // ── Celdas ──

  maxRow(sheetName) {
    const vs = this.virtual.get(sheetName);
    if (vs) return vs.lastRow;
    const sheet = this.loaded(sheetName);
    return sheet.rowNumbers[sheet.rowNumbers.length - 1] || 1;
  }

  loaded(sheetName) {
    const sheet = this.sheetsByName.get(sheetName);
    if (!sheet) throw new UnsupportedFormula(`La hoja "${sheetName}" no existe`);
    return this.book.loadSheet(sheet);
  }

  value(sheetName, col, row) {
    const vs = this.virtual.get(sheetName);
    if (vs) return this.virtualValue(vs, col, row);

    const key = `${sheetName}!${col},${row}`;
    if (this.cellCache.has(key)) return this.cellCache.get(key);
    const sheet = this.loaded(sheetName);
    const cell = this.book.cell(sheet, row, col);
    if (!cell) return null;
    const formula = this.book.formulaOf(sheet, cell, row, col);
    if (!formula) {
      const literal = this.book.cellValue(cell);
      return literal && typeof literal === "object" ? new XlError(literal.error) : literal;
    }
    if (this.inProgress.has(key)) return 0; // referencia circular
    this.inProgress.add(key);
    let result;
    try {
      result = this.evaluateFormula(formula, sheetName, row, col);
    } finally {
      this.inProgress.delete(key);
    }
    this.cellCache.set(key, result);
    return result;
  }

  evaluateFormula(formula, sheetName, row, col) {
    const tree = this.compile(formula.text);
    const ctx = { sheet: sheetName, row, col, dr: row - formula.row, dc: formula.col === null ? 0 : col - formula.col };
    return this.scalar(this.evaluate(tree, ctx));
  }

  virtualValue(vs, col, row) {
    if (row < vs.dataRow || row > vs.lastRow) {
      if (row > vs.lastRow) return null;
      const cell = vs.sheet.headCells.get(row)?.get(col);
      return cell ? this.book.cellValue(cell) : null;
    }
    const index = row - vs.dataRow;
    const input = vs.inputs.get(col);
    if (input) return input[index] ?? null;
    if (vs.formulas.has(col)) return this.virtualColumn(vs, col)[index];
    return null;
  }

  // Calcula una columna completa de una hoja virtual con la fórmula de su
  // primera fila de datos, desplazada a cada fila.
  virtualColumn(vs, col) {
    if (vs.columns.has(col)) return vs.columns.get(col);
    const key = `${vs.sheet.name}!col${col}`;
    if (this.inProgress.has(key)) throw new UnsupportedFormula(`Referencia circular en la columna ${col} de ${vs.sheet.name}`);
    this.inProgress.add(key);
    try {
      const formula = vs.formulas.get(col);
      const tree = this.compile(formula.text);
      const values = new Array(vs.count);
      const ctx = { sheet: vs.sheet.name, row: 0, col, dr: 0, dc: formula.col === null ? 0 : col - formula.col };
      for (let i = 0; i < vs.count; i += 1) {
        ctx.row = vs.dataRow + i;
        ctx.dr = ctx.row - formula.row;
        values[i] = this.scalar(this.evaluate(tree, ctx));
      }
      vs.columns.set(col, values);
      return values;
    } finally {
      this.inProgress.delete(key);
    }
  }

  // ── Evaluación ──

  resolveRef(node, ctx) {
    const sheet = node.sheet || ctx.sheet;
    const at = (part) => ({
      col: part.colAbs ? part.col : part.col + ctx.dc,
      row: part.row === null ? null : part.rowAbs ? part.row : part.row + ctx.dr,
    });
    const a = at(node.start);
    const b = at(node.end);
    if (a.row === null || b.row === null) return new Range(sheet, a.col, 1, b.col, this.maxRow(sheet));
    if (a.col < 1 || a.row < 1 || b.col < 1 || b.row < 1) return REF;
    return new Range(sheet, a.col, a.row, b.col, b.row);
  }

  scalar(value) {
    if (value instanceof Range) {
      if (value.rows === 1 && value.cols === 1) return this.value(value.sheet, value.c1, value.r1);
      return VALUE;
    }
    return value;
  }

  evaluate(node, ctx) {
    switch (node.kind) {
      case "lit": return node.value;
      case "ref": return this.resolveRef(node, ctx);
      case "neg": {
        const n = toNumber(this.scalar(this.evaluate(node.operand, ctx)));
        return isError(n) ? n : -n;
      }
      case "pos": return this.scalar(this.evaluate(node.operand, ctx));
      case "bin": return this.binary(node, ctx);
      case "call": return this.call(node, ctx);
      default: throw new UnsupportedFormula("Expresión no soportada");
    }
  }

  binary(node, ctx) {
    const left = this.scalar(this.evaluate(node.left, ctx));
    const right = this.scalar(this.evaluate(node.right, ctx));
    if (isError(left)) return left;
    if (isError(right)) return right;
    switch (node.op) {
      case "&": return toText(left) + toText(right);
      case "=": return compareValues(left, right) === 0;
      case "<>": return compareValues(left, right) !== 0;
      case "<": return compareValues(left, right) < 0;
      case ">": return compareValues(left, right) > 0;
      case "<=": return compareValues(left, right) <= 0;
      case ">=": return compareValues(left, right) >= 0;
      default: break;
    }
    const a = toNumber(left);
    const b = toNumber(right);
    if (isError(a)) return a;
    if (isError(b)) return b;
    switch (node.op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return b === 0 ? DIV0 : a / b;
      case "^": return a ** b;
      default: throw new UnsupportedFormula(`Operador ${node.op} no soportado`);
    }
  }

  // Valores de un rango (o de un valor suelto) para funciones como MAX o COUNTA
  *valuesOf(value) {
    if (value instanceof Range) {
      for (let r = value.r1; r <= value.r2; r += 1) {
        for (let c = value.c1; c <= value.c2; c += 1) yield { value: this.value(value.sheet, c, r), fromRange: true };
      }
    } else {
      yield { value, fromRange: false };
    }
  }

  // Posición (1…n) de cada valor en un rango de una fila o columna
  matchIndex(range) {
    const key = range.key;
    if (this.matchIndexes.has(key)) return this.matchIndexes.get(key);
    const index = new Map();
    const vertical = range.cols === 1;
    const length = vertical ? range.rows : range.cols;
    for (let i = 0; i < length; i += 1) {
      const value = vertical ? this.value(range.sheet, range.c1, range.r1 + i) : this.value(range.sheet, range.c1 + i, range.r1);
      const lookup = lookupKey(value);
      if (lookup !== "" && !index.has(lookup)) index.set(lookup, i + 1);
    }
    this.matchIndexes.set(key, index);
    return index;
  }

  // Filas (posiciones dentro del rango) agrupadas por los valores de varias columnas
  groupIndex(ranges) {
    const key = ranges.map((range) => range.key).join("|");
    if (this.groupIndexes.has(key)) return this.groupIndexes.get(key);
    const index = new Map();
    const length = ranges[0].rows;
    const columns = ranges.map((range) => this.columnValues(range));
    for (let i = 0; i < length; i += 1) {
      let groupKey = "";
      for (const values of columns) groupKey += `${lookupKey(values[i])}\u0001`;
      let list = index.get(groupKey);
      if (!list) index.set(groupKey, (list = []));
      list.push(i);
    }
    this.groupIndexes.set(key, index);
    return index;
  }

  // Valores de un rango de una columna, como arreglo
  columnValues(range) {
    const vs = this.virtual.get(range.sheet);
    if (vs && range.r1 === 1 && range.r2 === vs.lastRow) {
      const head = [];
      for (let r = 1; r < vs.dataRow; r += 1) head.push(this.virtualValue(vs, range.c1, r));
      const body = vs.inputs.get(range.c1) || (vs.formulas.has(range.c1) ? this.virtualColumn(vs, range.c1) : null);
      return body ? head.concat(body) : head.concat(new Array(vs.count).fill(null));
    }
    const values = new Array(range.rows);
    for (let i = 0; i < range.rows; i += 1) values[i] = this.value(range.sheet, range.c1, range.r1 + i);
    return values;
  }

  // Filas que cumplen los criterios de COUNTIFS/SUMIFS/MAXIFS…
  matchingRows(pairs) {
    const ranges = pairs.map(([range]) => range);
    if (ranges.some((range) => !(range instanceof Range) || range.cols !== 1)) throw new UnsupportedFormula("Rangos de criterios no soportados");
    if (ranges.some((range) => range.rows !== ranges[0].rows)) return VALUE;
    const criteria = pairs.map(([, criterion]) => parseCriterion(criterion));
    const failed = criteria.find((criterion) => criterion.error);
    if (failed) return failed.error;

    const eqPositions = criteria.map((criterion, i) => (criterion.eq !== undefined ? i : -1)).filter((i) => i >= 0);
    let candidates;
    if (eqPositions.length) {
      const index = this.groupIndex(eqPositions.map((i) => ranges[i]));
      candidates = index.get(eqPositions.map((i) => `${criteria[i].eq}\u0001`).join("")) || [];
    } else {
      candidates = null;
    }
    const tests = criteria.map((criterion, i) => (criterion.test ? { test: criterion.test, values: this.columnValues(ranges[i]) } : null)).filter(Boolean);
    const result = [];
    const length = ranges[0].rows;
    if (candidates) {
      for (const i of candidates) if (tests.every(({ test, values }) => test(values[i]))) result.push(i);
    } else {
      for (let i = 0; i < length; i += 1) if (tests.every(({ test, values }) => test(values[i]))) result.push(i);
    }
    return result;
  }

  ifsArgs(args, ctx, offset) {
    const pairs = [];
    for (let i = offset; i < args.length; i += 2) {
      pairs.push([this.evaluate(args[i], ctx), this.scalar(this.evaluate(args[i + 1], ctx))]);
    }
    return pairs;
  }

  call(node, ctx) {
    const { name, args } = node;
    const arg = (i) => (i < args.length ? this.evaluate(args[i], ctx) : undefined);
    const val = (i) => this.scalar(arg(i));
    const num = (i) => toNumber(val(i));

    switch (name) {
      case "IF": {
        const condition = toBool(val(0));
        if (isError(condition)) return condition;
        if (condition) return args.length > 1 ? val(1) : true;
        return args.length > 2 ? val(2) : false;
      }
      case "IFERROR": {
        const value = val(0);
        return isError(value) ? val(1) : value;
      }
      case "AND":
      case "OR": {
        let result = name === "AND";
        for (let i = 0; i < args.length; i += 1) {
          for (const { value, fromRange } of this.valuesOf(arg(i))) {
            if (fromRange && (isBlank(value) || typeof value === "string")) continue;
            const b = toBool(value);
            if (isError(b)) return b;
            result = name === "AND" ? result && b : result || b;
          }
        }
        return result;
      }
      case "NOT": {
        const b = toBool(val(0));
        return isError(b) ? b : !b;
      }
      case "ISNUMBER": return typeof val(0) === "number";
      case "ISBLANK": return isBlank(val(0));
      case "ISERROR": return isError(val(0));
      case "N": {
        const v = val(0);
        return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : isError(v) ? v : 0;
      }
      case "INT": { const n = num(0); return isError(n) ? n : Math.floor(n); }
      case "ABS": { const n = num(0); return isError(n) ? n : Math.abs(n); }
      case "MOD": {
        const a = num(0);
        const b = num(1);
        if (isError(a)) return a;
        if (isError(b)) return b;
        if (b === 0) return DIV0;
        return a - b * Math.floor(a / b);
      }
      case "ROUND": {
        const a = num(0);
        const d = args.length > 1 ? num(1) : 0;
        if (isError(a)) return a;
        const factor = 10 ** d;
        return Math.round(a * factor) / factor;
      }
      case "MAX":
      case "MIN":
      case "SUM":
      case "COUNT":
      case "AVERAGE": {
        const numbers = [];
        for (let i = 0; i < args.length; i += 1) {
          for (const { value, fromRange } of this.valuesOf(arg(i))) {
            if (isError(value)) return value;
            if (typeof value === "number") numbers.push(value);
            else if (!fromRange && !isBlank(value)) {
              const n = toNumber(value);
              if (isError(n)) return n;
              numbers.push(n);
            }
          }
        }
        if (name === "COUNT") return numbers.length;
        if (name === "SUM") return numbers.reduce((a, b) => a + b, 0);
        if (name === "AVERAGE") return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : DIV0;
        if (!numbers.length) return 0;
        return name === "MAX" ? maxOf(numbers) : minOf(numbers);
      }
      case "COUNTA": {
        let count = 0;
        for (let i = 0; i < args.length; i += 1) {
          for (const { value } of this.valuesOf(arg(i))) if (!isBlank(value)) count += 1;
        }
        return count;
      }
      case "ROW": {
        if (!args.length) return ctx.row;
        const ref = arg(0);
        return ref instanceof Range ? ref.r1 : VALUE;
      }
      case "COLUMN": {
        if (!args.length) return ctx.col;
        const ref = arg(0);
        return ref instanceof Range ? ref.c1 : VALUE;
      }
      case "MATCH": {
        const lookup = val(0);
        if (isError(lookup)) return lookup;
        const range = arg(1);
        if (!(range instanceof Range) || (range.rows > 1 && range.cols > 1)) return NA;
        const type = args.length > 2 ? num(2) : 1;
        if (type === 0) return this.matchIndex(range).get(lookupKey(lookup)) ?? NA;
        // Coincidencia aproximada (rango ordenado): búsqueda lineal
        const vertical = range.cols === 1;
        const length = vertical ? range.rows : range.cols;
        let found = NA;
        for (let i = 0; i < length; i += 1) {
          const value = vertical ? this.value(range.sheet, range.c1, range.r1 + i) : this.value(range.sheet, range.c1 + i, range.r1);
          if (isBlank(value)) continue;
          const cmp = compareValues(value, lookup);
          if (type > 0 ? cmp <= 0 : cmp >= 0) found = i + 1;
          else break;
        }
        return found;
      }
      case "INDEX": {
        const range = arg(0);
        if (!(range instanceof Range)) return range;
        let r = num(1);
        let c = args.length > 2 ? num(2) : 1;
        if (isError(r)) return r;
        if (isError(c)) return c;
        if (args.length <= 2 && range.rows === 1) { c = r; r = 1; }
        if (r < 1 || c < 1 || r > range.rows || c > range.cols) return REF;
        return this.value(range.sheet, range.c1 + c - 1, range.r1 + r - 1);
      }
      case "COUNTIF":
      case "COUNTIFS": {
        const rows = this.matchingRows(this.ifsArgs(args, ctx, 0));
        return isError(rows) ? rows : rows.length;
      }
      case "SUMIFS":
      case "AVERAGEIFS":
      case "MAXIFS":
      case "MINIFS": {
        const target = arg(0);
        if (!(target instanceof Range) || target.cols !== 1) throw new UnsupportedFormula(`${name}: rango no soportado`);
        const rows = this.matchingRows(this.ifsArgs(args, ctx, 1));
        if (isError(rows)) return rows;
        const values = this.columnValues(target);
        const numbers = rows.map((i) => values[i]).filter((v) => typeof v === "number");
        if (name === "SUMIFS") return numbers.reduce((a, b) => a + b, 0);
        if (name === "AVERAGEIFS") return numbers.length ? numbers.reduce((a, b) => a + b, 0) / numbers.length : DIV0;
        if (!numbers.length) return 0;
        return name === "MAXIFS" ? maxOf(numbers) : minOf(numbers);
      }
      case "TRIM": { const v = val(0); return isError(v) ? v : toText(v).trim().replace(/ {2,}/g, " "); }
      case "LEN": { const v = val(0); return isError(v) ? v : toText(v).length; }
      case "UPPER": { const v = val(0); return isError(v) ? v : toText(v).toUpperCase(); }
      case "LOWER": { const v = val(0); return isError(v) ? v : toText(v).toLowerCase(); }
      case "LEFT": {
        const v = val(0);
        const n = args.length > 1 ? num(1) : 1;
        return isError(v) ? v : isError(n) ? n : toText(v).slice(0, n);
      }
      case "MID": {
        const v = val(0);
        const start = num(1);
        const n = num(2);
        if (isError(v)) return v;
        if (isError(start) || isError(n)) return VALUE;
        return toText(v).substr(start - 1, n);
      }
      case "FIND": {
        const what = toText(val(0));
        const within = toText(val(1));
        const start = args.length > 2 ? num(2) : 1;
        const position = within.indexOf(what, start - 1);
        return position < 0 ? VALUE : position + 1;
      }
      case "SUBSTITUTE": {
        const text = toText(val(0));
        const from = toText(val(1));
        const to = toText(val(2));
        return from ? text.split(from).join(to) : text;
      }
      case "VALUE": {
        const v = val(0);
        if (typeof v === "number") return v;
        const n = Number(toText(v).trim());
        return toText(v).trim() !== "" && Number.isFinite(n) ? n : VALUE;
      }
      default:
        throw new UnsupportedFormula(`Función ${name} no soportada`);
    }
  }

  // ── Resultado ──

  // Reemplaza por su resultado cada fórmula (de las hojas no virtuales) que
  // lee una hoja virtual. Las demás fórmulas quedan para que Excel las calcule.
  materialize() {
    const names = [...this.virtual.keys()];
    const readsVirtual = new RegExp(names.map((name) => `(^|[^A-Za-z0-9_.])'?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'?!`).join("|"));
    let celdas = 0;
    let errores = 0;
    const touched = [];

    for (const sheet of this.book.sheets) {
      if (this.virtual.has(sheet.name)) continue;
      // Solo se cargan las hojas que mencionan alguna hoja virtual
      const xml = sheet.rows ? null : this.book.zip.file(sheet.path).asText();
      if (xml && !names.some((name) => xml.includes(`${name}!`))) continue;
      this.book.loadSheet(sheet);

      const pending = [];
      for (const rowNumber of sheet.rowNumbers) {
        const row = sheet.rows.get(rowNumber);
        if (!row.inner.includes("<f")) continue;
        this.book.cellsOf(sheet, rowNumber).forEach((cell, col) => {
          const formula = this.book.formulaOf(sheet, cell, rowNumber, col);
          if (formula && readsVirtual.test(formula.text)) pending.push({ rowNumber, col, cell });
        });
      }
      if (!pending.length) continue;

      // Primero se evalúan todas y después se escriben: así ninguna lee un
      // valor ya reemplazado de otra celda del mismo grupo de fórmulas.
      const results = pending.map(({ rowNumber, col, cell }) => {
        try {
          return { rowNumber, col, cell, value: this.value(sheet.name, col, rowNumber) };
        } catch (error) {
          if (!(error instanceof UnsupportedFormula)) throw error;
          this.unsupported.set(`${sheet.name}: ${error.message}`, (this.unsupported.get(`${sheet.name}: ${error.message}`) || 0) + 1);
          return null;
        }
      });
      results.forEach((result) => {
        if (!result) return;
        const { rowNumber, cell, value } = result;
        if (isError(value)) errores += 1;
        this.book.replaceFormulaWithValue(sheet, rowNumber, cell, isError(value) ? { error: value.error } : value === "" ? null : value);
        celdas += 1;
      });
      this.book.markDirty(sheet);
      touched.push(sheet.name);
    }

    return {
      celdas,
      errores,
      hojas: touched,
      noSoportadas: [...this.unsupported.entries()].map(([message, count]) => `${message} (${count} celdas)`),
    };
  }
}

module.exports = { FormulaEngine, UnsupportedFormula, parse };
