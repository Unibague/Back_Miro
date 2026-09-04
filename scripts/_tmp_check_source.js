require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.DB_URI);
  const HistoricoDocentes = require('../models/historicoDocentes');
  const registro = await HistoricoDocentes.findOne({ file_name: /Docentes_IES/i });
  console.log('id:', registro._id.toString());
  console.log('drive_file_id:', registro.drive_file_id);
  console.log('source_published_template:', registro.source_published_template);
  console.log('cloned_from:', registro.cloned_from);
  console.log('has excel_data buffer:', !!registro.excel_data, registro.excel_data ? registro.excel_data.length : 0);
  console.log('category:', registro.category);
  console.log('dimension:', registro.dimension);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
