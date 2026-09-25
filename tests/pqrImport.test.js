const { test } = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { parseWorkbook, classifyRows, identity, radicados } = require('../services/pqrImport');

const headers = ['Solicitud', 'Fecha de radicación', 'Hora ', 'Número de radicado', 'Que medio x cual se realizo', 'Fecha de la respuesta', 'Observación/Respuesta', 'Link Respuesta'];
async function file(rows, options = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.properties.date1904 = !!options.date1904;
  const sheet = workbook.addWorksheet('PQR MEN');
  sheet.addRow([]);
  sheet.addRow(options.headers || headers);
  rows.forEach(row => sheet.addRow(row));
  return workbook.xlsx.writeBuffer();
}

test('matches headers, imports all fields, and preserves original values and URLs', async () => {
  const parsed = await parseWorkbook(await file([['Solicitud completa', new Date('2026-07-14T00:00:00Z'), '4:29:01 p. m.', '2026-ER-0312378', 'PQRSDF --c.c. 1.110.596.771', new Date('2026-08-06T00:00:00Z'), 'Respuesta\ncompleta', { text: 'Respuesta MEN', hyperlink: 'https://example.org/respuesta.pdf' }]]));
  const data = parsed.rows[0].data;
  assert.equal(data.fecha_radicacion, '2026-07-14');
  assert.equal(data.fecha_respuesta, '2026-08-06');
  assert.equal(data.hora, '16:29:01');
  assert.equal(data.cedula_encargado, '1110596771');
  assert.equal(data.observacion_respuesta, 'Respuesta\ncompleta');
  assert.deepEqual(data.enlaces_respuesta, [{ nombre: 'Respuesta MEN', url: 'https://example.org/respuesta.pdf' }]);
  assert.equal(data.importacion_fuentes[0].fila, 3);
  assert.equal(data.importacion_fuentes[0].valores.hora, '4:29:01 p. m.');
  assert.equal(parsed.rows[0].warnings.length, 0);
});

test('groups duplicate requests and keeps both response links', async () => {
  const base = ['Solicitud', '14/07/2026', '4:29:01 pm', '2026-ER-0312378\n2026-ER-0298020', 'MEN\n93398576', 'Sin Rpta', 'Pendiente'];
  const parsed = await parseWorkbook(await file([
    [...base, { text: 'Respuesta 1', hyperlink: 'https://example.org/1' }],
    [...base, { text: 'Respuesta 2', hyperlink: 'https://example.org/2' }],
  ]));
  assert.equal(parsed.totalFilas, 2);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.rows[0].filas, [3, 4]);
  assert.equal(parsed.rows[0].data.enlaces_respuesta.length, 2);
  assert.equal(parsed.rows[0].data.importacion_fuentes.length, 2);
  assert.equal(parsed.rows[0].data.fecha_respuesta, null);
  assert.equal(parsed.rows[0].data.cedula_encargado, '93398576');
});

test('does not merge different radicados with identical descriptions', async () => {
  const parsed = await parseWorkbook(await file([['Solicitud', '', '', '2026-ER-1'], ['Solicitud', '', '', '2026-ER-2']]));
  assert.equal(parsed.rows.length, 2);
});

test('rejects conflicting data and partially overlapping groups', async () => {
  const conflict = await parseWorkbook(await file([['Primera', '', '', '2026-ER-1'], ['Distinta', '', '', '2026-ER-1']]));
  assert.equal(classifyRows(conflict, []).rows[0].accion, 'error');
  const overlap = await parseWorkbook(await file([['Primera', '', '', '2026-ER-1\n2026-ER-2'], ['Otra', '', '', '2026-ER-2']]));
  assert.ok(classifyRows(overlap, []).rows.every(row => row.accion === 'error'));
});

