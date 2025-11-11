const express = require('express');
const router = express.Router();
const controller = require('../controllers/templateFilters');
const { requireAdmin } = require('../middleware/auth');

// Rutas públicas para obtener filtros activos
router.get('/active', controller.getActiveFilters);
router.get('/subfilter-options', controller.getSubfilterOptions);

// Rutas administrativas
router.get('/admin', requireAdmin, controller.getAllFilters);
router.post('/admin', requireAdmin, controller.createFilter);
router.put('/admin/:id', requireAdmin, controller.updateFilter);
router.delete('/admin/:id', requireAdmin, controller.deleteFilter);

module.exports = router;