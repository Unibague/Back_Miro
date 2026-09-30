const fs = require("fs");
const path = require("path");
const axios = require("axios");
const ExcelJS = require("exceljs");
const CnaPlantilla = require("../models/cnaPlantillas");
const SniesTemplate = require("../models/sniesTemplates");
const PublishedTemplate = require("../models/publishedTemplates");
const Program = require("../models/programs");
const HistoricoDocentes = require("../models/historicoDocentes");
const Period = require("../models/periods");
const { getPoblacionEstudiantil } = require("../services/poblacionEstudiantil");
const Dependency = require("../models/dependencies");
const UserService = require("../services/users");
const sniesController = require("./sniesTemplates");
const {
  uploadFileToGoogleDrive,
  deleteDriveFile,
  downloadDriveFileBuffer,
} = require("../config/googleDrive");

const controller = {};

const ALLOWED_ROLES = ["Administrador", "Responsable"];
const TIPOS = ["programa", "institucion"];
const TIPO_LABEL = { programa: "Cuadros maestros programas", institucion: "Cuadros maestros institución" };
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// ── Utilidades de texto ─────────────────────────────────────────────────────

const norm = (value = "") =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const cellText = (cell) => {
  const value = cell?.isMerged ? cell.master.value : cell?.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((t) => t.text).join("");
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    return "";
  }
  return String(value);
};

const hasFormula = (cell) => {
  const value = cell?.value;
  return Boolean(value && typeof value === "object" && (value.formula || value.sharedFormula));
};

const toInt = (value) => {
  const parsed = parseInt(String(value ?? "").trim(), 10);
  return Number.isNaN(parsed) ? null : parsed;
};

const romanToSemester = (value) => {
  const text = norm(value).replace(/\s/g, "");
  if (["i", "1", "a", "01"].includes(text)) return 1;
  if (["ii", "2", "b", "02"].includes(text)) return 2;
  return null;
};

const periodKey = (year, semester) => `${year}-${semester}`;

// "2025B" / "2025-2" / "2025 II" → { year: 2025, semester: 2 }
const parsePeriodName = (name = "") => {
  const match = String(name).match(/(\d{4})\s*[-_ ]?\s*([ab12]|ii|i)?/i);
  if (!match) return { year: null, semester: null };
  return { year: Number(match[1]), semester: romanToSemester(match[2] || "") };
};

// ── Catálogos SNIES → categorías CNA ─────────────────────────────────────────

// MAX_NIVEL_ESTUDIO (SNIES) → clave de nivel usada por los cuadros CNA
const nivelSniesToKey = (code, templateHasMq) => {
  switch (toInt(code)) {
    case 1:
    case 2: return "doc";
    case 3: return "mae";
    case 4: return "esp";
    case 11: return templateHasMq ? "mq1" : "esp";
    case 7: return "pro";
    case 6:
    case 8: return "tec";
    case 5:
    case 9: return "tcp";
    default: return null; // 10 = Docente sin título u otro valor desconocido
  }
};

// Nombre de nivel en los encabezados CNA → clave de nivel
const nivelTextToKey = (text) => {
  const t = norm(text);
  if (!t) return null;
  if (t.includes("doctorado")) return "doc";
  if (t.includes("maestria")) return "mae";
  if (/^1a\.? (especialidad|esp)/.test(t)) return "mq1";
  if (/^2a\.? (especialidad|esp)/.test(t)) return "mq2";
  if (/^3a\.? (especialidad|esp)/.test(t)) return "mq3";
  if (t.includes("especializacion")) return "esp";
  if (t.includes("tecnico")) return "tcp";
  if (t.includes("tecnolog")) return "tec";
  if (t.includes("profesional")) return "pro";
  return null;
};

const NIVEL_MENU_MATCH = {
  doc: (t) => t.includes("doctorado"),
  mae: (t) => t.includes("maestria"),
  mq1: (t) => /1a\.? especialidad/.test(t),
  esp: (t) => t.includes("especializacion univ"),
  pro: (t) => t.includes("profesional univ"),
  tec: (t) => t.includes("tecnolog"),
  tcp: (t) => t.includes("tecnico"),
};

// Clasifica un docente dentro de las columnas del CUADRO 03 (Profesores Resumen).
// Devuelve la clave de columna o null + el motivo si no se pudo clasificar.
const clasificarDocente = (docente, templateHasMq) => {
  const contrato = toInt(docente.contrato);
  const dedicacion = toInt(docente.dedicacion);

  if (dedicacion === 4 || contrato === 3) return { key: "catedra" };
  if (contrato === 4) return { key: "fijo10" };
  if (contrato !== 1 && contrato !== 2) {
    return { key: null, motivo: `tipo de contrato SNIES "${docente.contrato || "vacío"}" sin equivalencia CNA` };
  }

  const nivel = nivelSniesToKey(docente.nivel, templateHasMq);
  if (!nivel) return { key: null, motivo: `nivel de formación SNIES "${docente.nivel || "vacío"}" sin equivalencia CNA` };

  const ded = dedicacion === 1 ? "tc" : dedicacion === 2 ? "mt" : null;
  if (!ded) return { key: null, motivo: `dedicación SNIES "${docente.dedicacion || "vacía"}" sin equivalencia CNA` };

  return { key: `${contrato === 1 ? "indef" : "fijo"}|${nivel}|${ded}` };
};

// ── Lectura de la información SNIES ──────────────────────────────────────────

// Reutiliza el endpoint de SNIES (sin modificar ese módulo) para obtener exactamente
// la misma información consolidada que SNIES genera para cada plantilla.
const fetchSniesConnectedData = (templateId, email) =>
  new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) {
        if (this.statusCode >= 400) {
          reject(new Error(payload?.details || payload?.error || "Error consultando SNIES"));
        } else {
          resolve(payload);
        }
        return this;
      },
    };
    sniesController
      .getConnectedData({ params: { id: String(templateId) }, query: { email } }, res)
      .catch(reject);
  });

const findHeader = (headers, candidates) =>
  headers.find((header) => candidates.includes(norm(header).replace(/[^a-z0-9]/g, "")));

