require('dotenv').config();
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');

async function main() {
  await mongoose.connect(process.env.DB_URI);
  const HistoricoDocentes = require('../models/historicoDocentes');
  const { downloadDriveFileBuffer } = require('../config/googleDrive');

  const registro = await HistoricoDocentes.findOne({ file_name: /Docentes_IES/i });
  console.log('drive_file_id:', registro.drive_file_id);

  const buffer = await downloadDriveFileBuffer(registro.drive_file_id);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  workbook.worksheets.forEach((worksheet) => {
    console.log('--- sheet:', worksheet.name, 'rowCount:', worksheet.rowCount, 'columnCount:', worksheet.columnCount);
    // print first 3 rows raw
    for (let r = 1; r <= Math.min(3, worksheet.rowCount); r++) {
      const row = worksheet.getRow(r);
      const vals = [];
      row.eachCell({ includeEmpty: true }, (cell, colIndex) => {
        vals[colIndex - 1] = cell.value;
      });
      console.log(`  row ${r}:`, JSON.stringify(vals));
    }
  });

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
