const express = require('express');
const router = express.Router();
const controller = require('../controllers/aiAssistant');

// Chat con el asistente
router.post('/chat', controller.chat);

// Analizar documento
router.post('/analyze-document', controller.upload.single('file'), controller.analyzeDocument);

// Verificar estado del servicio
router.get('/health', controller.health);

module.exports = router;
