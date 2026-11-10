const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const front = path.resolve(__dirname, '../../Front_Miro');
const localRequire = createRequire(path.join(front, 'package.json'));
const ts = localRequire('typescript');
require.extensions['.ts'] = (module, filename) => {
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } });
  module._compile(outputText, filename);
};
const ExcelJS = localRequire('exceljs');
const util = require(path.join(front, 'app/utils/templateUtils.ts'));

(async () => {
  const source = process.argv[2];
  const destination = process.argv[3];
  const data = fs.readFileSync(source);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(data);
  const originalCommentsBySheet = new Map(book.worksheets.map(sheet => {
    const comments = new Map();
    sheet.getRow(1).eachCell(cell => {
      const note = cell.note;
      const text = typeof note === 'string' ? note : (note?.texts || []).map(item => item.text || '').join('');
      if (text) comments.set(cell.address, text);
    });
    return [sheet.name, comments];
  }));
  const sources = book.getWorksheet('_Listas');
  const definitions = book.definedNames.model;
  const sheets = book.worksheets.filter(sheet => sheet.name !== '_Listas' && sheet.getCell('A1').value && sheet.name !== 'INFO').map(sheet => {
    const fields = [];
    sheet.getRow(1).eachCell((cell, col) => {
      if (!cell.value) return;
      const comment = originalCommentsBySheet.get(sheet.name)?.get(cell.address) || '';
      const dv = sheet.getCell(2, col).dataValidation;
      const formula = String(dv.formulae?.[0] || '');
      const name = formula.match(/_MIRO_LIST_[A-Z]+/)?.[0];
      const definition = definitions.find(item => item.name === name);
      const range = definition?.ranges?.[0]?.match(/!\$?([A-Z]+)\$?(\d+):\$?[A-Z]+\$?(\d+)/);
      const options = [];
      if (sources && range) for (let row = Number(range[2]); row <= Number(range[3]); row++) options.push(String(sources.getCell(`${range[1]}${row}`).value ?? ''));
      fields.push({ name: String(cell.value), datatype: 'Texto Largo', comment, column: col, header_row: 1, dropdown_options: options, multiple: dv.type === 'custom' && formula.includes('COUNTIF(') });
    });
    return { name: sheet.name, fields };
  });
  util.applyWorkbookSheetDropdowns({ workbook: book, workbookSheets: sheets, validators: [], originalCommentsBySheet, endRow: 1000 });
  const buffer = await book.xlsx.writeBuffer();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, Buffer.from(buffer));
  console.log(JSON.stringify({ output: destination, sheets: sheets.map(sheet => ({ name: sheet.name, fields: sheet.fields.length })) }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
