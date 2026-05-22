const express = require('express');
const router = express.Router();
const qrController = require('../controllers/qrTokens');

// Requiere sesión de productor
router.post('/generate', qrController.generateToken);

// Verificar si una plantilla tiene QR activos
router.get('/has-qr/template/:templateId', qrController.hasActiveQrForTemplate);

// Endpoints públicos (sin autenticación)
router.get('/form/:token', qrController.getFormData);
router.post('/submit/:token', qrController.submitFormData);

module.exports = router;
