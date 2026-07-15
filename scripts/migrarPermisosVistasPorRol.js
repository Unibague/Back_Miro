/**
 * Migración única: varias llaves de permiso de vista se separaron en llaves
 * independientes por rol (p. ej. "pdi" ahora es solo Administrador, y se
 * agregó "pdiResponsable" para Responsable). Los cargos que ya tenían la
 * llave vieja configurada perderían acceso en silencio si el rol real de esa
 * posición ya no coincide con la nueva restricción de la llave vieja.
 *
 * Esta migración COPIA (no mueve ni borra) el valor de cada llave vieja hacia
 * sus llaves nuevas, para no romper accesos existentes. Es seguro correrla
 * más de una vez (idempotente): si la llave nueva ya tiene datos, no la pisa.
 *
 * Uso: node scripts/migrarPermisosVistasPorRol.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const KEY_VARIANTS = {
    dashboard: ['dashboardResponsable', 'dashboardProductor'],
    publishedTemplates: ['publishedTemplatesResponsable'],
    templatesWithFilters: ['templatesWithFiltersProductor'],
    producerReportsManagement: ['producerReportsManagementResponsable'],
    traceability: ['traceabilityProductor'],
    historicoDocentes: ['historicoDocentesResponsable', 'historicoDocentesProductor'],
    snies: ['sniesProductor'],
    dateReviewResponsible: ['dateReviewResponsibleProductor'],
    pdi: ['pdiResponsable'],
    pdiMine: ['pdiMineResponsable'],
    pdiDashboard: ['pdiDashboardResponsable'],
    pdiForms: ['pdiFormsResponsable'],
    pdiCharts: ['pdiChartsResponsable'],
    dependency: ['dependencyAdmin'],
    childDependenciesTemplates: ['childDependenciesTemplatesAdmin'],
    childDependenciesReports: ['childDependenciesReportsAdmin'],
};

async function main() {
    await mongoose.connect(process.env.DB_URI);
    console.log('Conectado a MongoDB:', process.env.DB_URI);

    const PositionViewPermission = require('../models/positionViewPermissions');
    const docs = await PositionViewPermission.find({});
    console.log(`Revisando ${docs.length} cargos...`);

    let tocados = 0;
    for (const doc of docs) {
        const perms = doc.permissions?.toObject ? doc.permissions.toObject() : (doc.permissions || {});
        let cambiado = false;

        for (const [oldKey, newKeys] of Object.entries(KEY_VARIANTS)) {
            const oldValue = perms[oldKey];
            if (!Array.isArray(oldValue) || oldValue.length === 0) continue;

            for (const newKey of newKeys) {
                const existing = perms[newKey];
                if (Array.isArray(existing) && existing.length > 0) continue; // ya tiene algo, no pisar
                perms[newKey] = [...oldValue];
                cambiado = true;
                console.log(`  [${doc.position}] copiando "${oldKey}" -> "${newKey}": ${JSON.stringify(oldValue)}`);
            }
        }

        if (cambiado) {
            doc.permissions = perms;
            doc.markModified('permissions');
            await doc.save();
            tocados++;
        }
    }

    console.log(`\nListo. Cargos actualizados: ${tocados} de ${docs.length}.`);
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('Error en migración:', err);
    process.exit(1);
});
