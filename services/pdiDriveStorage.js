const { google } = require('googleapis');
const { Readable } = require('stream');
const path = require('path');

const getRootFolderId = () => {
    const rootFolderId = process.env.GOOGLE_DRIVE_PDI_FOLDER_ID;
    if (!rootFolderId) {
        throw new Error('GOOGLE_DRIVE_PDI_FOLDER_ID no esta configurado.');
    }
    return rootFolderId;
};

const getKeyFile = () => {
    const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!keyFile) {
        throw new Error('GOOGLE_APPLICATION_CREDENTIALS no esta configurado.');
    }
    return path.resolve(keyFile);
};

const escapeDriveQueryValue = (value) =>
    String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function getDriveClient() {
    const auth = new google.auth.GoogleAuth({
        keyFile: getKeyFile(),
        scopes: ['https://www.googleapis.com/auth/drive'],
    });
    return google.drive({ version: 'v3', auth });
}

// Busca o crea una subcarpeta por nombre dentro de un padre
async function getOrCreateFolder(drive, nombre, parentId) {
    const folderName = String(nombre ?? '').trim();
    if (!folderName) return parentId;

    const res = await drive.files.list({
        q: `name='${escapeDriveQueryValue(folderName)}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
        fields: 'files(id, name)',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
    });
    if (res.data.files.length > 0) return res.data.files[0].id;

    const created = await drive.files.create({
        requestBody: {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
        },
        fields: 'id',
        supportsAllDrives: true,
    });
    return created.data.id;
}

// Resuelve (creando si no existen) las carpetas de la jerarquía PDI
// jerarquia: { macro, proyecto, accion, indicador, corte }
async function resolverJerarquia(drive, { macro, proyecto, accion, indicador, corte }) {
    let folderId = getRootFolderId();
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
        supportsAllDrives: true,
    });

    // Hacer el archivo accesible con el link (solo lectura para cualquiera con el enlace)
    try {
        await drive.permissions.create({
            fileId: res.data.id,
            requestBody: { role: 'reader', type: 'anyone' },
            supportsAllDrives: true,
        });
    } catch (e) {
        console.warn('Drive permissions warning:', e.message);
    }

    return {
        fileId:          res.data.id,
        webViewLink:     res.data.webViewLink,
        webContentLink:  res.data.webContentLink,
        nombre:          res.data.name,
    };
}

// En unidades compartidas la cuenta de servicio no siempre puede borrar
// definitivamente; en ese caso se envía a la papelera para que deje de verse.
async function removeFile(drive, fileId) {
    if (!fileId) return;
    try {
        await drive.files.delete({ fileId, supportsAllDrives: true });
    } catch (e) {
        try {
            await drive.files.update({ fileId, requestBody: { trashed: true }, supportsAllDrives: true });
        } catch (trashErr) {
            console.error('Drive removeFile error:', trashErr.message);
        }
    }
}

/**
 * Elimina un archivo de Drive por su fileId.
 */
async function deleteFile(fileId) {
    if (!fileId) return;
    try {
        await removeFile(getDriveClient(), fileId);
    } catch (e) {
        console.error('Drive deleteFile error:', e.message);
    }
}

/**
 * Sube un reporte garantizando que en la carpeta solo quede la ÚLTIMA versión:
 * si ya existe un archivo con el mismo nombre se reemplaza su contenido (mismo
 * fileId y mismo enlace), y cualquier copia duplicada o versión anterior en otra
 * carpeta (previousFileId) se elimina.
 */
async function uploadOrReplaceFile(buffer, nombre, mimetype, jerarquia = {}, { previousFileId = '' } = {}) {
    const drive = getDriveClient();
    const folderId = await resolverJerarquia(drive, jerarquia);

    const existing = await drive.files.list({
        q: `name='${escapeDriveQueryValue(nombre)}' and '${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`,
        fields: 'files(id, modifiedTime)',
        orderBy: 'modifiedTime desc',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
    });
    const files = existing.data.files || [];
    const target = files.find((f) => f.id === previousFileId) || files[0] || null;

    let result = null;
    if (target) {
        try {
            const res = await drive.files.update({
                fileId: target.id,
                media: { mimeType: mimetype, body: Readable.from(buffer) },
                fields: 'id, webViewLink, webContentLink, name',
                supportsAllDrives: true,
            });
            result = {
                fileId: res.data.id,
                webViewLink: res.data.webViewLink,
                webContentLink: res.data.webContentLink,
                nombre: res.data.name,
            };
        } catch (e) {
            console.warn('Drive update warning, se crea un archivo nuevo:', e.message);
        }
    }
    if (!result) result = await uploadFile(buffer, nombre, mimetype, jerarquia);

    const obsoletos = new Set(files.map((f) => f.id));
    if (previousFileId) obsoletos.add(previousFileId);
    obsoletos.delete(result.fileId);
    for (const fileId of obsoletos) await removeFile(drive, fileId);

    return result;
}

module.exports = { uploadFile, uploadOrReplaceFile, deleteFile, getOrCreateFolder, resolverJerarquia, getDriveClient };
