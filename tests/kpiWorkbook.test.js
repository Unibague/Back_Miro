const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { KpiWorkbook, fillSheet } = require('../services/kpiWorkbook');

async function fillWithExistingContent(value, otherValue) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet('Cohorte_Programa');
  worksheet.addRow(['CODIGO', 'NOMBRE']);
  worksheet.addRow([1, 'Anterior']);
  // La fila vacía separa los datos anteriores del contenido preparado.
  worksheet.getCell('A4').value = value;
  if (otherValue !== undefined) worksheet.getCell('B4').value = otherValue;
  const book = new KpiWorkbook(await workbook.xlsx.writeBuffer());
  const sheet = book.sheets[0];
  const result = fillSheet(book, sheet, {
    headerRow: 1,
    headers: new Map([[1, 'CODIGO'], [2, 'NOMBRE']]),
    candidate: { fieldKeys: new Set(['codigo', 'nombre']) },
  }, [1, 2, 3].map((number) => new Map([['codigo', number], ['nombre', 'Nuevo']])));
  const saved = new ExcelJS.Workbook();
  await saved.xlsx.load(await book.toBuffer());
  return { result, worksheet: saved.getWorksheet('Cohorte_Programa') };
}

for (const result of [undefined, 0, 2]) {
  test(`no advierte por fórmulas preparadas con resultado ${result}`, async () => {
    const formula = { formula: '1+1' };
    if (result !== undefined) formula.result = result;
    const filled = await fillWithExistingContent(formula);
    assert.deepEqual(filled.result.advertencias, []);
    assert.equal(filled.worksheet.getCell('A4').value.formula, '1+1');
    assert.equal(filled.worksheet.getCell('B4').value, 'Nuevo');
  });
}

test('mantiene la advertencia por valores antiguos debajo del bloque de datos', async () => {
  const { result } = await fillWithExistingContent('Dato anterior');
  assert.equal(result.advertencias.length, 1);
  assert.match(result.advertencias[0], /fila 4/);
});

test('una fórmula no oculta valores antiguos en otras columnas de la misma fila', async () => {
  const { result } = await fillWithExistingContent({ formula: '1+1', result: 2 }, 'Dato anterior');
  assert.equal(result.advertencias.length, 1);
  assert.match(result.advertencias[0], /fila 4/);
});

test('las fórmulas calculadas en Miró se conservan en el Excel con su resultado', async () => {
  const { FormulaEngine } = require('../services/kpiFormulaEngine');
  const workbook = new ExcelJS.Workbook();
  const datos = workbook.addWorksheet('Datos');
  datos.addRow(['CODIGO', 'DOBLE']);
  datos.getCell('A2').value = 1;
  datos.getCell('B2').value = { formula: 'A2*2' };
  const resumen = workbook.addWorksheet('Resumen');
  resumen.getCell('A1').value = { formula: 'SUM(Datos!B2:B4)' };
  const book = new KpiWorkbook(await workbook.xlsx.writeBuffer());

  const engine = new FormulaEngine(book, new Map([['Datos', { headerRow: 1, count: 3, inputs: new Map([[1, [1, 2, 3]]]) }]]));
  const calculo = engine.materialize();
  engine.writeVirtualSheets();
  engine.release();
  book.finalize([]);

  assert.equal(calculo.celdas, 1);
  const saved = new ExcelJS.Workbook();
  await saved.xlsx.load(await book.toBuffer());
  const total = saved.getWorksheet('Resumen').getCell('A1').value;
  assert.equal(total.formula, 'SUM(Datos!B2:B4)');
  assert.equal(total.result, 12);
  const hoja = saved.getWorksheet('Datos');
  assert.equal(hoja.getCell('B2').value.formula, 'A2*2');
  assert.equal(hoja.getCell('B2').value.result, 2);
  assert.equal(hoja.getCell('B4').value.result, 6);
  assert.equal(hoja.getCell('B4').formula, 'A4*2');
  assert.equal(hoja.getCell('A4').value, 3);
});
