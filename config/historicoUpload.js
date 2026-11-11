const multer = require("multer");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

// Carga de archivos de Consulta de Información: se escriben a disco por
// streaming (nunca en memoria), con nombre único para que dos cargas
// simultáneas del mismo archivo no se pisen. Límite configurable con
// HISTORICO_MAX_UPLOAD_MB (por defecto 2 GB: el archivo ocupa 2-3 veces su
// tamaño en disco mientras se procesa y MongoDB está en el mismo disco).
const MAX_UPLOAD_MB = Number(process.env.HISTORICO_MAX_UPLOAD_MB) || 2048;

const historicoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, os.tmpdir()),
    filename: (req, file, cb) =>
      cb(null, `historico-${Date.now()}-${crypto.randomBytes(6).toString("hex")}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// Igual que historicoUpload.single(field), pero responde 413 en JSON cuando
// el archivo supera el límite (en vez del error HTML por defecto de Express).
const singleFile = (field) => (req, res, next) => {
  // Las cargas grandes pueden tardar más que el timeout general del servidor.
  req.setTimeout(0);
  historicoUpload.single(field)(req, res, (error) => {
    if (!error) return next();
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ message: `El archivo supera el tamaño máximo permitido (${MAX_UPLOAD_MB} MB).` });
    }
    return res.status(400).json({ message: "No se pudo recibir el archivo.", error: error.message });
  });
};

module.exports = { singleFile, MAX_UPLOAD_MB };
