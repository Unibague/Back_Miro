const nodemailer = require('nodemailer');
const MenMailbox = require('../models/menMailbox');
const { getEmailConfig } = require('../config/emailConfig');

const menMailboxController = {};

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** El cuerpo llega como texto plano desde el editor; se respetan los saltos de línea. */
const cuerpoAHtml = (cuerpo) => `
  <div style="font-family: Arial, sans-serif; font-size: 14px; color: #212529; line-height: 1.5;">
    ${escapeHtml(cuerpo).replace(/\r?\n/g, '<br>')}
  </div>`;

/* GET /men-mailbox — historial de mensajes enviados */
menMailboxController.getAll = async (req, res) => {
  try {
    const mensajes = await MenMailbox.find().sort({ createdAt: -1 }).lean();
    res.status(200).json(mensajes);
  } catch (error) {
    console.error('Error obteniendo buzón MEN:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

const TIPOS_MENSAJE = ['general', 'administradores', 'responsables'];

/* POST /men-mailbox/enviar — recordatorio general, a administradores o a responsables.
 * Por ahora (modo prueba) todos los tipos se envían solo al administrador que los dispara;
 * el envío a los destinatarios reales de cada tipo se implementa más adelante. */
menMailboxController.enviar = async (req, res) => {
  const asunto = String(req.body.asunto ?? '').trim();
  const cuerpo = String(req.body.cuerpo ?? '').trim();
  const tipo = TIPOS_MENSAJE.includes(req.body.tipo) ? req.body.tipo : 'general';
  if (!asunto || !cuerpo) {
    return res.status(400).json({ error: 'El asunto y el cuerpo son obligatorios' });
  }

  const destinatarios = [req.user.email];
  const registro = { tipo, asunto, cuerpo, destinatarios, enviado_por: req.user.email };

  try {
    const emailConfig = getEmailConfig('general');
    const transporter = nodemailer.createTransport({
      host: emailConfig.host,
      port: emailConfig.port,
      secure: false,
      auth: { user: emailConfig.username, pass: emailConfig.password },
      tls: { rejectUnauthorized: false },
    });

    await transporter.sendMail({
      from: `"${emailConfig.fromName}" <${emailConfig.fromAddress || emailConfig.username}>`,
      to: destinatarios.join(', '),
      subject: asunto,
      html: cuerpoAHtml(cuerpo),
    });

    const mensaje = await MenMailbox.create({ ...registro, estado: 'enviado' });
    res.status(201).json(mensaje);
  } catch (error) {
    console.error('Error enviando mensaje del buzón MEN:', error);
    const mensaje = await MenMailbox.create({ ...registro, estado: 'error', error: error.message }).catch(() => null);
    res.status(500).json({ error: 'No se pudo enviar el mensaje', detalle: error.message, mensaje });
  }
};

module.exports = menMailboxController;
