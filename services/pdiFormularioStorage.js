const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '../uploads/pdi/formularios');

if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const ext    = path.extname(file.originalname);
        const unique = crypto.randomBytes(10).toString('hex');
        const ts     = Date.now();
        cb(null, `form_${ts}_${unique}${ext}`);
    },
});

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIMETYPES = new Set([
    'application/pdf',
    'application/x-pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'image/jpeg',
    'image/png',
    'image/tiff',
    'application/zip',
    'application/x-zip-compressed',
    'application/x-rar-compressed',
    'application/vnd.rar',
    'application/x-7z-compressed',
    'application/x-tar',
    'application/gzip',
]);

const ALLOWED_BINARY_MIMETYPES = new Set([
    'application/octet-stream',
    'binary/octet-stream',
]);
const ALLOWED_EXTENSIONS = new Set([
    '.pdf', '.xlsx', '.xls', '.jpg', '.jpeg', '.png',
    '.tif', '.tiff', '.zip', '.rar', '.7z', '.tar', '.gz',
]);

const fileFilter = (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = ALLOWED_MIMETYPES.has(file.mimetype) ||
        (ALLOWED_BINARY_MIMETYPES.has(file.mimetype) && ALLOWED_EXTENSIONS.has(ext)) ||
        ALLOWED_EXTENSIONS.has(ext);
    if (allowed) {
        cb(null, true);
    } else {
        cb(new Error('Solo se permiten PDF, Excel (.xlsx, .xls), imágenes (.jpg, .jpeg, .png, .tif) y comprimidos (.zip, .rar, .7z, .tar, .gz)'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: MAX_FILE_SIZE_BYTES },
});

const deleteFile = (filename) => {
    const filePath = path.join(UPLOAD_DIR, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
};

const buildUrl = (filename) => {
    const base = process.env.NEXT_PUBLIC_API_URL?.replace('/api/p', '').replace('/api/d', '')
              || `http://localhost:${process.env.PORT || 3456}`;
    return `${base}/uploads/pdi/formularios/${filename}`;
};

module.exports = { upload, deleteFile, buildUrl, UPLOAD_DIR, MAX_FILE_SIZE_BYTES };