// Arma, por período, el listado de docentes (uniendo DOCENTE_IES con DOCENTE_CONTRATO)
const collectDocentesByPeriod = async (sniesTemplates, email, advertencias) => {
  const byPeriod = new Map();

  for (const template of sniesTemplates) {
    let data;
    try {
      data = await fetchSniesConnectedData(template._id, email);
    } catch (error) {
      advertencias.push(`No se pudo leer la plantilla SNIES "${template.name}" (${template.period?.name || "sin período"}): ${error.message}`);
      continue;
    }

    const fallback = parsePeriodName(template.period?.name);

    for (const sheet of data.sheets || []) {
      const headers = sheet.headers || [];
      const docHeader = findHeader(headers, ["numdocumento"]);
      if (!docHeader) continue;

      const nivelHeader = findHeader(headers, ["idnivelmaxestudio"]);
      const contratoHeader = findHeader(headers, ["idtipocontrato"]);
      const dedicacionHeader = findHeader(headers, ["iddedicacion"]);
      if (!nivelHeader && !(contratoHeader && dedicacionHeader)) continue;

      const yearHeader = findHeader(headers, ["ano", "anio"]);
      const semesterHeader = findHeader(headers, ["semestre", "periodo"]);
      const tipoDocHeader = findHeader(headers, ["idtipodocumento"]);
      const tituloHeader = findHeader(headers, ["titulorecibido"]);
      const paisHeader = findHeader(headers, ["idpaisinstitucionestudio"]);

      for (const row of sheet.rows || []) {
        const documento = String(row[docHeader] ?? "").trim();
        if (!documento) continue;

        const year = toInt(yearHeader ? row[yearHeader] : null) || fallback.year;
        const semester = romanToSemester(semesterHeader ? row[semesterHeader] : "") || fallback.semester;
        if (!year || !semester) continue;

        const key = periodKey(year, semester);
        if (!byPeriod.has(key)) byPeriod.set(key, { year, semester, docentes: new Map() });
        const docentes = byPeriod.get(key).docentes;
        const docente = docentes.get(documento) || { documento };

        if (tipoDocHeader && !docente.tipoDocumento) docente.tipoDocumento = row[tipoDocHeader];
        if (nivelHeader && !docente.nivel) docente.nivel = row[nivelHeader];
        if (tituloHeader && !docente.titulo) docente.titulo = row[tituloHeader];
        if (paisHeader && !docente.pais) docente.pais = row[paisHeader];
        if (contratoHeader && !docente.contrato) docente.contrato = row[contratoHeader];
        if (dedicacionHeader && !docente.dedicacion) docente.dedicacion = row[dedicacionHeader];

        docentes.set(documento, docente);
      }
    }
  }

  return byPeriod;
};

// ── Histórico Docentes (módulo Consulta de Información) ──────────────────────
//
// Archivo "DOCENTE HISTÓRICO_SNIES_2014_20XX" con hojas SNIES_Contrato y
// SNIES_Estudio (una fila por docente y semestre). Sus valores vienen como
// "2 - Término Fijo", por eso toInt() toma el código del inicio.

const HISTORICO_CAMPOS = {
  contrato: {
    documento: ["documento"],
    nombre: ["nombre identificado"],
    dependencia: ["programa o dependencia"],
    contrato: ["tipo contrato"],
    dedicacion: ["dedicacion"],
  },
  estudio: {
    documento: ["documento"],
    nombre: ["nombre identificado"],
    nivel: ["max nivel formacion"],
    titulo: ["titulo recibido"],
    pais: ["pais estudio"],
  },
};

const indicesHistorico = (headers, campos) => {
  const normalized = headers.map((header) => norm(header));
  const indices = { year: normalized.indexOf("ano"), semester: normalized.indexOf("semestre") };
  Object.entries(campos).forEach(([campo, nombres]) => {
    indices[campo] = normalized.findIndex((header) => nombres.includes(header));
  });
  return indices;
};

// Devuelve { byPeriod, nombres, archivos } a partir de los archivos de histórico docentes
const collectDocentesFromHistorico = async () => {
  const archivos = await HistoricoDocentes.find({ active: { $ne: false }, file_type: "excel" })
    .select("file_name sheets createdAt")
    .sort({ createdAt: 1 }) // los más recientes sobrescriben a los anteriores
    .lean();

  const byPeriod = new Map();
  const nombres = new Map();
  const usados = [];

  archivos.forEach((archivo) => {
    let usado = false;
    (archivo.sheets || []).forEach((sheet) => {
      const headers = sheet.headers || [];
      const tipo = headers.some((h) => norm(h) === "tipo contrato")
        ? "contrato"
        : headers.some((h) => norm(h) === "max nivel formacion")
          ? "estudio"
          : null;
      if (!tipo) return;
      const idx = indicesHistorico(headers, HISTORICO_CAMPOS[tipo]);
      if (idx.year < 0 || idx.semester < 0 || idx.documento < 0) return;
      usado = true;

      (sheet.rows || []).forEach((row) => {
        const get = (campo) => (idx[campo] >= 0 && Array.isArray(row) ? row[idx[campo]] : row?.[headers[idx[campo]]]);
        const documento = String(get("documento") ?? "").trim();
        const year = toInt(get("year"));
        const semester = romanToSemester(get("semester"));
        if (!documento || !year || !semester) return;

        const key = periodKey(year, semester);
        if (!byPeriod.has(key)) byPeriod.set(key, { year, semester, docentes: new Map() });
        const docentes = byPeriod.get(key).docentes;
        const docente = docentes.get(documento) || { documento };
        Object.keys(HISTORICO_CAMPOS[tipo]).forEach((campo) => {
          const value = get(campo);
          if (campo !== "documento" && value !== undefined && value !== null && String(value).trim() !== "") {
            docente[campo] = value;
          }
        });
        docentes.set(documento, docente);

        const nombre = String(get("nombre") ?? "").trim();
        if (nombre && norm(nombre) !== "no identificado") nombres.set(documento, nombre);
      });
    });
    if (usado) usados.push(archivo.file_name);
  });

  return { byPeriod, nombres, archivos: usados };
};

// Completa la información SNIES de Miró con el histórico:
//  - períodos que no están en SNIES → se toman completos del histórico
//  - períodos que sí están → solo se llenan los campos que SNIES dejó vacíos
const mergeHistoricoDocentes = (byPeriod, historico) => {
  const periodosCompletados = [];
  historico.byPeriod.forEach((periodoHistorico, key) => {
    const actual = byPeriod.get(key);
    if (!actual || actual.docentes.size === 0) {
      byPeriod.set(key, periodoHistorico);
      periodosCompletados.push(`${periodoHistorico.year}-${periodoHistorico.semester === 1 ? "I" : "II"}`);
      return;
    }
    let completo = false;
    actual.docentes.forEach((docente, documento) => {
      const origen = periodoHistorico.docentes.get(documento);
      if (!origen) return;
      ["nivel", "titulo", "pais", "contrato", "dedicacion", "dependencia"].forEach((campo) => {
        if (!String(docente[campo] ?? "").trim() && String(origen[campo] ?? "").trim()) {
          docente[campo] = origen[campo];
          completo = true;
        }
      });
    });
    if (completo) periodosCompletados.push(`${actual.year}-${actual.semester === 1 ? "I" : "II"} (campos faltantes)`);
  });
  return periodosCompletados;
};

