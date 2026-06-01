const express = require('express');
const router = express.Router();
const controller = require('../controllers/reminders');
const { getEmailConfig } = require('../config/emailConfig');
const nodemailer = require('nodemailer');

router.get('/', controller.getAllReminders);
router.post('/', controller.createReminder);
router.delete('/:id', controller.deleteReminder);
router.put('/:id', controller.updateReminder);
router.post('/test-send', controller.sendTestReminder);
router.get('/test-check', controller.checkAndSendReminderEmails);
router.post('/send-now', controller.sendGenericReminders);

// Endpoint para verificar la configuración de email
router.get('/test-email-config', async (req, res) => {
  try {
    const emailConfig = getEmailConfig('general');
    
    const transporter = nodemailer.createTransport({
      host: emailConfig.host,
      port: emailConfig.port,
      secure: false,
      auth: {
        user: emailConfig.username,
        pass: emailConfig.password
      },
      tls: { rejectUnauthorized: false }
    });

    await transporter.verify();
    
    res.json({
      status: 'OK',
      message: 'Configuración de email válida',
      config: {
        host: emailConfig.host,
        port: emailConfig.port,
        username: emailConfig.username,
        fromName: emailConfig.fromName,
        fromAddress: emailConfig.fromAddress
      }
    });
  } catch (error) {
    console.error('[EMAIL-CONFIG] Error:', error.message);
    res.status(500).json({
      status: 'ERROR',
      message: 'Error en la configuración de email',
      error: error.message
    });
  }
});

router.get("/reminders/preview", async (req, res) => {
  try {
    const periodId = req.query.periodId || null;
    const resultados = await controller.previewReminderEmails(periodId, true);
    res.json(resultados);
  } catch (error) {
    console.error("Error al previsualizar correos:", error);
    res.status(500).json({ error: "Error al previsualizar recordatorios." });
  }
});

module.exports = router;
