/**
 * Migra pdiFormularioRespuesta hacia el modelo de "borrador compartido":
 * el indice unico pasa de {formulario_id, indicador_id, respondido_por, corte}
 * a {formulario_id, indicador_id, corte} (sin respondido_por).
 *
 * Para cada grupo duplicado por (formulario_id, indicador_id, corte):
 *   - conserva el doc con estado 'Enviado' mas avanzado en el flujo de aval
 *     (Aprobado > Rechazado/Pendiente > Borrador), y entre empates el mas
 *     reciente por fecha_envio/updatedAt.
 *   - fusiona el array `documentos` de los descartados hacia el conservado
 *     (evita perder evidencias ya subidas).
 *   - loguea cada fusion/eliminacion para auditoria manual.
 *
 * Uso:
 *   node scripts/migrarRespuestasCompartidas.js --dry-run   (solo reporta, no escribe)
 *   node scripts/migrarRespuestasCompartidas.js             (aplica los cambios)
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');

const DB_URI = process.env.DB_URI || 'mongodb://127.0.0.1:27017/miro';
const DRY_RUN = process.argv.includes('--dry-run');

const ESTADO_AVAL_RANK = { Aprobado: 3, Rechazado: 2, Pendiente: 1 };

function rankRegistro(r) {
    const estadoRank = r.estado === 'Enviado' ? 1 : 0;
    const avalRank = ESTADO_AVAL_RANK[r.estado_aval] ?? 0;
    return [estadoRank, avalRank];
}

function elegirConservar(registros) {
    // Ordena de "mejor" a "peor": estado Enviado primero, luego aval mas avanzado,
    // luego el mas reciente (fecha_envio o updatedAt).
    return [...registros].sort((a, b) => {
        const [aEstado, aAval] = rankRegistro(a);
        const [bEstado, bAval] = rankRegistro(b);
        if (aEstado !== bEstado) return bEstado - aEstado;
        if (aAval !== bAval) return bAval - aAval;
        const aFecha = new Date(a.fecha_envio || a.updatedAt || 0).getTime();
        const bFecha = new Date(b.fecha_envio || b.updatedAt || 0).getTime();
        return bFecha - aFecha;
    })[0];
}

async function main() {
    await mongoose.connect(DB_URI);
    console.log(`Conectado a MongoDB: ${DB_URI}${DRY_RUN ? ' (DRY RUN, no se escribira nada)' : ''}`);

    const Respuesta = mongoose.model(
        'pdiFormularioRespuesta',
        new mongoose.Schema({}, { strict: false, collection: 'pdiformulariorespuestas' }),
    );

    const grupos = await Respuesta.aggregate([
        {
            $group: {
                _id: { formulario_id: '$formulario_id', indicador_id: '$indicador_id', corte: '$corte' },
                count: { $sum: 1 },
            },
        },
        { $match: { count: { $gt: 1 } } },
    ]);

    if (grupos.length === 0) {
        console.log('No se encontraron duplicados por {formulario_id, indicador_id, corte}. Es seguro aplicar el nuevo indice unico.');
        await mongoose.disconnect();
        return;
    }

    console.log(`Grupos duplicados encontrados: ${grupos.length}`);
    let totalFusionados = 0;
    let totalEliminados = 0;

    for (const grupo of grupos) {
        const { formulario_id, indicador_id, corte } = grupo._id;

        const registros = await Respuesta.find({ formulario_id, indicador_id: indicador_id ?? null, corte }).lean();
        const conservarRef = elegirConservar(registros);
        const descartar = registros.filter((r) => String(r._id) !== String(conservarRef._id));

        console.log(`\nGrupo formulario_id=${formulario_id} indicador_id=${indicador_id} corte=${corte}:`);
        console.log(`  Conservar: _id=${conservarRef._id} estado=${conservarRef.estado} estado_aval=${conservarRef.estado_aval} respondido_por="${conservarRef.respondido_por}" fecha_envio=${conservarRef.fecha_envio}`);

        const documentosFusionados = [...(conservarRef.documentos || [])];
        const idsExistentes = new Set(documentosFusionados.map((d) => d.drive_file_id).filter(Boolean));

        for (const r of descartar) {
            console.log(`  Descartar: _id=${r._id} estado=${r.estado} estado_aval=${r.estado_aval} respondido_por="${r.respondido_por}" fecha_envio=${r.fecha_envio} (${(r.documentos || []).length} documento(s))`);
            for (const doc of (r.documentos || [])) {
                if (doc.drive_file_id && idsExistentes.has(doc.drive_file_id)) continue;
                documentosFusionados.push(doc);
                if (doc.drive_file_id) idsExistentes.add(doc.drive_file_id);
                totalFusionados++;
            }
        }

        if (!DRY_RUN) {
            await Respuesta.updateOne({ _id: conservarRef._id }, { $set: { documentos: documentosFusionados } });
            for (const r of descartar) {
                await Respuesta.deleteOne({ _id: r._id });
                totalEliminados++;
            }
        } else {
            totalEliminados += descartar.length;
        }
    }

    console.log(`\n${DRY_RUN ? '[DRY RUN] Se habrian' : 'Se'} fusionado ${totalFusionados} documento(s) y eliminado ${totalEliminados} registro(s) duplicado(s).`);
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
});