// Integra: cédula → { full_name, dep_code }
const getIntegraUsersByIdentification = async (advertencias) => {
  if (!process.env.USERS_ENDPOINT) {
    advertencias.push("No está configurado USERS_ENDPOINT: no se pudieron completar nombres ni dependencias de los profesores.");
    return null;
  }
  try {
    const response = await axios.get(process.env.USERS_ENDPOINT, { timeout: 20000 });
    const users = Array.isArray(response.data) ? response.data : [];
    return users.reduce((acc, user) => {
      if (user?.identification) acc.set(String(user.identification).trim(), user);
      return acc;
    }, new Map());
  } catch (error) {
    advertencias.push(`No se pudo consultar Integra para nombres y dependencias: ${error.message}`);
    return null;
  }
};

// Dependencia seleccionada + todas sus dependencias hijas
const getDependencyTree = async (depCode) => {
  const all = await Dependency.find({}).select("dep_code dep_father name").lean();
  const codes = new Set([depCode]);
  let added = true;
  while (added) {
    added = false;
    all.forEach((dep) => {
      if (dep.dep_father && codes.has(dep.dep_father) && !codes.has(dep.dep_code)) {
        codes.add(dep.dep_code);
        added = true;
      }
    });
  }
  return codes;
};

// ── Escritura en el Excel CNA ────────────────────────────────────────────────

// Busca en una hoja los bloques "Año | Período académico" y devuelve,
// por cada bloque, las filas de datos (año/semestre).
const findPeriodBlocks = (worksheet) => {
  const blocks = [];
  const maxRow = Math.min(worksheet.rowCount, 40);

  for (let r = 1; r <= maxRow; r += 1) {
    const row = worksheet.getRow(r);
    for (let c = 1; c < Math.min(worksheet.columnCount, 60); c += 1) {
      if (norm(cellText(row.getCell(c))) !== "ano") continue;
      if (!norm(cellText(row.getCell(c + 1))).startsWith("periodo")) continue;
      if (row.getCell(c).isMerged && row.getCell(c).master.address !== row.getCell(c).address) continue;

      const dataRows = [];
      let currentYear = null;
      for (let dr = r + 1; dr <= worksheet.rowCount && dr <= r + 80; dr += 1) {
        const semester = romanToSemester(cellText(worksheet.getRow(dr).getCell(c + 1)));
        if (!semester) {
          if (dataRows.length) break;
          continue;
        }
        const yearCell = worksheet.getRow(dr).getCell(c);
        const yearValue = toInt(cellText(yearCell));
        const labelCell = yearCell.isMerged ? yearCell.master : yearCell;
        if (yearValue) currentYear = yearValue;
        dataRows.push({ rowNumber: dr, year: currentYear, semester, yearLabelCell: yearValue ? labelCell : null });
      }
      if (dataRows.length) blocks.push({ headerRow: r, yearCol: c, periodCol: c + 1, dataRows });
    }
  }
  return blocks;
};

// Si los períodos de SNIES no caben en los años que trae la plantilla, se
// corre la ventana de años para que termine en el último año reportado
// (la plantilla indica "incluya y renombre las filas que sean necesarias").
const alignYearWindow = (worksheet, maxYear) => {
  findPeriodBlocks(worksheet).forEach((block) => {
    const labels = block.dataRows.filter((row) => row.yearLabelCell);
    if (!labels.length) return;
    const lastYear = labels[labels.length - 1].year;
    if (lastYear >= maxYear) return;
    const offset = maxYear - lastYear;
    labels.forEach((row) => {
      row.yearLabelCell.value = row.year + offset;
    });
  });
};

const findWorksheet = (workbook, pattern) =>
  workbook.worksheets.find((ws) => pattern.test(norm(ws.name)));

const fillProfesoresResumen = (workbook, byPeriod, advertencias) => {
  const worksheet = findWorksheet(workbook, /profesores res/);
  if (!worksheet) {
    advertencias.push("La plantilla no tiene la hoja \"Profesores Resúmen\".");
    return;
  }

  const [block] = findPeriodBlocks(worksheet);
  if (!block) {
    advertencias.push("No se encontraron las filas Año / Período en \"Profesores Resúmen\".");
    return;
  }

  // Columnas contables: encabezado de grupo (fila Año), nivel (+1) y dedicación (+2)
  const h = block.headerRow;
  const firstDataRow = block.dataRows[0].rowNumber;
  const columns = [];
  let templateHasMq = false;

  for (let c = block.periodCol + 1; c <= worksheet.columnCount; c += 1) {
    if (hasFormula(worksheet.getRow(firstDataRow).getCell(c))) continue;
    const group = norm(cellText(worksheet.getRow(h).getCell(c)));
    const nivelText = cellText(worksheet.getRow(h + 1).getCell(c));
    const ded = norm(cellText(worksheet.getRow(h + 2).getCell(c)));
    if (!group) continue;

    let key = null;
    const nivel = nivelTextToKey(nivelText);
    if (nivel === "mq1") templateHasMq = true;

    if ((ded === "tc" || ded === "mt") && nivel && group.includes("maximo nivel")) {
      if (group.includes("termino indefinido")) key = `indef|${nivel}|${ded}`;
      else if (group.includes("fijo de 11")) key = `fijo|${nivel}|${ded}`;
    } else if (group.includes("10 meses o menos")) {
      key = "fijo10";
    } else if (group.includes("hora catedra")) {
      key = "catedra";
    } else if (group.includes("tiempo parcial")) {
      key = "parcial";
    }

    if (key) columns.push({ col: c, key });
  }

  block.dataRows.forEach(({ rowNumber, year, semester }) => {
    const period = byPeriod.get(periodKey(year, semester));
    if (!period || period.docentes.size === 0) return;
    const periodLabel = `${year}-${semester === 1 ? "I" : "II"}`;

    const counts = {};
    const sinClasificar = {};
    let clasificados = 0;
    period.docentes.forEach((docente) => {
      const { key, motivo } = clasificarDocente(docente, templateHasMq);
      if (key) {
        counts[key] = (counts[key] || 0) + 1;
        clasificados += 1;
      } else {
        sinClasificar[motivo] = (sinClasificar[motivo] || 0) + 1;
      }
    });

    // Si algún docente del período no se pudo clasificar, la fila queda vacía:
    // unos conteos parciales parecerían un total real en el cuadro CNA.
    if (clasificados < period.docentes.size) {
      Object.entries(sinClasificar).forEach(([motivo, total]) => {
        advertencias.push(
          `Profesores Resúmen ${periodLabel}: fila sin diligenciar porque ${total} de ${period.docentes.size} docente(s) tienen ${motivo}.`
        );
      });
      return;
    }

    const row = worksheet.getRow(rowNumber);
    columns.forEach(({ col, key }) => {
      row.getCell(col).value = counts[key] || 0;
    });
    row.commit();
  });
};

