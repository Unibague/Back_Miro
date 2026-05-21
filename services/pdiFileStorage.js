const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '../uploads/pdi');
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

// Crear carpeta si no existe
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const ext      = path.extname(file.originalname);
        const unique   = crypto.randomBytes(10).toString('hex');
        const ts       = Date.now();
        cb(null, `pdi_${ts}_${unique}${ext}`);
    },
});

const ALLOWED_PDF_MIMETYPES = new Set([
    'application/pdf',
    'application/x-pdf',
    'application/octet-stream',
    'binary/octet-stream',
]);

const fileFilter = (_req, file, cb) => {
    const isPdf = ALLOWED_PDF_MIMETYPES.has(file.mimetype) ||
                  file.originalname.toLowerCase().endsWith('.pdf');
    if (isPdf) {
        cb(null, true);
    } else {
        cb(new Error('Solo se permiten archivos PDF'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

/**
 * Elimina un archivo del disco dado su nombre almacenado.
 * @param {string} filename  — nombre del archivo (no la ruta completa)
 */
const deleteFile = (filename) => {
    const filePath = path.join(UPLOAD_DIR, filename);
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
};

/**
 * Construye la URL pública del archivo.
 * @param {string} filename
 * @returns {string}
 */
const buildUrl = (filename) => {
    const base = process.env.NEXT_PUBLIC_API_URL?.replace('/api/p', '').replace('/api/d', '') 
              || `http://localhost:${process.env.PORT || 3456}`;
    return `${base}/uploads/pdi/${filename}`;
};

module.exports = { upload, deleteFile, buildUrl, UPLOAD_DIR, MAX_FILE_SIZE_BYTES };
