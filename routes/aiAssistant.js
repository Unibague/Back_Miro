const express = require('express');
const router = express.Router();
const controller = require('../controllers/aiAssistant');

// Chat con el asistente
router.post('/chat', controller.chat);

// Analizar documento
router.post('/analyze-document', controller.upload.single('file'), controller.analyzeDocument);

// Generar Word con IA
router.post('/generate-word', controller.generateWord);

// Generar Excel con IA
router.post('/generate-excel', controller.generateExcel);

router.post('/generate-pdf', controller.generatePDF);

// Verificar estado del servicio
router.get('/health', controller.health);

module.exports = router;