const getMenuOptions = (workbook) => {
  const menu = findWorksheet(workbook, /^menu$/);
  const options = { nivel: [], contrato: [], dedicacion: [] };
  if (!menu) return options;

  const header = menu.getRow(1);
  for (let c = 1; c <= menu.columnCount; c += 1) {
    const title = norm(cellText(header.getCell(c)));
    let target = null;
    if (title.startsWith("nivel de formacion") && !title.includes("programa")) target = "nivel";
    else if (title.startsWith("tipo de contratacion")) target = "contrato";
    else if (title.startsWith("tipo de dedicacion")) target = "dedicacion";
    if (!target || options[target].length) continue;

    for (let r = 2; r <= Math.min(menu.rowCount, 50); r += 1) {
      const text = cellText(menu.getRow(r).getCell(c)).trim();
      if (text) options[target].push(text);
    }
  }
  return options;
};

const pickOption = (options, matcher) => options.find((option) => matcher(norm(option))) || "";

const contratoMenuValue = (options, docente) => {
  const contrato = toInt(docente.contrato);
  if (contrato === 1) return pickOption(options, (t) => t.includes("indefinido"));
  if (contrato === 2) return pickOption(options, (t) => t.includes("fijo") && t.includes(">"));
  if (contrato === 3) {
    return pickOption(options, (t) => t.includes("catedra")) ||
      pickOption(options, (t) => t.includes("fijo") && t.includes("<"));
  }
  if (contrato === 4) return pickOption(options, (t) => t.includes("fijo") && t.includes("<"));
  return "";
};

const dedicacionMenuValue = (options, docente) => {
  const dedicacion = toInt(docente.dedicacion);
  if (dedicacion === 1) return pickOption(options, (t) => t.includes("tiempo completo"));
  if (dedicacion === 2) return pickOption(options, (t) => t.includes("medio tiempo"));
  if (dedicacion === 4) return pickOption(options, (t) => t.includes("catedra"));
  return "";
};

// SNIES reporta el país a veces en ISO alfa-2 ("CO") y a veces en ISO numérico ("170")
const ISO_NUMERIC_TO_ALPHA2 = {
  32: "AR", 36: "AU", 40: "AT", 56: "BE", 68: "BO", 76: "BR", 124: "CA", 152: "CL",
  156: "CN", 170: "CO", 188: "CR", 192: "CU", 203: "CZ", 208: "DK", 214: "DO", 218: "EC",
  222: "SV", 246: "FI", 250: "FR", 276: "DE", 300: "GR", 320: "GT", 340: "HN", 348: "HU",
  356: "IN", 372: "IE", 376: "IL", 380: "IT", 392: "JP", 410: "KR", 484: "MX", 528: "NL",
  554: "NZ", 558: "NI", 578: "NO", 591: "PA", 600: "PY", 604: "PE", 616: "PL", 620: "PT",
  630: "PR", 643: "RU", 710: "ZA", 724: "ES", 752: "SE", 756: "CH", 792: "TR",
  826: "GB", 840: "US", 858: "UY", 862: "VE",
};

const countryName = (() => {
  let display = null;
  try {
    display = new Intl.DisplayNames(["es"], { type: "region" });
  } catch (_) {
    display = null;
  }
  return (code) => {
    let value = String(code ?? "").trim().toUpperCase();
    if (!value) return "";
    // Histórico: "170 - Colombia" → 170
    const leading = value.match(/^(\d+)\s*-/);
    if (leading) value = leading[1];
    if (/^\d+$/.test(value)) value = ISO_NUMERIC_TO_ALPHA2[Number(value)] || value;
    if (display && /^[A-Z]{2}$/.test(value)) {
      try {
        return display.of(value) || value;
      } catch (_) {
        return value;
      }
    }
    return value;
  };
})();

const fillProfesoresDetallado = (workbook, period, integraUsers, nombresHistorico, dependencyNames, advertencias) => {
  const worksheet = findWorksheet(workbook, /profesores detallado/);
  if (!worksheet) {
    advertencias.push("La plantilla no tiene la hoja \"Profesores Detallado\".");
    return;
  }

  let headerRow = null;
  for (let r = 1; r <= 20 && !headerRow; r += 1) {
    const row = worksheet.getRow(r);
    for (let c = 1; c <= worksheet.columnCount; c += 1) {
      if (norm(cellText(row.getCell(c))).startsWith("cedula")) {
        headerRow = r;
        break;
      }
    }
  }
  if (!headerRow) {
    advertencias.push("No se encontró el encabezado \"Cédula / identificación\" en \"Profesores Detallado\".");
    return;
  }

  const cols = {};
  const header = worksheet.getRow(headerRow);
  for (let c = 1; c <= worksheet.columnCount; c += 1) {
    const title = norm(cellText(header.getCell(c)));
    if (!title) continue;
    if (title === "n°" || title === "no." || title === "n") cols.numero ??= c;
    else if (title.startsWith("cedula")) cols.documento ??= c;
    else if (title.startsWith("nombres y apellidos")) cols.nombre ??= c;
    else if (title.startsWith("nivel maximo de formacion")) cols.nivel ??= c;
    else if (title.startsWith("titulo obtenido en nivel maximo")) cols.titulo ??= c;
    else if (title.startsWith("pais de obtencion")) cols.pais ??= c;
    else if (title.startsWith("facultad/departamento")) cols.dependencia ??= c;
    else if (title.startsWith("tipo de contratacion")) cols.contrato ??= c;
    else if (title.startsWith("tipo de dedicacion")) cols.dedicacion ??= c;
  }

  const menu = getMenuOptions(workbook);
  const templateHasMq = menu.nivel.some((option) => NIVEL_MENU_MATCH.mq1(norm(option)));
  // Nombre: Integra y, si no está allí, el del Histórico Docentes
  const nombreDe = (documento) =>
    integraUsers?.get(documento)?.full_name || nombresHistorico?.get(documento) || "";
  const docentes = [...period.docentes.values()].sort((a, b) =>
    nombreDe(a.documento).localeCompare(nombreDe(b.documento), "es")
  );

  let sinNombre = 0;
  docentes.forEach((docente, index) => {
    const row = worksheet.getRow(headerRow + 1 + index);
    const integra = integraUsers?.get(docente.documento);
    const nombre = nombreDe(docente.documento);
    const nivelKey = nivelSniesToKey(docente.nivel, templateHasMq);
    const set = (col, value) => {
      if (!col) return;
      const cell = row.getCell(col);
      if (hasFormula(cell)) return;
      cell.value = value === undefined || value === null ? "" : value;
    };

    if (!nombre) sinNombre += 1;

    set(cols.numero, index + 1);
    set(cols.documento, /^\d+$/.test(docente.documento) ? Number(docente.documento) : docente.documento);
    set(cols.nombre, nombre);
    set(cols.nivel, nivelKey ? pickOption(menu.nivel, NIVEL_MENU_MATCH[nivelKey]) : "");
    set(cols.titulo, docente.titulo || "");
    set(cols.pais, countryName(docente.pais));
    set(
      cols.dependencia,
      (integra?.dep_code ? dependencyNames.get(String(integra.dep_code)) : "") || docente.dependencia || ""
    );
    set(cols.contrato, contratoMenuValue(menu.contrato, docente));
    set(cols.dedicacion, dedicacionMenuValue(menu.dedicacion, docente));
    row.commit();
  });

  if (sinNombre > 0) {
    advertencias.push(`Profesores Detallado: ${sinNombre} profesor(es) no se encontraron en Integra ni en el Histórico Docentes, quedan sin nombre.`);
  }
};

