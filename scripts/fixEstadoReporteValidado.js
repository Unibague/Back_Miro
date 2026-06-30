/**
 * Migración: sincroniza Indicador.periodos[].estado_reporte = 'Validado'
 * para reportes que ya fueron validados por Planeación antes de que
 * existiera ese estado (se quedaron marcados como 'Aprobado').
 *
 * Uso: node scripts/fixEstadoReporteValidado.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Respuesta = require('../models/pdiFormularioRespuesta');
const Indicador = require('../models/pdiIndicador');

const normalizePeriodo = (value) => String(value ?? '').trim().toUpperCase();

async function main() {
    await mongoose.connect(process.env.DB_URI);
    console.log('Conectado a MongoDB:', process.env.DB_URI);

    const validadas = await Respuesta.find({ aval_planeacion: 'Validado' });
    console.log(`Respuestas validadas por Planeación encontradas: ${validadas.length}`);

    let actualizados = 0;
    let yaCorrectos = 0;
    let sinIndicador = 0;

    for (const resp of validadas) {
        if (!resp.indicador_id || !resp.corte) continue;

        const indicador = await Indicador.findById(resp.indicador_id);
        if (!indicador) {
            sinIndicador++;
            continue;
        }

        const idx = (indicador.periodos ?? []).findIndex(
            (p) => normalizePeriodo(p.periodo) === normalizePeriodo(resp.corte)
        );
        if (idx < 0) continue;

        if (indicador.periodos[idx].estado_reporte === 'Validado') {
            yaCorrectos++;
            continue;
        }

        console.log(`  Parcheando indicador ${indicador.codigo} | corte=${resp.corte} | estado_reporte: ${indicador.periodos[idx].estado_reporte} -> Validado`);
        indicador.periodos[idx].estado_reporte = 'Validado';
        await indicador.save();
        actualizados++;
    }

    console.log(`\nMigración completada. Actualizados: ${actualizados}. Ya estaban correctos: ${yaCorrectos}. Sin indicador: ${sinIndicador}.`);
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('Error en migración:', err);
    process.exit(1);
});
