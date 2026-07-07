require('dotenv').config();
const mongoose = require('mongoose');
const Indicador = require('../models/pdiIndicador');

async function main() {
    await mongoose.connect(process.env.DB_URI);
    const ind = await Indicador.findById('69fe7cc43eb6cb061d888f55');
    console.log('Indicador encontrado:', !!ind);
    try {
        await ind.save();
        console.log('Guardado OK, sin errores de validación.');
    } catch (e) {
        console.log('ERROR al guardar:', e.message);
        if (e.errors) {
            for (const key of Object.keys(e.errors)) {
                console.log(' campo:', key, '->', e.errors[key].message);
            }
        }
    }
    await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