// ── CUADRO 02. ESTUDIANTES ───────────────────────────────────────────────────
//
// Fuente: plantillas SNIES publicadas (con información cargada por los productores).
// PRO_CONSECUTIVO = código SNIES del programa → se cruza con `programs.codigo_snies`
// para saber si el estudiante es de pregrado o posgrado.

const LUGAR_CAMPUS_DEFECTO = "Universidad de Ibagué";

const compactName = (value = "") => norm(value).replace(/[^a-z0-9]/g, "");

// Plantilla SNIES publicada (nombre compacto) → columna del CUADRO 02
const FUENTES_ESTUDIANTES = {
  inscritos: { nombres: ["inscritoprograma"], label: "Inscrito_programa" },
  admitidos: { nombres: ["admitidos"], label: "Admitidos" },
  matriculados: { nombres: ["matriculados"], label: "Matriculados" },
  primerCurso: { nombres: ["estudiantesdeprimercurso"], label: "Estudiantes_de_primer_curso" },
  graduados: { nombres: ["graduados"], label: "Graduados" },
};

const fuenteDePlantilla = (templateName) =>
  Object.keys(FUENTES_ESTUDIANTES).find((fuente) =>
    FUENTES_ESTUDIANTES[fuente].nombres.includes(compactName(templateName))
  ) || null;

// Reconstruye las filas cargadas por los productores en una plantilla publicada
const getPublishedRows = (publishedTemplate) => {
  const rows = [];
  (publishedTemplate.loaded_data || []).forEach((loaded) => {
    const records = [];
    (loaded.filled_data || []).forEach((field) => {
      const key = compactName(field.field_name);
      (field.values || []).forEach((value, index) => {
        if (!records[index]) records[index] = {};
        records[index][key] = value;
      });
    });
    rows.push(...records.filter(Boolean));
  });
  return rows;
};

// Cuenta estudiantes por período, fuente y programa (documento + programa únicos)
const collectEstudiantesByPeriod = async (periodIds) => {
  const query = { "template.is_snies": true };
  if (periodIds.length) query.period = { $in: periodIds };
  const published = await PublishedTemplate.find(query)
    .select("name period loaded_data")
    .populate("period", "name")
    .lean();

  // clave período → { year, semester, fuentes: { fuente → Map(programa → Set(documentos)) } }
  const byPeriod = new Map();

  published.forEach((template) => {
    const fuente = fuenteDePlantilla(template.name);
    if (!fuente) return;
    const fallback = parsePeriodName(template.period?.name);

    getPublishedRows(template).forEach((row) => {
      const documento = String(row.numdocumento ?? "").trim();
      const programa = String(row.proconsecutivo ?? "").trim();
      if (!documento || !programa) return;

      const year = toInt(row.ano ?? row.anio) || fallback.year;
      const semester = romanToSemester(row.semestre) || fallback.semester;
      if (!year || !semester) return;

      const key = periodKey(year, semester);
      if (!byPeriod.has(key)) byPeriod.set(key, { year, semester, fuentes: {} });
      const period = byPeriod.get(key);
      if (!period.fuentes[fuente]) period.fuentes[fuente] = new Map();
      const porPrograma = period.fuentes[fuente];
      if (!porPrograma.has(programa)) porPrograma.set(programa, new Set());
      porPrograma.get(programa).add(documento);
    });
  });

  return byPeriod;
};

// Suma los estudiantes de una fuente cuyos programas cumplen el filtro
const contarEstudiantes = (porPrograma, incluirPrograma) => {
  let total = 0;
  porPrograma.forEach((documentos, programa) => {
    if (incluirPrograma(programa)) total += documentos.size;
  });
  return total;
};

// Número de campus del bloque según su rótulo "Lugar del campus N" (null si no tiene)
const campusDelBloque = (worksheet, block) => {
  for (let r = Math.max(1, block.headerRow - 3); r < block.headerRow; r += 1) {
    const text = norm(cellText(worksheet.getRow(r).getCell(block.yearCol)));
    const match = text.match(/^lugar del campus\s*(\d+)?/);
    if (match) return match[1] ? Number(match[1]) : 1;
  }
  return null;
};

// Escribe el valor por defecto al lado del rótulo "Lugar del campus 1"
const fillLugarCampus = (worksheet, block) => {
  for (let r = Math.max(1, block.headerRow - 3); r < block.headerRow; r += 1) {
    const row = worksheet.getRow(r);
    const label = row.getCell(block.yearCol);
    if (!norm(cellText(label)).startsWith("lugar del campus")) continue;

    const labelMaster = label.isMerged ? label.master.address : label.address;
    let c = block.yearCol + 1;
    while (c <= worksheet.columnCount) {
      const cell = row.getCell(c);
      if (!(cell.isMerged && cell.master.address === labelMaster)) break;
      c += 1;
    }
    const target = row.getCell(c);
    const targetCell = target.isMerged ? target.master : target;
    if (!hasFormula(targetCell)) targetCell.value = LUGAR_CAMPUS_DEFECTO;
    return;
  }
};

// Nivel del bloque (pregrado / posgrado) según el título que tiene encima
const nivelDelBloque = (worksheet, block) => {
  for (let r = block.headerRow - 1; r >= Math.max(1, block.headerRow - 5); r -= 1) {
    const text = norm(cellText(worksheet.getRow(r).getCell(block.yearCol)));
    if (text.includes("posgrado")) return "Posgrado";
    if (text.includes("pregrado")) return "Pregrado";
  }
  return null;
};

