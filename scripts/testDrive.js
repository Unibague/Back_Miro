require('dotenv').config();
const { uploadFile, deleteFile } = require('../services/pdiDriveStorage');

async function main() {
    console.log('🔌 Probando conexión con Google Drive...\n');

    // 1. Subir archivo de prueba en jerarquía de ejemplo
    const buffer = Buffer.from('Archivo de prueba PDI - Miro');
    const jerarquia = {
        macro:      'M2 — Redes Multidimensionales',
        proyecto:   'M2-P1 — Proyecto piloto',
        accion:     'M2-P1-A1 — Acción estratégica 1',
        indicador:  'M2-P1-A1-I1',
        corte:      '2026A',
    };

    let fileId;
    try {
        const result = await uploadFile(buffer, 'prueba_pdi.txt', 'text/plain', jerarquia);
        fileId = result.fileId;
        console.log('✅ Archivo subido correctamente');
        console.log('   ID:     ', result.fileId);
        console.log('   Ver en: ', result.webViewLink);
    } catch (e) {
        console.error('❌ Error al subir:', e.message);
        process.exit(1);
    }

    // 2. Eliminar el archivo de prueba
    try {
        await deleteFile(fileId);
        console.log('\n✅ Archivo de prueba eliminado');
    } catch (e) {
        console.error('❌ Error al eliminar:', e.message);
    }

    console.log('\n✅ Conexión con Google Drive funcionando correctamente.');
}

main();
