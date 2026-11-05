const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/organigrama');
const { requireAdmin } = require('../middleware/auth');

// Lectura (otros módulos consumen el organigrama y sus ramas)
router.get('/',           ctrl.getAll);
router.get('/catalogos',  ctrl.getCatalogos);
router.get('/rama',       ctrl.getRama);

// Escritura: solo Administrador
router.post('/estructura-base', requireAdmin, ctrl.cargarBase);
router.post('/vincular',        requireAdmin, ctrl.vincular);
router.put('/reordenar',        requireAdmin, ctrl.reordenar);
router.post('/',                requireAdmin, ctrl.create);
router.put('/:id',              requireAdmin, ctrl.update);
router.delete('/:id',           requireAdmin, ctrl.remove);

module.exports = router;