// Columnas del bloque: Inscritos, Admitidos, Matriculados totales, primer curso y graduados
const columnasEstudiantes = (worksheet, block, blockEnd) => {
  const header = worksheet.getRow(block.headerRow);
  const subHeader = worksheet.getRow(block.headerRow + 1);
  const cols = {};
  const lastCol = Math.min(worksheet.columnCount, blockEnd);

  // "# total de graduados": en la plantilla de programa está en la fila de
  // encabezado; en la institucional, una fila arriba (junto a "Lugar del campus").
  for (let c = block.periodCol + 1; c <= lastCol && !cols.graduados; c += 1) {
    for (const r of [block.headerRow, block.headerRow - 1]) {
      const cell = worksheet.getRow(r).getCell(c);
      if (cell.isMerged && cell.master.address !== cell.address) continue;
      if (norm(cellText(cell)).includes("total de graduados")) {
        cols.graduados = c;
        break;
      }
    }
  }

  for (let c = block.periodCol + 1; c <= lastCol; c += 1) {
    const cell = header.getCell(c);
    if (cell.isMerged && cell.master.address !== cell.address) continue;
    const title = norm(cellText(cell));
    if (!cols.inscritos && title.includes("inscritos")) cols.inscritos = c;
    else if (!cols.admitidos && title.includes("admitidos")) cols.admitidos = c;
    // Si en el bloque aparece otro "Año", ya empezó el bloque siguiente
    if (c > block.periodCol + 1 && title === "ano") break;
  }
  // En el bloque de posgrado de la plantilla institucional el rótulo de
  // Admitidos viene dañado ("2"), pero siempre es la columna siguiente.
  if (cols.inscritos && !cols.admitidos) cols.admitidos = cols.inscritos + 1;

  for (let c = block.periodCol + 1; c <= lastCol; c += 1) {
    const title = norm(cellText(subHeader.getCell(c)));
    if (!cols.matriculados && title === "totales") cols.matriculados = c;
    else if (!cols.primerCurso && title === "primer curso") cols.primerCurso = c;
  }
  return cols;
};

const fillEstudiantes = (workbook, estudiantesByPeriod, filtro, advertencias) => {
  const worksheet = findWorksheet(workbook, /^\d*\.?\s*estudiantes$/);
  if (!worksheet) {
    advertencias.push("La plantilla no tiene la hoja \"Estudiantes\".");
    return false;
  }

  const blocks = findPeriodBlocks(worksheet);
  if (!blocks.length) {
    advertencias.push("No se encontraron las filas Año / Período en \"Estudiantes\".");
    return false;
  }

  let escribio = false;
  const faltantes = new Set();

  blocks.forEach((block) => {
    // La Universidad tiene un solo campus: los bloques "Lugar del campus 2, 3…"
    // se dejan tal como vienen en la plantilla.
    const campus = campusDelBloque(worksheet, block);
    if (campus !== null && campus !== 1) return;
    fillLugarCampus(worksheet, block);

    const nivel = nivelDelBloque(worksheet, block);
    const incluirPrograma = filtro.programa
      ? (programa) => programa === filtro.programa
      : (programa) => !nivel || filtro.nivelPorPrograma.get(programa) === nivel;
    // Las cifras oficiales de Población estudiantil son totales institucionales:
    // solo aplican en la plantilla institucional, bloque de pregrado.
    const usaOficial = !filtro.programa && nivel !== "Posgrado";
    // El bloque termina donde empieza el siguiente bloque de la misma fila (pregrado | posgrado)
    const siguiente = blocks
      .filter((otro) => otro.headerRow === block.headerRow && otro.yearCol > block.yearCol)
      .sort((a, b) => a.yearCol - b.yearCol)[0];
    const blockEnd = siguiente ? siguiente.yearCol - 1 : block.periodCol + 14;
    const cols = columnasEstudiantes(worksheet, block, blockEnd);

    block.dataRows.forEach(({ rowNumber, year, semester }) => {
      const period = estudiantesByPeriod.get(periodKey(year, semester));
      if (!period) return;
      const row = worksheet.getRow(rowNumber);
      const periodLabel = `${year}-${semester === 1 ? "I" : "II"}`;

      Object.keys(FUENTES_ESTUDIANTES).forEach((fuente) => {
        const col = cols[fuente];
        if (!col) return;
        const cell = row.getCell(col);
        if (hasFormula(cell)) return;

        const porPrograma = period.fuentes[fuente];
        if (porPrograma) {
          cell.value = contarEstudiantes(porPrograma, incluirPrograma);
          escribio = true;
        } else if (usaOficial && period.oficial?.[fuente] != null) {
          cell.value = period.oficial[fuente];
          escribio = true;
        } else if (!period.oficial || usaOficial) {
          faltantes.add(`${periodLabel}: ${FUENTES_ESTUDIANTES[fuente].label}`);
        }
      });
      row.commit();
    });
  });

  if (faltantes.size) {
    advertencias.push(`Estudiantes: sin información SNIES cargada para ${[...faltantes].join(", ")}; esas celdas quedan vacías.`);
  }
  return escribio;
};

// ── Endpoints ────────────────────────────────────────────────────────────────

controller.getPlantillas = async (req, res) => {
  try {
    await UserService.findUserByEmailAndRoles(req.query.email, ALLOWED_ROLES);
    const plantillas = await CnaPlantilla.find({}).lean();
    return res.status(200).json(
      TIPOS.map((tipo) => ({
        tipo,
        label: TIPO_LABEL[tipo],
        plantilla: plantillas.find((p) => p.tipo === tipo) || null,
      }))
    );
  } catch (error) {
    console.error("[CNA] Error listando plantillas:", error);
    return res.status(500).json({ error: error.message });
  }
};

controller.getOpciones = async (req, res) => {
  try {
    await UserService.findUserByEmailAndRoles(req.query.email, ALLOWED_ROLES);

    // Períodos con información SNIES: plantillas SNIES configuradas (docentes)
    // y plantillas SNIES publicadas que alimentan el cuadro de estudiantes.
    const [sniesTemplates, publicadas] = await Promise.all([
      SniesTemplate.find({ period: { $ne: null } }).select("name period").populate("period", "name").lean(),
      PublishedTemplate.find({ "template.is_snies": true, "loaded_data.0": { $exists: true } })
        .select("name period")
        .populate("period", "name")
        .lean(),
    ]);

    const periodMap = new Map();
    const addFuente = (period, nombre) => {
      if (!period?._id) return;
      const id = String(period._id);
      if (!periodMap.has(id)) periodMap.set(id, { _id: id, name: period.name, fuentes: [] });
      periodMap.get(id).fuentes.push(nombre);
    };
    sniesTemplates.forEach((template) => addFuente(template.period, template.name));
    publicadas
      .filter((template) => fuenteDePlantilla(template.name))
      .forEach((template) => addFuente(template.period, template.name));

    const periodos = [...periodMap.values()].sort((a, b) => String(b.name).localeCompare(String(a.name)));
    const [dependencias, programas] = await Promise.all([
      Dependency.find({}).select("dep_code name").sort({ name: 1 }).lean(),
      Program.find({ codigo_snies: { $nin: [null, ""] } })
        .select("nombre codigo_snies nivel_academico")
        .sort({ nombre: 1 })
        .lean(),
    ]);

    return res.status(200).json({
      periodos,
      dependencias: dependencias.map((dep) => ({ value: dep.dep_code, label: dep.name })),
      programas: programas.map((programa) => ({
        value: String(programa.codigo_snies),
        label: `${programa.nombre} (SNIES ${programa.codigo_snies}${programa.nivel_academico ? ` · ${programa.nivel_academico}` : ""})`,
      })),
    });
  } catch (error) {
    console.error("[CNA] Error consultando opciones:", error);
    return res.status(500).json({ error: error.message });
  }
};

