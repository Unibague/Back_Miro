const express = require('express');
const router = express.Router();
const qrController = require('../controllers/qrTokens');

// Requiere sesión de productor
router.post('/generate', qrController.generateToken);

// Endpoints públicos (sin autenticación)
router.get('/form/:token', qrController.getFormData);
router.post('/submit/:token', qrController.submitFormData);

module.exports = router;
