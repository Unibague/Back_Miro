const express = require('express');
const router = express.Router();
const controller = require('../controllers/publishedTemplatesFiltered');
const { requireAdmin } = require('../middleware/auth');

// Obtener TODAS las plantillas para inicializar filtros
router.get('/all', requireAdmin, controller.getAllPublishedTemplates);

// Rutas para filtros dinámicos
router.get('/available-fields', requireAdmin, controller.getAvailableFields);
router.get('/field-values', requireAdmin, controller.getFieldValues);
router.get('/available-dependencies', requireAdmin, controller.getAvailableDependencies);

// Ruta principal para plantillas filtradas
router.get('/filtered', requireAdmin, controller.getFilteredPublishedTemplates);

module.exports = router;