controller.uploadPlantilla = async (req, res) => {
  const file = req.file;
  try {
    const { email, tipo } = req.body;
    await UserService.findUserByEmailAndRoles(email, ALLOWED_ROLES);

    if (!TIPOS.includes(tipo)) {
      return res.status(400).json({ error: "El tipo debe ser 'programa' o 'institucion'." });
    }
    if (!file) {
      return res.status(400).json({ error: "Debes adjuntar el archivo Excel." });
    }
    if (path.extname(file.originalname).toLowerCase() !== ".xlsx") {
      return res.status(400).json({ error: "La plantilla debe estar en formato .xlsx (Excel 2007 o superior)." });
    }

    // Validar que el archivo se puede abrir antes de subirlo
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(file.path);
    if (!findWorksheet(workbook, /profesores res/) && !findWorksheet(workbook, /profesores detallado/)) {
      return res.status(400).json({
        error: "El archivo no parece una plantilla de Cuadros Maestros CNA (no tiene hojas de Profesores).",
      });
    }

    const uploaded = await uploadFileToGoogleDrive(
      { ...file, mimetype: XLSX_MIME },
      "Formatos/Plantillas/CNA",
      file.originalname
    );

    const previous = await CnaPlantilla.findOne({ tipo });
    const plantilla = await CnaPlantilla.findOneAndUpdate(
      { tipo },
      {
        tipo,
        file_name: Buffer.from(file.originalname, "latin1").toString("utf8"),
        drive_file_id: uploaded.id,
        drive_file_link: uploaded.webViewLink || "",
        uploaded_by: email,
      },
      { upsert: true, new: true }
    );

    if (previous?.drive_file_id && previous.drive_file_id !== uploaded.id) {
      await deleteDriveFile(previous.drive_file_id);
    }

    return res.status(200).json(plantilla);
  } catch (error) {
    console.error("[CNA] Error subiendo plantilla:", error);
    return res.status(500).json({ error: error.message });
  } finally {
    if (file?.path) fs.unlink(file.path, () => {});
  }
};

