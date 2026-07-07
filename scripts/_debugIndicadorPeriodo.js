require('dotenv').config();
const mongoose = require('mongoose');
const Indicador = require('../models/pdiIndicador');

async function main() {
    await mongoose.connect(process.env.DB_URI);
    const ind = await Indicador.findById('69fe7cc43eb6cb061d888f55').select('codigo periodos').lean();
    console.log(ind.codigo);
    console.log(JSON.stringify(ind.periodos, null, 2));
    await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
