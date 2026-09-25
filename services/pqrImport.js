const ExcelJS = require('exceljs');
const { createHash } = require('node:crypto');

const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const headers = {
  nombre_solicitud: ['Solicitud', 'Nombre / descripción de la solicitud', 'nombre_solicitud'],
  fecha_radicacion: ['Fecha de radicación', 'fecha_radicacion'],
  hora: ['Hora'],
  numero_radicado: ['Número de radicado', 'N° radicado', 'numero_radicado'],
  medio_realizado: ['Que medio x cual se realizo', 'Medio / cuál', 'medio_realizado'],
  fecha_respuesta: ['Fecha de la respuesta', 'Fecha de respuesta', 'fecha_respuesta'],
  observacion_respuesta: ['Observación/Respuesta', 'observacion_respuesta'],
  enlaces_respuesta: ['Link Respuesta', 'Enlace respuesta'],
  cedula_encargado: ['Cédula del encargado', 'cedula_encargado'],
};
const aliases = new Map(Object.entries(headers).flatMap(([key, names]) => names.map(name => [normalize(name), key])));

function cellText(value) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('result' in value) return cellText(value.result);
    if (value.richText) return value.richText.map(part => part.text).join('').trim();
    if (value.formula) {
      const link = value.formula.match(/^HYPERLINK\("([^"]+)"\s*[,;]\s*"([^"]*)"\)/i);
      if (link) return link[2] || link[1];
    }
    return String(value.text ?? value.error ?? '').trim();
  }
  return String(value).trim();
}

function isoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10) : null;
}

function parseDate(value, label, warnings) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = cellText(value);
  if (!raw) return null;
  if (/^(sin rpta|sin respuesta|pendiente|n\/?a)$/i.test(raw)) return null;
  const matches = [...raw.matchAll(/\b(?:(\d{4})-(\d{1,2})-(\d{1,2})|(\d{1,2})[/-](\d{1,2})[/-](\d{4}))\b/g)];
  const dates = matches.map(m => m[1] ? isoDate(+m[1], +m[2], +m[3]) : isoDate(+m[6], +m[5], +m[4]));
  if (!dates.length || dates.some(d => !d)) {
    warnings.push(`${label}: valor no reconocido «${raw}». Se conserva en los datos originales.`);
    return null;
  }
  if (dates.length > 1) warnings.push(`${label}: hay varias fechas; se usa la más reciente y se conserva el texto original.`);
  else if (raw !== matches[0][0]) warnings.push(`${label}: fecha extraída del texto original «${raw}».`);
  return dates.sort().at(-1);
}

function parseTime(value, warnings) {
  if (value instanceof Date) return value.toISOString().slice(11, 19);
  const raw = cellText(value);
  if (!raw) return null;
  const match = raw.toLowerCase().replace(/[.\s]/g, '').match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?(am|pm)?$/);
  if (match) {
    let hour = +match[1];
    if (+match[2] < 60 && +(match[3] || 0) < 60 && (match[4] ? hour >= 1 && hour <= 12 : hour <= 23)) {
      if (match[4]) hour = hour % 12 + (match[4] === 'pm' ? 12 : 0);
      return `${String(hour).padStart(2, '0')}:${match[2]}:${match[3] || '00'}`;
    }
  }
  warnings.push(`Hora inválida «${raw}». Se conserva en los datos originales.`);
  return null;
}

function radicados(value) {
  const text = String(value ?? '').toUpperCase().trim();
  if (!text || /^(N\/?A|SIN RADICADO|PENDIENTE)$/.test(text)) return [];
  const men = text.match(/\d{4}\s*-\s*[A-Z]{2}\s*-\s*\d+/g);
  return [...new Set(men ? men.map(v => v.replace(/\s/g, '')) : [text.replace(/\s+/g, '').replace(/[.,;]+$/, '')])].sort();
}

function identity(data) {
  const ids = radicados(data.numero_radicado);
  const key = ids.length ? `radicado:${ids.join('|')}` : `solicitud:${normalize(data.nombre_solicitud)}|${data.fecha_radicacion || ''}`;
  return createHash('sha256').update(key).digest('hex');
}

