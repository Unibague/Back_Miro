require('dotenv').config();
const mongoose = require('mongoose');
const Respuesta = require('../models/pdiFormularioRespuesta');
const Indicador = require('../models/pdiIndicador');

async function main() {
    await mongoose.connect(process.env.DB_URI);

    const docs = await Respuesta.find({ estado: 'Enviado' }).sort({ updatedAt: -1 }).limit(10).lean();
    for (const doc of docs) {
        console.log('---', doc._id.toString(), '---');
        console.log('indicador_id:', doc.indicador_id, 'corte:', doc.corte, 'respondido_por:', doc.respondido_por);
        console.log('estado_aval_proyecto:', doc.estado_aval_proyecto, '| estado_aval:', doc.estado_aval, '| aval_planeacion:', doc.aval_planeacion);
        console.log('updatedAt:', doc.updatedAt);
    }

    console.log('\n=== Indicadores periodos (para los indicador_id de arriba) ===');
    const indIds = [...new Set(docs.map(d => String(d.indicador_id)))];
    for (const id of indIds) {
        const ind = await Indicador.findById(id).select('codigo periodos').lean();
        console.log(ind?.codigo, JSON.stringify(ind?.periodos, null, 2));
    }

    await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
