/**
 * Migración: corrige respuestas cuyo aval del líder de macroproyecto quedó
 * auto-aprobado con el email de quien reportó (porque en el momento del envío
 * el macroproyecto no tenía líder configurado), pero que hoy sí tienen un
 * líder real y distinto configurado. Esas respuestas deben volver a quedar
 * "Pendiente" para que el líder real las evalúe antes de pasar a Planeación.
 *
 * Ver services/pdiFormulario.js -> applyMacroAvalAfterProyectoApproval para
 * el bug de origen (ya corregido) y scripts/fixAvalNull.js para el precedente
 * de la migración que introdujo el dato "contaminado".
 *
 * Uso:
 *   node scripts/fixMacroAvalPollution.js --dry-run   (solo lista, no guarda)
 *   node scripts/fixMacroAvalPollution.js             (aplica los cambios)
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Respuesta     = require('../models/pdiFormularioRespuesta');
const Indicador     = require('../models/pdiIndicador');
const Accion        = require('../models/pdiAccionEstrategica');
const Proyecto      = require('../models/pdiProyecto');
const Macroproyecto = require('../models/pdiMacroproyecto');

const dryRun = process.argv.includes('--dry-run');

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const getLideresEmailsForIndicador = async (indicadorId) => {
    if (!indicadorId) return [];
    const ind = await Indicador.findById(indicadorId).select('accion_id');
    if (!ind?.accion_id) return [];
    const acc = await Accion.findById(ind.accion_id).select('proyecto_id');
    if (!acc?.proyecto_id) return [];
    const proy = await Proyecto.findById(acc.proyecto_id).select('macroproyecto_id');
    if (!proy?.macroproyecto_id) return [];
    const macro = await Macroproyecto.findById(proy.macroproyecto_id).select('lider_email lideres');
    if (macro?.lideres && Array.isArray(macro.lideres) && macro.lideres.length > 0) {
        return macro.lideres.map((l) => normalizeEmail(l.email)).filter(Boolean);
    }
    const singleEmail = normalizeEmail(macro?.lider_email);
    return singleEmail ? [singleEmail] : [];
};

async function main() {
    await mongoose.connect(process.env.DB_URI);
    console.log('Conectado a MongoDB:', process.env.DB_URI);
    console.log(dryRun ? 'Modo DRY-RUN: no se guardará ningún cambio.\n' : 'Modo APLICAR: se guardarán los cambios.\n');

    const candidatos = await Respuesta.find({
        estado: 'Enviado',
        estado_aval: 'Aprobado',
        aval_planeacion: { $in: [null, 'Pendiente'] },
    });

    console.log(`Candidatos a revisar (estado_aval=Aprobado, aun no validados por Planeación): ${candidatos.length}`);

    let corregidos = 0;
    for (const doc of candidatos) {
        const responderEmail = normalizeEmail(doc.respondido_por);
        const avalEmail = normalizeEmail(doc.lider_email_aval);
        if (!responderEmail || avalEmail !== responderEmail) continue; // no fue auto-aprobado por quien reportó

        const lideresReales = await getLideresEmailsForIndicador(doc.indicador_id);
        if (lideresReales.length === 0) continue; // sigue sin líder real -> la auto-aprobación es correcta
        if (lideresReales.includes(responderEmail)) continue; // quien reportó es de hecho un líder real -> correcto

        console.log(`  [contaminado] ${doc._id} | corte=${doc.corte} | respondido_por=${doc.respondido_por} | lider_real=${lideresReales[0]}`);

        if (!dryRun) {
            doc.lider_email_aval = lideresReales[0];
            doc.estado_aval = 'Pendiente';
            doc.aval_por = '';
            doc.aval_comentario = '';
            doc.aval_fecha = null;
            doc.aval_planeacion = null;
            doc.aval_planeacion_por = '';
            doc.aval_planeacion_comentario = '';
            doc.aval_planeacion_fecha = null;
            await doc.save();
        }
        corregidos++;
    }

    console.log(`\n${dryRun ? 'Se corregirían' : 'Corregidos'} ${corregidos} documento(s) de ${candidatos.length} candidato(s) revisados.`);
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('Error en la migración:', err);
    process.exit(1);
});
