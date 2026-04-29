/**
 * Migración: parchea respuestas enviadas con estado_aval = null
 *
 * Caso: formularios enviados cuando el macroproyecto no tenía lider_email
 * configurado. Antes quedaban con estado_aval=null y no aparecían en la
 * vista admin. Ahora se aprueban automáticamente (sin líder no hay quien avale).
 *
 * Uso: node scripts/fixAvalNull.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const RESPUESTA_SCHEMA = new mongoose.Schema({
    formulario_id:  mongoose.Schema.Types.ObjectId,
    indicador_id:   mongoose.Schema.Types.ObjectId,
    respondido_por: String,
    corte:          String,
    estado:         String,
    fecha_envio:    Date,
    estado_aval:    { type: String, default: null },
    lider_email_aval: String,
    aval_por:       String,
    aval_comentario: String,
    aval_fecha:     Date,
}, { versionKey: false, timestamps: true });

const Respuesta = mongoose.model('pdiFormularioRespuesta', RESPUESTA_SCHEMA);

async function main() {
    await mongoose.connect(process.env.DB_URI);
    console.log('Conectado a MongoDB:', process.env.DB_URI);

    // Busca enviados con estado_aval null (sin líder configurado al momento del envío)
    const afectados = await Respuesta.find({
        estado: 'Enviado',
        estado_aval: null,
    });

    console.log(`Documentos afectados encontrados: ${afectados.length}`);

    if (!afectados.length) {
        console.log('Nada que migrar.');
        await mongoose.disconnect();
        return;
    }

    for (const doc of afectados) {
        console.log(`  Parcheando ${doc._id} | corte=${doc.corte} | respondido_por=${doc.respondido_por}`);
        doc.estado_aval    = 'Aprobado';
        doc.lider_email_aval = doc.lider_email_aval || '';
        doc.aval_por       = doc.respondido_por || '';
        doc.aval_comentario = '';
        doc.aval_fecha     = doc.fecha_envio || new Date();
        await doc.save();
    }

    console.log(`\nMigración completada. ${afectados.length} documento(s) actualizados.`);
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('Error en migración:', err);
    process.exit(1);
});
