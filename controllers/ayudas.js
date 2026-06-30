const Ayuda = require('../models/ayudas');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '../uploads/ayudas');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const unique = crypto.randomBytes(10).toString('hex');
    cb(null, `ayuda_${Date.now()}_${unique}${ext}`);
  },
});

const ALLOWED_MIMETYPES = new Set([
  'application/pdf',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
]);

const MAX_SIZE = 500 * 1024 * 1024; // 500 MB

exports.upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIMETYPES.has(file.mimetype)) return cb(null, true);
    cb(new Error('Solo se permiten archivos PDF o de video (mp4, webm, ogg, mov, avi, mkv).'));
  },
}).single('file');

exports.getAll = async (_req, res) => {
  try {
    const ayudas = await Ayuda.find().sort({ createdAt: -1 });
    res.json(ayudas);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.create = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo.' });

    const { title, description, uploadedBy } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'El título es obligatorio.' });

    const mimeType = req.file.mimetype;
    const type = mimeType === 'application/pdf' ? 'pdf' : 'video';

    const ayuda = await Ayuda.create({
      title: title.trim(),
      description: (description || '').trim(),
      type,
      filename: req.file.filename,
      originalName: req.file.originalname,
      uploadedBy: uploadedBy || 'desconocido',
      size: req.file.size,
    });

    res.status(201).json(ayuda);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.updateById = async (req, res) => {
  try {
    const { title, description } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'El título es obligatorio.' });

    const ayuda = await Ayuda.findByIdAndUpdate(
      req.params.id,
      { title: title.trim(), description: (description || '').trim() },
      { new: true }
    );
    if (!ayuda) return res.status(404).json({ error: 'Recurso no encontrado.' });
    res.json(ayuda);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.deleteById = async (req, res) => {
  try {
    const ayuda = await Ayuda.findById(req.params.id);
    if (!ayuda) return res.status(404).json({ error: 'Recurso no encontrado.' });

    const filePath = path.join(UPLOAD_DIR, ayuda.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await Ayuda.findByIdAndDelete(req.params.id);
    res.json({ status: 'Eliminado correctamente.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
