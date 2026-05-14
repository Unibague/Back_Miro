const { google } = require('googleapis');
const { Readable } = require('stream');
const path = require('path');

const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_PDI_FOLDER_ID;
const KEY_FILE = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);

function getDriveClient() {
    const auth = new google.auth.GoogleAuth({
        keyFile: KEY_FILE,
        scopes: ['https://www.googleapis.com/auth/drive'],
    });
    return google.drive({ version: 'v3', auth });
}

// Busca o crea una subcarpeta por nombre dentro de un padre
async function getOrCreateFolder(drive, nombre, parentId) {
    const res = await drive.files.list({
        q: `name='${nombre}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
        fields: 'files(id, name)',
        spaces: 'drive',
    });
    if (res.data.files.length > 0) return res.data.files[0].id;

    const created = await drive.files.create({
        requestBody: {
            name: nombre,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
        },
        fields: 'id',
    });
    return created.data.id;
}

// Resuelve (creando si no existen) las carpetas de la jerarquía PDI
// jerarquia: { macro, proyecto, accion, indicador, corte }
async function resolverJerarquia(drive, { macro, proyecto, accion, indicador, corte }) {
    let folderId = ROOT_FOLDER_ID;
    if (macro)      folderId = await getOrCreateFolder(drive, macro,      folderId);
    if (proyecto)   folderId = await getOrCreateFolder(drive, proyecto,   folderId);
    if (accion)     folderId = await getOrCreateFolder(drive, accion,     folderId);
    if (indicador)  folderId = await getOrCreateFolder(drive, indicador,  folderId);
    if (corte)      folderId = await getOrCreateFolder(drive, corte,      folderId);
    return folderId;
}

/**
 * Sube un archivo a Drive en la carpeta correspondiente a la jerarquía PDI.
 * @param {Buffer} buffer - Contenido del archivo
 * @param {string} nombreOriginal - Nombre original del archivo
 * @param {string} mimetype - MIME type del archivo
 * @param {object} jerarquia - { macro, proyecto, accion, indicador, corte }
 * @returns {{ fileId, webViewLink, webContentLink, nombre }}
 */
async function uploadFile(buffer, nombreOriginal, mimetype, jerarquia = {}) {
    const drive = getDriveClient();
    const folderId = await resolverJerarquia(drive, jerarquia);

    const res = await drive.files.create({
        requestBody: {
            name: nombreOriginal,
            parents: [folderId],
        },
        media: {
            mimeType: mimetype,
            body: Readable.from(buffer),
        },
        fields: 'id, webViewLink, webContentLink, name',
    });

    // Hacer el archivo accesible con el link (solo lectura para cualquiera con el enlace)
    await drive.permissions.create({
        fileId: res.data.id,
        requestBody: { role: 'reader', type: 'anyone' },
    });

    return {
        fileId:          res.data.id,
        webViewLink:     res.data.webViewLink,
        webContentLink:  res.data.webContentLink,
        nombre:          res.data.name,
    };
}

/**
 * Elimina un archivo de Drive por su fileId.
 */
async function deleteFile(fileId) {
    if (!fileId) return;
    try {
        const drive = getDriveClient();
        await drive.files.delete({ fileId });
    } catch (e) {
        console.error('Drive deleteFile error:', e.message);
    }
}

module.exports = { uploadFile, deleteFile, getOrCreateFolder };
