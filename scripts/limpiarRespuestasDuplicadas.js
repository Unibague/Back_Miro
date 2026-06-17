/**
 * Limpia registros duplicados de pdiFormularioRespuesta.
 * Para cada combinación (indicador_id, corte) con más de un registro,
 * conserva el más reciente y elimina los demás.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const DB_URI = process.env.DB_URI || 'mongodb://127.0.0.1:27017/miro';

async function main() {
    await mongoose.connect(DB_URI);
    console.log('Conectado a MongoDB:', DB_URI);

    const Respuesta = mongoose.model(
        'pdiFormularioRespuesta',
        new mongoose.Schema({}, { strict: false, collection: 'pdiformulariorespuestas' }),
    );

    // Buscar todos los grupos con más de un registro por (indicador_id, corte)
    const grupos = await Respuesta.aggregate([
        {
            $group: {
                _id: { indicador_id: '$indicador_id', corte: '$corte' },
                ids: { $push: '$_id' },
                fechas: { $push: '$fecha_envio' },
                count: { $sum: 1 },
            },
        },
        { $match: { count: { $gt: 1 } } },
    ]);

    if (grupos.length === 0) {
        console.log('No se encontraron duplicados.');
        await mongoose.disconnect();
        return;
    }

    console.log(`Grupos con duplicados encontrados: ${grupos.length}`);

    let totalEliminados = 0;

    for (const grupo of grupos) {
        const { indicador_id, corte } = grupo._id;

        // Traer todos los registros del grupo ordenados por fecha_envio desc (más reciente primero)
        const registros = await Respuesta.find({
            indicador_id: indicador_id ?? null,
            corte,
        }).sort({ fecha_envio: -1, createdAt: -1 }).lean();

        // El primero es el más reciente → conservar; el resto → eliminar
        const [conservar, ...eliminar] = registros;

        console.log(`\nGrupo indicador_id=${indicador_id} corte=${corte}:`);
        console.log(`  Conservar: _id=${conservar._id} fecha_envio=${conservar.fecha_envio} respondido_por="${conservar.respondido_por}"`);

        for (const r of eliminar) {
            console.log(`  Eliminar:  _id=${r._id} fecha_envio=${r.fecha_envio} respondido_por="${r.respondido_por}"`);
            await Respuesta.deleteOne({ _id: r._id });
            totalEliminados++;
        }
    }

    console.log(`\nLimpieza completada. Registros eliminados: ${totalEliminados}`);
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
});
