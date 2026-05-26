require('dotenv').config();
const { google } = require('googleapis');
const path = require('path');

async function main() {
    const keyFile = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    const driveId = process.env.DRIVE_ID;

    if (!driveId) {
        console.error('❌ DRIVE_ID no está configurado en .env');
        process.exit(1);
    }

    const auth = new google.auth.GoogleAuth({
        keyFile,
        scopes: ['https://www.googleapis.com/auth/drive'],
    });
    const drive = google.drive({ version: 'v3', auth });

    console.log('Creando carpeta raíz PDI en el Shared Drive:', driveId);

    const res = await drive.files.create({
        requestBody: {
            name: 'Evidencias MIRÓ PDI 2026',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [driveId],
            driveId: driveId,
        },
        fields: 'id, name, webViewLink',
        supportsAllDrives: true,
    });

    console.log('\n✅ Carpeta creada correctamente');
    console.log('   Nombre:', res.data.name);
    console.log('   ID:    ', res.data.id);
    console.log('   URL:   ', res.data.webViewLink);
    console.log('\n👉 Actualiza en el .env del servidor:');
    console.log(`   GOOGLE_DRIVE_PDI_FOLDER_ID=${res.data.id}`);
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