test('dates embedded in text, multiple dates, invalid time and local links stay reviewable', async () => {
  const parsed = await parseWorkbook(await file([['Solicitud', '** Correo: 30/04/2024', '40:46:11 a.m.', '2024-ER-1', '', '7/12/2023\n07-03-2024', '', { text: 'Local', hyperlink: '../Respuesta MEN/a.pdf' }]]));
  const row = parsed.rows[0];
  assert.equal(row.data.fecha_radicacion, '2024-04-30');
  assert.equal(row.data.fecha_respuesta, '2024-03-07');
  assert.equal(row.data.hora, null);
  assert.equal(row.warnings.length, 5);
  assert.equal(row.data.importacion_fuentes[0].valores.fecha_respuesta, '7/12/2023\n07-03-2024');
  assert.equal(row.data.enlaces_respuesta[0].url, '../Respuesta MEN/a.pdf');
});

test('rejects impossible dates; recognizes midnight, noon and Excel time cells', async () => {
  const parsed = await parseWorkbook(await file([
    ['A', '31/02/2026', '12:00 am', '2026-ER-1'],
    ['B', '', '12:00 pm', '2026-ER-2'],
    ['C', new Date('2026-01-29T00:00:00Z'), new Date('1899-12-30T14:52:11Z'), '2026-ER-3'],
  ]));
  assert.equal(parsed.rows[0].data.fecha_radicacion, null);
  assert.equal(parsed.rows[0].data.hora, '00:00:00');
  assert.equal(parsed.rows[1].data.hora, '12:00:00');
  assert.equal(parsed.rows[2].data.hora, '14:52:11');
  const oldEpoch = await parseWorkbook(await file([['A', new Date('2026-01-29T00:00:00Z'), '', '2026-ER-3']], { date1904: true }));
  assert.equal(oldEpoch.rows[0].data.fecha_radicacion, '2026-01-29');
});

test('matches existing active or closed records by radicado, including one of multiple radicados', async () => {
  const parsed = await parseWorkbook(await file([['Solicitud', '', '', '2026-ER-0312378\n2026-ER-0298020']]));
  for (const cerrado of [false, true]) {
    const existing = [{ nombre_solicitud: 'Título editado', numero_radicado: '2026-ER-0298020.', cerrado }];
    assert.equal(classifyRows(parsed, existing).rows[0].accion, 'existente');
  }
  assert.deepEqual(radicados('2026 - ER - 0005768.'), ['2026-ER-0005768']);
});

test('fallback deduplication uses description and date, never the NA placeholder alone', async () => {
  const parsed = await parseWorkbook(await file([['Una', '01/07/2026', '', 'NA'], ['Otra', '01/07/2026', '', 'NA']]));
  assert.equal(parsed.rows.length, 2);
  assert.equal(classifyRows(parsed, [parsed.rows[0].data]).rows[0].accion, 'existente');
  assert.equal(classifyRows(parsed, [parsed.rows[0].data]).rows[1].accion, 'crear');
  const invalid = await parseWorkbook(await file([['Una', '', '', 'NA']]));
  assert.equal(classifyRows(invalid, []).rows[0].accion, 'error');
});

test('finds reordered accented headers and skips empty rows', async () => {
  const parsed = await parseWorkbook(await file([['2026-ER-1', 'Solicitud'], [], ['2026-ER-2', 'Otra']], { headers: ['  NUMERO DE RADICADO ', ' SOLICITUD '] }));
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].data.numero_radicado, '2026-ER-1');
  await assert.rejects(parseWorkbook(await file([['A', 'B']], { headers: ['Wrong', 'Format'] })), /columnas Solicitud/);
});

test('identity remains the same when radicados are reordered', async () => {
  assert.equal(identity({ numero_radicado: '2026-ER-1\n2026-ER-2' }), identity({ numero_radicado: '2026-ER-2\n2026-ER-1' }));
  const parsed = await parseWorkbook(await file([['Solicitud', '', '', '2026-ER-1\n2026-ER-2'], ['Solicitud', '', '', '2026-ER-2\n2026-ER-1']]));
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].errors.length, 0);
});

