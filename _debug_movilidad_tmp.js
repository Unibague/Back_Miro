require('dotenv').config();
const mongoose = require('mongoose');
async function main() {
  await mongoose.connect(process.env.DB_URI);
  const HistoricoDocentes = require('./models/historicoDocentes');

  const doc = await HistoricoDocentes.findById('6a6d0a30a97f1340c0de9837').lean();
  const sheet = doc.sheets.find(s => s.name === 'MOVILIDAD_ENTRANTE_ESTUDIANTES');
  const h = sheet.headers;
  ['Nombre identificado','Programa o dependencia','PROGRAMA_ACADEMICO_RELACIONADO','PRIMER_NOMBRE','SEGUNDO_NOMBRE','PRIMER_APELLIDO','SEGUNDO_APELLIDO'].forEach(field => {
    const idx = h.indexOf(field);
    console.log(field, '-> idx', idx, 'values:', sheet.rows.map(r => r[idx]));
  });

  const doc2 = await HistoricoDocentes.findById('6a6d0a25a97f1340c0de9834').lean();
  const sheet2 = doc2.sheets.find(s => s.name === 'MOVILIDAD_ENTRANTE_FUNCIONARIOS');
  const h2 = sheet2.headers;
  console.log('\n--- FUNCIONARIOS ---');
  ['Nombre identificado','Programa o dependencia','PROGRAMA_ACADEMICO_RELACIONADO','PRIMER_NOMBRE','SEGUNDO_NOMBRE','PRIMER_APELLIDO','SEGUNDO_APELLIDO'].forEach(field => {
    const idx = h2.indexOf(field);
    console.log(field, '-> idx', idx, 'values:', sheet2.rows.map(r => r[idx]));
  });

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
