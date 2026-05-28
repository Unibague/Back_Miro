/**
 * Días hábiles en Colombia: fines de semana + festivos (incluye Ley Emiliani / Semana Santa).
 * Usa la librería `date-holidays` (datos locales, sin API en cada request).
 */
const Holidays = require('date-holidays');

let hdColombia = null;

function getHolidaysCo() {
  if (!hdColombia) {
    hdColombia = new Holidays('CO');
  }
  return hdColombia;
}

function parseYmd(fechaStr) {
  const [y, m, d] = String(fechaStr).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function toYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(fechaStr, days) {
  const d = parseYmd(fechaStr);
  d.setDate(d.getDate() + days);
  return toYmd(d);
}

function esFinDeSemana(fechaStr) {
  if (!fechaStr) return false;
  const dow = parseYmd(fechaStr).getDay();
  return dow === 0 || dow === 6;
}

function esFestivoColombia(fechaStr) {
  if (!fechaStr) return false;
  const result = getHolidaysCo().isHoliday(parseYmd(fechaStr));
  if (!result) return false;
  return Array.isArray(result) ? result.length > 0 : true;
}

function esDiaInhabil(fechaStr) {
  return esFinDeSemana(fechaStr) || esFestivoColombia(fechaStr);
}

/**
 * Si la fecha cae en sábado, domingo o festivo, avanza al siguiente día hábil.
 * Ej.: viernes festivo → lunes (salta sábado y domingo).
 */
function siguienteDiaHabil(fechaStr) {
  if (!fechaStr) return null;
  let cur = String(fechaStr).slice(0, 10);
  let guard = 0;
  while (esDiaInhabil(cur) && guard < 366) {
    cur = addDays(cur, 1);
    guard += 1;
  }
  return cur;
}

module.exports = {
  siguienteDiaHabil,
  esDiaInhabil,
  esFestivoColombia,
  esFinDeSemana,
  addDays,
};
