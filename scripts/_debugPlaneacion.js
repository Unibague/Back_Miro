require('dotenv').config();
const mongoose = require('mongoose');
const Respuesta = require('../models/pdiFormularioRespuesta');

async function main() {
    await mongoose.connect(process.env.DB_URI);
    const docs = await Respuesta.find({ indicador_id: '69fe7cc43eb6cb061d888f55', corte: '2026B' }).lean();
    console.log('Cantidad de documentos para este indicador+corte:', docs.length);
    for (const doc of docs) {
        console.log(JSON.stringify(doc, null, 2));
    }
    await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