test('reads a HYPERLINK formula without a cached value', async () => {
  const parsed = await parseWorkbook(await file([['A', '', '', '2026-ER-1', '', '', '', { formula: 'HYPERLINK("https://example.org/doc","Documento")' }]]));
  assert.deepEqual(parsed.rows[0].data.enlaces_respuesta, [{ nombre: 'Documento', url: 'https://example.org/doc' }]);
});

test('recovers the time included in the filing date when the time column is empty', async () => {
  const parsed = await parseWorkbook(await file([['Solicitud', new Date('2024-07-03T17:49:45Z'), '', '2024-ER-0358089']]));
  assert.equal(parsed.rows[0].data.fecha_radicacion, '2024-07-03');
  assert.equal(parsed.rows[0].data.hora, '17:49:45');
  assert.ok(parsed.rows[0].warnings.some(message => message.includes('Hora tomada')));
});

test('import route previews without writes, stores fields/program, and safely retries', async t => {
  const express = require('express');
  const PQR = require('../models/pqr');
  const Program = require('../models/programs');
  const records = [];
  t.mock.method(PQR, 'init', async () => {});
  t.mock.method(PQR, 'find', () => ({ lean: async () => records }));
  t.mock.method(PQR, 'findById', id => ({ lean: async () => records.find(row => row._id === id) }));
  t.mock.method(Program, 'countDocuments', async () => 1);
  t.mock.method(PQR, 'updateOne', async (query, update) => {
    if (records.some(row => row.importacion_clave === query.importacion_clave)) return { upsertedCount: 0 };
    const data = update.$setOnInsert;
    const document = new PQR(data);
    await document.validate();
    records.push({ ...document.toObject(), _id: 'saved-id' });
    return { upsertedCount: 1, upsertedId: 'saved-id' };
  });
  const app = express();
  app.use('/pqr', require('../routes/pqr'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/pqr`;
  const buffer = await file([['Solicitud', '14/07/2026', '4:29:01 pm', '2026-ER-1', 'PQRSDF --c.c. 93375711', '', 'Observación', { text: 'Doc', hyperlink: 'https://example.org/1' }]]);
  const post = (route, selection, name = 'pqr.xlsx', bytes = buffer) => {
    const body = new FormData();
    body.append('file', new Blob([bytes]), name);
    if (selection) body.append('seleccion', JSON.stringify(selection));
    return fetch(url + route, { method: 'POST', body });
  };
  const previewResponse = await post('/importar/preview');
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(records.length, 0);
  const selection = [{ key: preview.rows[0].key, programa_id: '507f1f77bcf86cd799439011' }];
  const saved = await (await post('/importar', selection)).json();
  assert.equal(saved.creados, 1);
  assert.equal(saved.pqrs[0].cedula_encargado, '93375711');
  assert.equal(saved.pqrs[0].programa_id, selection[0].programa_id);
  assert.equal(saved.pqrs[0].cerrado, false);
  assert.equal(saved.pqrs[0].enlaces_respuesta.length, 1);
  const again = await (await post('/importar', selection)).json();
  assert.equal(again.creados, 0);
  assert.equal(again.omitidos, 1);
  assert.equal(records.length, 1);
  assert.equal((await post('/importar', [{ key: 'invented-key' }])).status, 400);
  assert.equal((await post('/importar/preview', null, 'bad.csv')).status, 400);
  assert.equal((await post('/importar/preview', null, 'bad.xlsx', Buffer.from('invalid'))).status, 400);
  assert.equal((await post('/importar/preview', null, 'huge.xlsx', Buffer.alloc(5 * 1024 * 1024 + 1))).status, 400);
  assert.equal((await post('/importar', [{ key: preview.rows[0].key, programa_id: 'not-an-id' }])).status, 400);
});
