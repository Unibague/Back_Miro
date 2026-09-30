require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const CnaTemplate = require('../models/cnaTemplates');
const { downloadDriveFileBuffer } = require('../config/googleDrive');
(async () => {
  await mongoose.connect(process.env.DB_URI);
  const ts = await CnaTemplate.find({ $or: [{ name: /investigaci/i }, { file_name: /investigaci/i }] }).lean();
  for (const t of ts) {
    console.log('T', t._id, t.name, t.file_name, t.drive_file_id);
    for (const f of (t.fields||[])) console.log('   F', f.worksheet_name, '|', f.name, '| comment:', String(f.comment||'').slice(0,300).replace(/\n/g,' / '));
    const buf = await downloadDriveFileBuffer(t.drive_file_id);
    fs.writeFileSync('C:/Users/UNIBAGUE/AppData/Local/Temp/claude/c--Users-UNIBAGUE-Documents-Miro-Back-Miro/55dbe82e-8c8e-48e3-94d6-6dad037d8d9f/scratchpad/cna_' + t._id + '.xlsx', buf);
  }
  await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
