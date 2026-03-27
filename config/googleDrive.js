const { drive } = require("@googleapis/drive");
const { GoogleAuth } = require("google-auth-library");
const fs = require("fs");
const path = require("path");

const driveId = process.env.DRIVE_ID;

const auth = new GoogleAuth({
  keyFile: path.join(__dirname, "../google-credentials.json"),
  scopes: "https://www.googleapis.com/auth/drive",
});

const driveService = drive({
  version: "v3",
  auth: auth,
});

const mutex = {};

const getOrCreateFolder = async (folderName, parentId, folderId = null) => {
  // Usa el folderId directamente si está disponible
  if (folderId) {
    return folderId;
  }

  // Si no hay folderId, realiza la búsqueda en Google Drive
  const query = `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`;
  const res = await driveService.files.list({
    q: query,
    fields: "files(id, name)",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  } else {
    const folderMetadata = {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    };

    const folder = await driveService.files.create({
      resource: folderMetadata,
      fields: "id",
      supportsAllDrives: true,
    });

    return folder.data.id;
  }
};

const getOrCreateFolderWithLock = async (folderName, parentId, folderId = null) => {
  const key = `${parentId}/${folderName}`;
  if (!mutex[key]) {
    mutex[key] = new Promise(async (resolve, reject) => {
      try {
        const id = await getOrCreateFolder(folderName, parentId, folderId);
        resolve(id);
      } catch (error) {
        reject(error);
      } finally {
        delete mutex[key];
      }
    });
  }
  return mutex[key];
};

const uploadFileToGoogleDrive = async (file, destinationPath, name, folderId = null) => {
  const folders = destinationPath.split("/");
  let parentId = driveId;
  let ancestorId;

  for (let i = 0; i < folders.length; i++) {
    parentId = await getOrCreateFolderWithLock(folders[i], parentId, folderId);
    if (i === folders.length - 2) {
      ancestorId = parentId;
    }
  }

  const fileMetadata = {
    name: Buffer.from(name, "latin1").toString("utf8"),
    parents: [parentId],
    driveId,
    supportsAllDrives: true,
  };

  const media = {
    mimeType: file.mimetype,
    body: fs.createReadStream(file.path),
  };

  const response = await driveService.files.create({
    resource: fileMetadata,
    media: media,
    fields: "id, name, webViewLink, webContentLink, parents",
    supportsAllDrives: true,
  });

  return { ...response.data, reportFolderId: ancestorId, description: file.description };
};

const uploadFilesToGoogleDrive = async (files, destinationPath, folderId = null) => {
  const folders = destinationPath.split("/");
  let parentId = driveId;

  // Asegúrate de que la carpeta destino esté creada antes de cargar los archivos
  for (let i = 0; i < folders.length; i++) {
    parentId = await getOrCreateFolderWithLock(folders[i], parentId, folderId);
  }

  const uploadPromises = files.map((file) =>
    uploadFileToGoogleDrive(file, destinationPath, file.originalname, folderId)
  );
  const filesData = await Promise.all(uploadPromises);
  return filesData;
};

const updateFileInGoogleDrive = async (fileId, file, newFileName) => {
  try {
    const fileMetadata = {
      name: Buffer.from(newFileName, "latin1").toString("utf8"), // Actualizar el nombre si es necesario
    };

    const media = {
      mimeType: file.mimetype,
      body: fs.createReadStream(file.path),
    };

    const response = await driveService.files.update({
      fileId: fileId,
      resource: fileMetadata,
      media: media,
      name: newFileName,
      fields: "id, name, webViewLink, webContentLink",
      supportsAllDrives: true,
    });

    return response.data;
  } catch (error) {
    console.error("Error updating file:", error);
    throw error;
  }
};

const moveDriveFolder = async (folderId, destinationPath, parentFolderId = null) => {
  const folders = destinationPath.split("/");
  let newParentId = driveId;
  let ancestorId;

  for (let i = 0; i < folders.length - 1; i++) {
    newParentId = await getOrCreateFolderWithLock(folders[i], newParentId, parentFolderId);
    if (i === folders.length - 3) {
      ancestorId = newParentId;
    }
  }

  const file = await driveService.files.get({
    fileId: folderId,
    fields: 'parents',
    supportsAllDrives: true,
  });

  const currentParents = file.data.parents;

  await driveService.files.update({
    fileId: folderId,
    name: folders[folders.length - 1],
    addParents: newParentId,
    removeParents: currentParents.join(','),
    fields: "parents",
    supportsAllDrives: true,
  });

  return ancestorId;
};

const deleteDriveFile = async (fileId) => {
  try {
    await driveService.files.delete({
      fileId,
      supportsAllDrives: true,
    });
  } catch (error) {
    console.error(`Error deleting file ${fileId}:`, error);
  }
};

const deleteDriveFiles = async (fileIds) => {
  try {
    const deletePromises = fileIds.map((fileId) => deleteDriveFile(fileId));
    await Promise.all(deletePromises);
  } catch (error) {
    console.error("Error deleting files:", error);
  }
};

const downloadDriveFileBuffer = async (fileId) => {
  const response = await driveService.files.get(
    {
      fileId,
      alt: "media",
      supportsAllDrives: true,
    },
    { responseType: "arraybuffer" }
  );

  return Buffer.from(response.data);
};

module.exports = {
  uploadFileToGoogleDrive,
  uploadFilesToGoogleDrive,
  moveDriveFolder,
  deleteDriveFile,
  deleteDriveFiles,
  updateFileInGoogleDrive,
  downloadDriveFileBuffer
};
