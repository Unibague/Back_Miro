const express = require('express');
const router = express.Router();
const controller = require('../controllers/publishedTemplatesFiltered');
const { requireAdmin, requireReadAccess } = require('../middleware/auth');

// Obtener TODAS las plantillas para inicializar filtros
router.get('/all', requireReadAccess, controller.getAllPublishedTemplates);

// Rutas para filtros dinámicos
router.get('/available-fields', requireReadAccess, controller.getAvailableFields);
router.get('/field-values', requireReadAccess, controller.getFieldValues);
router.get('/available-dependencies', requireReadAccess, controller.getAvailableDependencies);

// Ruta principal para plantillas filtradas
router.get('/filtered', requireReadAccess, controller.getFilteredPublishedTemplates);

module.exports = router;