controller.downloadPlantilla = async (req, res) => {
  try {
    await UserService.findUserByEmailAndRoles(req.query.email, ALLOWED_ROLES);
    const plantilla = await CnaPlantilla.findById(req.params.id).lean();
    if (!plantilla) return res.status(404).json({ error: "Plantilla no encontrada" });

    const buffer = await downloadDriveFileBuffer(plantilla.drive_file_id);
    res.setHeader("Content-Type", XLSX_MIME);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="plantilla.xlsx"; filename*=UTF-8''${encodeURIComponent(plantilla.file_name)}`
    );
    return res.send(buffer);
  } catch (error) {
    console.error("[CNA] Error descargando plantilla:", error);
    return res.status(500).json({ error: error.message });
  }
};

controller.deletePlantilla = async (req, res) => {
  try {
    await UserService.findUserByEmailAndRoles(req.query.email, ["Administrador"]);
    const plantilla = await CnaPlantilla.findByIdAndDelete(req.params.id);
    if (!plantilla) return res.status(404).json({ error: "Plantilla no encontrada" });
    await deleteDriveFile(plantilla.drive_file_id);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("[CNA] Error eliminando plantilla:", error);
    return res.status(500).json({ error: error.message });
  }
};

// Genera la plantilla CNA diligenciada con la información SNIES de los períodos elegidos
controller.generarPlantilla = async (req, res) => {
  try {
    const { email, periodIds = [], depCode = "", programaSnies = "", usarHistorico = true } = req.body || {};
    await UserService.findUserByEmailAndRoles(email, ALLOWED_ROLES);

    const plantilla = await CnaPlantilla.findById(req.params.id).lean();
    if (!plantilla) return res.status(404).json({ error: "Plantilla no encontrada" });

    const selectedPeriods = Array.isArray(periodIds) ? periodIds : [];
    const sniesQuery = { period: { $ne: null } };
    if (selectedPeriods.length) sniesQuery.period = { $in: selectedPeriods };
    const sniesTemplates = await SniesTemplate.find(sniesQuery)
      .select("name period")
      .populate("period", "name")
      .lean();

    const advertencias = [];
    const notas = [];
    const byPeriod = await collectDocentesByPeriod(sniesTemplates, email, advertencias);

    // Histórico Docentes (Consulta de Información): completa lo que SNIES no trae
    let nombresHistorico = null;
    if (usarHistorico !== false) {
      const historico = await collectDocentesFromHistorico();
      nombresHistorico = historico.nombres;
      const completados = mergeHistoricoDocentes(byPeriod, historico);
      if (historico.archivos.length && completados.length) {
        const completos = completados.filter((p) => !p.includes("("));
        const parciales = completados.filter((p) => p.includes("(")).map((p) => p.replace(/ \(.*\)$/, ""));
        const partes = [];
        if (completos.length) partes.push(`períodos ${completos[0]} a ${completos[completos.length - 1]}`);
        if (parciales.length) partes.push(`datos faltantes de SNIES en ${parciales.join(", ")}`);
        notas.push(`Profesores completados con el Histórico Docentes de Consulta de Información: ${partes.join("; ")}.`);
      }
    }

    // CUADRO 02: estudiantes desde las plantillas SNIES publicadas
    const estudiantesByPeriod = await collectEstudiantesByPeriod(selectedPeriods);

    // Población estudiantil (Consulta de Información): cifras oficiales de
    // Admisiones y Registro para los períodos que no tienen plantillas SNIES.
    const periodosOficiales = [];
    (await Period.find({}).select("name").lean()).forEach((periodo) => {
      const poblacion = getPoblacionEstudiantil(periodo.name);
      if (!poblacion) return;
      const { year, semester } = parsePeriodName(periodo.name);
      if (!year || !semester) return;
      const key = periodKey(year, semester);
      if (!estudiantesByPeriod.has(key)) estudiantesByPeriod.set(key, { year, semester, fuentes: {} });
      const entry = estudiantesByPeriod.get(key);
      entry.oficial = {
        inscritos: poblacion.inscritos ?? null,
        admitidos: poblacion.admitidos ?? null,
        matriculados: poblacion.total ?? null,
        primerCurso: poblacion.nuevos ?? null,
        fuente: poblacion.fuente,
      };
      // Solo se usa donde SNIES no tiene la información
      if (Object.keys(FUENTES_ESTUDIANTES).some((fuente) => !entry.fuentes[fuente])) {
        periodosOficiales.push(`${year}-${semester === 1 ? "I" : "II"}`);
      }
    });
    if (periodosOficiales.length && plantilla.tipo === "institucion") {
      notas.push(
        `Estudiantes de pregrado ${periodosOficiales.join(", ")} tomados de Población estudiantil de Consulta de Información (cifras oficiales de Admisiones y Registro, totales de la Universidad).`
      );
    }
    const programas = await Program.find({ codigo_snies: { $nin: [null, ""] } })
      .select("nombre codigo_snies nivel_academico")
      .lean();
    const nivelPorPrograma = new Map(programas.map((p) => [String(p.codigo_snies), p.nivel_academico]));

    if (!byPeriod.size && !estudiantesByPeriod.size) {
      return res.status(400).json({ error: "No hay información SNIES para los períodos seleccionados." });
    }

    const needsIntegra = byPeriod.size > 0;
    const integraUsers = needsIntegra ? await getIntegraUsersByIdentification(advertencias) : null;

    // Filtro opcional por dependencia (útil para la plantilla de programa)
    if (depCode) {
      if (!integraUsers) {
        return res.status(400).json({
          error: "No se puede filtrar por dependencia porque no fue posible consultar Integra.",
        });
      }
      const allowed = await getDependencyTree(String(depCode));
      byPeriod.forEach((period) => {
        period.docentes.forEach((docente, documento) => {
          const dep = integraUsers.get(documento)?.dep_code;
          if (!dep || !allowed.has(String(dep))) period.docentes.delete(documento);
        });
      });
    }

    const dependencyNames = new Map(
      (await Dependency.find({}).select("dep_code name").lean()).map((dep) => [String(dep.dep_code), dep.name])
    );

    const templateBuffer = await downloadDriveFileBuffer(plantilla.drive_file_id);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(templateBuffer);

    const sortPeriods = (a, b) => a.year - b.year || a.semester - b.semester;
    const periodosDocentes = [...byPeriod.values()].filter((period) => period.docentes.size > 0).sort(sortPeriods);
    const periodosEstudiantes = [...estudiantesByPeriod.values()].sort(sortPeriods);

    // La ventana de años de la plantilla termina en el último período con información
    const maxYear = Math.max(0, ...periodosDocentes.map((p) => p.year), ...periodosEstudiantes.map((p) => p.year));
    if (maxYear) workbook.worksheets.forEach((worksheet) => alignYearWindow(worksheet, maxYear));

    const hojas = [];

    // ── CUADRO 02. Estudiantes
    if (periodosEstudiantes.length) {
      let filtro = { programa: null, nivelPorPrograma };
      if (plantilla.tipo === "programa") {
        if (!programaSnies) {
          advertencias.push("Estudiantes: selecciona el programa académico para llenar el cuadro de estudiantes de esta plantilla.");
          filtro = null;
        } else {
          filtro = { programa: String(programaSnies), nivelPorPrograma };
        }
      } else {
        // En la plantilla institucional se separa pregrado / posgrado: avisar de
        // los programas reportados en SNIES que no están en el catálogo de programas.
        const sinCatalogo = new Map();
        periodosEstudiantes.forEach((period) => {
          Object.values(period.fuentes).forEach((porPrograma) => {
            porPrograma.forEach((documentos, programa) => {
              if (!nivelPorPrograma.get(programa)) {
                sinCatalogo.set(programa, (sinCatalogo.get(programa) || 0) + documentos.size);
              }
            });
          });
        });
        if (sinCatalogo.size) {
          const detalle = [...sinCatalogo.entries()].map(([codigo, total]) => `${codigo} (${total})`).join(", ");
          advertencias.push(
            `Estudiantes: ${sinCatalogo.size} código(s) SNIES de programa no están en el catálogo de programas o no tienen nivel académico, no se contaron en pregrado ni posgrado: ${detalle}.`
          );
        }
      }
      if (filtro && fillEstudiantes(workbook, estudiantesByPeriod, filtro, advertencias)) hojas.push("Estudiantes");
    } else {
      advertencias.push("Estudiantes: no hay plantillas SNIES publicadas con Inscritos, Admitidos, Matriculados o Primer curso en los períodos seleccionados.");
    }

    // ── CUADROS 03 y 04. Profesores
    if (periodosDocentes.length) {
      fillProfesoresResumen(workbook, byPeriod, advertencias);
      fillProfesoresDetallado(
        workbook,
        periodosDocentes[periodosDocentes.length - 1],
        integraUsers,
        nombresHistorico,
        dependencyNames,
        advertencias
      );
      hojas.push("Profesores Resúmen", "Profesores Detallado");
    } else {
      advertencias.push("Profesores: las plantillas SNIES de los períodos seleccionados no tienen información de docentes.");
    }

    // Resumen por período para mostrar en pantalla
    const resumenPorPeriodo = new Map();
    const detallePeriodo = (year, semester) => {
      const key = periodKey(year, semester);
      if (!resumenPorPeriodo.has(key)) {
        resumenPorPeriodo.set(key, { year, semester, periodo: `${year}-${semester === 1 ? "I" : "II"}`, detalle: [] });
      }
      return resumenPorPeriodo.get(key);
    };
    periodosEstudiantes.forEach((period) => {
      const matriculados = period.fuentes.matriculados;
      if (!matriculados) {
        if (plantilla.tipo === "institucion" && period.oficial?.matriculados != null) {
          detallePeriodo(period.year, period.semester).detalle.push(
            `${period.oficial.matriculados} matriculados (Admisiones y Registro)`
          );
        }
        return;
      }
      const incluir = plantilla.tipo === "programa"
        ? (programa) => programa === String(programaSnies)
        : () => true;
      if (plantilla.tipo === "programa" && !programaSnies) return;
      detallePeriodo(period.year, period.semester).detalle.push(`${contarEstudiantes(matriculados, incluir)} matriculados`);
    });
    // Solo los períodos que caben en la ventana de años de la plantilla
    const primerAnoVentana = Math.min(
      ...workbook.worksheets.flatMap((ws) => findPeriodBlocks(ws).map((b) => b.dataRows[0]?.year || maxYear))
        .concat(maxYear)
    );
    periodosDocentes.filter((period) => period.year >= primerAnoVentana).forEach((period) => {
      detallePeriodo(period.year, period.semester).detalle.push(`${period.docentes.size} docentes`);
    });

    const resumen = {
      periodos: [...resumenPorPeriodo.values()]
        .sort(sortPeriods)
        .map(({ periodo, detalle }) => ({ periodo, detalle })),
      hojas,
      notas,
      advertencias,
    };

    // Los totales de la plantilla son fórmulas: que Excel las recalcule al abrir
    workbook.calcProperties = { ...(workbook.calcProperties || {}), fullCalcOnLoad: true };
    const outputBuffer = await workbook.xlsx.writeBuffer();
    const fileName = `CNA_${plantilla.tipo}_${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.setHeader("Content-Type", XLSX_MIME);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, X-CNA-Resumen");
    res.setHeader("X-CNA-Resumen", encodeURIComponent(JSON.stringify(resumen)));
    return res.send(Buffer.from(outputBuffer));
  } catch (error) {
    console.error("[CNA] Error generando plantilla:", error);
    return res.status(500).json({ error: error.message });
  }
};

module.exports = controller;
