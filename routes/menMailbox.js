const express = require('express');
const router = express.Router();
const controller = require('../controllers/menMailbox');
const { requireAdmin } = require('../middleware/auth');

router.get('/', requireAdmin, controller.getAll);
router.get('/programas', requireAdmin, controller.getProgramas);
router.get('/plantillas', requireAdmin, controller.getPlantillas);
router.put('/plantillas/:clave', requireAdmin, controller.updatePlantilla);
router.post('/vista-previa', requireAdmin, controller.vistaPrevia);
router.get('/automatico', requireAdmin, controller.getAutomatico);
router.post('/enviar', requireAdmin, controller.enviar);
router.post('/enviar-general', requireAdmin, controller.enviar);

module.exports = router;