async function parseWorkbook(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const rows = [];
  const ignoredSheets = [];
  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount > 5000 || sheet.columnCount > 100) throw new Error('El archivo supera el límite de 5.000 filas o 100 columnas por hoja.');
    let headerRow = 0;
    let columns = {};
    for (let n = 1; n <= Math.min(sheet.rowCount, 30); n++) {
      const found = {};
      sheet.getRow(n).eachCell((cell, col) => {
        const field = aliases.get(normalize(cellText(cell.value)));
        if (field) found[field] = col;
      });
      if (found.nombre_solicitud && found.numero_radicado) { headerRow = n; columns = found; break; }
    }
    if (!headerRow) { ignoredSheets.push(sheet.name); continue; }
    for (let n = headerRow + 1; n <= sheet.rowCount; n++) {
      const row = sheet.getRow(n);
      const values = Object.fromEntries(Object.entries(columns).map(([field, col]) => [field, row.getCell(col).value]));
      if (Object.values(values).every(value => !cellText(value))) continue;
      const warnings = [];
      const errors = [];
      const data = {};
      for (const field of ['nombre_solicitud', 'numero_radicado', 'medio_realizado', 'observacion_respuesta']) data[field] = cellText(values[field]) || null;
      if (!data.nombre_solicitud) errors.push('Falta la solicitud.');
      data.fecha_radicacion = parseDate(values.fecha_radicacion, 'Fecha de radicación', warnings);
      data.fecha_respuesta = parseDate(values.fecha_respuesta, 'Fecha de respuesta', warnings);
      data.hora = parseTime(values.hora, warnings);
      if (!cellText(values.hora) && values.fecha_radicacion instanceof Date && values.fecha_radicacion.toISOString().slice(11, 19) !== '00:00:00') {
        data.hora = values.fecha_radicacion.toISOString().slice(11, 19);
        warnings.push('Hora tomada de la fecha de radicación, que incluye fecha y hora en el Excel.');
      }
      if (data.fecha_respuesta && data.fecha_radicacion && data.fecha_respuesta < data.fecha_radicacion) warnings.push('La respuesta es anterior a la radicación. Verifica las fechas del archivo.');
      const medio = data.medio_realizado || '';
      data.cedula_encargado = cellText(values.cedula_encargado) || medio.match(/c\s*\.?\s*c\s*\.?\s*[:.-]?\s*([\d.]+)/i)?.[1]?.replace(/\./g, '') || medio.match(/\n\s*(\d{6,12})\s*$/)?.[1] || null;
      data.enlaces_respuesta = [];
      const link = values.enlaces_respuesta;
      if (cellText(link)) {
        const url = link?.hyperlink || (typeof link === 'object' && link.formula?.match(/^HYPERLINK\("([^"]+)"/i)?.[1]) || cellText(link);
        data.enlaces_respuesta.push({ nombre: cellText(link), url });
        if (!/^https?:\/\//i.test(url)) warnings.push('El enlace de respuesta apunta a un archivo local o no es una URL web. Deberás adjuntar ese documento.');
      }
      if (!radicados(data.numero_radicado).length) warnings.push('Sin radicado válido: se compara por solicitud y fecha de radicación.');
      if (!radicados(data.numero_radicado).length && !data.fecha_radicacion) errors.push('Sin radicado ni fecha válida no es posible detectar duplicados. Completa uno de estos datos.');
      data.importacion_fuentes = [{ hoja: sheet.name, fila: n, valores: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, cellText(value)])) }];
      rows.push({ key: identity(data), hoja: sheet.name, filas: [n], data, warnings, errors });
      if (rows.length > 2000) throw new Error('Importa como máximo 2.000 filas a la vez.');
    }
  }
  if (!rows.length) throw new Error('No se encontraron PQR. El archivo debe contener las columnas Solicitud y Número de radicado.');
  // Duplicate rows may contain different response attachments, as in the MEN workbook.
  const grouped = new Map();
  for (const row of rows) {
    const previous = grouped.get(row.key);
    if (!previous) { grouped.set(row.key, row); continue; }
    for (const field of Object.keys(row.data).filter(key => !['enlaces_respuesta', 'importacion_fuentes'].includes(key))) {
      const same = field === 'numero_radicado'
        ? JSON.stringify(radicados(previous.data[field])) === JSON.stringify(radicados(row.data[field]))
        : normalize(previous.data[field]) === normalize(row.data[field]);
      if (previous.data[field] && row.data[field] && !same) {
        previous.errors.push(`Las filas del mismo radicado tienen datos distintos en ${field}. Corrige el Excel antes de importar este PQR.`);
      } else if (!previous.data[field]) previous.data[field] = row.data[field];
    }
    previous.filas.push(...row.filas);
    previous.data.importacion_fuentes.push(...row.data.importacion_fuentes);
    for (const link of row.data.enlaces_respuesta) if (!previous.data.enlaces_respuesta.some(item => item.url === link.url)) previous.data.enlaces_respuesta.push(link);
    previous.warnings = [...new Set([...previous.warnings, ...row.warnings, 'Filas del mismo PQR agrupadas; se conservan todos sus enlaces.'])];
    previous.errors.push(...row.errors);
  }
  const entries = [...grouped.values()];
  const owners = new Map();
  for (const row of entries) {
    for (const id of radicados(row.data.numero_radicado)) {
      const previous = owners.get(id);
      if (previous && previous.key !== row.key) {
        const message = `El radicado ${id} aparece en grupos de radicados distintos. Revisa las filas antes de importar.`;
        previous.errors.push(message);
        row.errors.push(message);
      } else owners.set(id, row);
    }
  }
  return { totalFilas: rows.length, hojasIgnoradas: ignoredSheets, rows: entries };
}

function classifyRows(parsed, existing) {
  return { ...parsed, rows: parsed.rows.map(row => {
    const ids = radicados(row.data.numero_radicado);
    const matches = existing.filter(pqr => pqr.importacion_clave === row.key || (ids.length
      ? radicados(pqr.numero_radicado).some(id => ids.includes(id))
      : !radicados(pqr.numero_radicado).length && identity(pqr) === row.key));
    return { ...row, accion: row.errors.length ? 'error' : matches.length ? 'existente' : 'crear' };
  }) };
}

module.exports = { parseWorkbook, classifyRows, identity, radicados };
