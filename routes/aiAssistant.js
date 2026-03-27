const express = require('express');
const router = express.Router();
const controller = require('../controllers/aiAssistant');

// Chat con el asistente
router.post('/chat', controller.chat);

// Verificar estado del servicio
router.get('/health', controller.health);

module.exports = router;
