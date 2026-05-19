#!/usr/bin/env node
/**
 * Revisión anual de festivos Colombia.
 *
 * Compara el calendario de `date-holidays` (usado en autocalculo de fechas MEN)
 * contra la API pública Nager.Date como referencia independiente.
 *
 * Uso:
 *   npm run festivos:revisar
 *   node scripts/revisar-festivos-colombia.js --year=2027
 *   node scripts/revisar-festivos-colombia.js --year=2026 --year=2027
 *   node scripts/revisar-festivos-colombia.js --estricto   (falla también si la librería tiene días extra)
 *
 * Código de salida: 1 si Nager.Date trae festivos que la librería no tiene (actualizar paquete).
 * Los días solo en librería (p. ej. Domingo de Ramos) se reportan como aviso, no fallan salvo --estricto.
 *
 * Recomendación: ejecutar cada inicio de año y tras `npm update date-holidays`.
 */
const { execSync } = require('child_process');
const axios = require('axios');
const Holidays = require('date-holidays');
const path = require('path');

const NAGER_URL = (year) => `https://date.nager.at/api/v3/PublicHolidays/${year}/CO`;

function parseArgs() {
  const years = [];
  let estricto = false;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--year=')) {
      years.push(Number(arg.split('=')[1]));
    } else if (arg === '--estricto') {
      estricto = true;
    } else if (/^\d{4}$/.test(arg)) {
      years.push(Number(arg));
    }
  }
  if (years.length === 0) {
    const y = new Date().getFullYear();
    years.push(y, y + 1);
  }
  return { years: [...new Set(years)].sort(), estricto };
}

function festivosDesdeLibreria(year) {
  const hd = new Holidays('CO');
  const inicio = new Date(year, 0, 1, 12, 0, 0);
  const fin = new Date(year, 11, 31, 12, 0, 0);
  const map = new Map();

  for (let d = new Date(inicio); d <= fin; d.setDate(d.getDate() + 1)) {
    const hit = hd.isHoliday(new Date(d));
    if (!hit) continue;
    const list = Array.isArray(hit) ? hit : [hit];
    const ymd = d.toISOString().slice(0, 10);
    const nombres = list.map((h) => h.name || h.type || 'Festivo').join(' / ');
    map.set(ymd, nombres);
  }
  return map;
}

async function festivosDesdeNager(year) {
  const res = await axios.get(NAGER_URL(year), { timeout: 15000 });
  const map = new Map();
  for (const h of res.data || []) {
    if (!h.date) continue;
    const ymd = String(h.date).slice(0, 10);
    map.set(ymd, h.localName || h.name || 'Festivo');
  }
  return map;
}

function comparar(year, lib, ref) {
  const soloLib = [];
  const soloRef = [];
  const coinciden = [];

  for (const [fecha, nombre] of lib) {
    if (ref.has(fecha)) coinciden.push({ fecha, lib: nombre, ref: ref.get(fecha) });
    else soloLib.push({ fecha, nombre });
  }
  for (const [fecha, nombre] of ref) {
    if (!lib.has(fecha)) soloRef.push({ fecha, nombre });
  }
  return { soloLib, soloRef, coinciden };
}

function versionInstalada() {
  try {
    const pkgPath = require.resolve('date-holidays/package.json');
    return require(pkgPath).version;
  } catch {
    return require('../package.json').dependencies['date-holidays']?.replace(/^\^/, '') ?? '?';
  }
}

function versionNpmLatest() {
  try {
    return execSync('npm view date-holidays version', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const { years, estricto } = parseArgs();
  const instalada = versionInstalada();
  const latest = versionNpmLatest();

  console.log('=== Revisión festivos Colombia (MEN) ===\n');
  console.log(`date-holidays instalada: ${instalada}`);
  if (latest) {
    const desactualizada = instalada !== latest;
    console.log(`Última en npm:          ${latest}${desactualizada ? '  ← considera npm update date-holidays' : '  (al día)'}`);
  }
  console.log('\nAutocalculo MEN con día hábil solo en: inicio, documento par, digitación SACES.');
  console.log('Referencia externa: Nager.Date API (CO)\n');

  let faltaEnLibreria = false;
  let extraEnLibreria = false;

  for (const year of years) {
    console.log(`--- Año ${year} ---`);
    let ref;
    try {
      ref = await festivosDesdeNager(year);
    } catch (e) {
      console.error(`No se pudo consultar Nager.Date para ${year}:`, e.message || e);
      faltaEnLibreria = true;
      continue;
    }

    const lib = festivosDesdeLibreria(year);
    const { soloLib, soloRef, coinciden } = comparar(year, lib, ref);

    console.log(`  Librería: ${lib.size} días festivos | Referencia: ${ref.size} días festivos | Coinciden: ${coinciden.length}`);

    if (soloLib.length) {
      extraEnLibreria = true;
      console.log('\n  Aviso — solo en date-holidays (a menudo Semana Santa; no suele ser problema):');
      soloLib.forEach(({ fecha, nombre }) => console.log(`    ${fecha}  ${nombre}`));
    }
    if (soloRef.length) {
      faltaEnLibreria = true;
      console.log('\n  IMPORTANTE — solo en Nager.Date (actualizar date-holidays):');
      soloRef.forEach(({ fecha, nombre }) => console.log(`    ${fecha}  ${nombre}`));
    }
    if (!soloLib.length && !soloRef.length) {
      console.log('  OK: calendarios alineados.\n');
    } else {
      console.log('');
    }
  }

  if (faltaEnLibreria) {
    console.log('Resultado: faltan festivos en la librería → ejecuta npm update date-holidays y vuelve a correr este script.');
    process.exit(1);
  }
  if (extraEnLibreria && estricto) {
    console.log('Resultado: la librería tiene días extra (--estricto).');
    process.exit(1);
  }
  if (extraEnLibreria) {
    console.log('Resultado: avisos menores en librería; festivos oficiales de referencia están cubiertos.');
  } else {
    console.log('Resultado: OK para los años revisados.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
