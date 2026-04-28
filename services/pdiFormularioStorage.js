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

const ALLOWED_MIMETYPES = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const fileFilter = (_req, file, cb) => {
    if (ALLOWED_MIMETYPES.has(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Solo se permiten archivos PDF o Word'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
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

module.exports = { upload, deleteFile, buildUrl, UPLOAD_DIR };
