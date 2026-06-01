/**
 * Servicio de notificaciones para PDI - Indicadores
 * Envía emails cuando se sube información de indicadores
 */

const nodemailer = require('nodemailer');
const { getEmailConfig } = require('../config/emailConfig');
const User = require('../models/users');
const dayjs = require('dayjs');

const getAdministradores = async () => {
  try {
    const admins = await User.find({
      roles: 'Administrador',
      isActive: true
    }).select('email full_name').lean();
    
    return admins.map(admin => ({
      email: admin.email,
      nombre: admin.full_name
    }));
  } catch (error) {
    console.error('[PDI-UPLOAD-NOTIFY] Error obteniendo administradores:', error.message);
    return [];
  }
};

const buildEmailHtmlResponsable = (respuesta, formulario, indicador) => {
  const indicadorCodigo = indicador?.codigo || 'Sin código';
  const indicadorNombre = indicador?.nombre || 'Sin nombre';
  const formularioNombre = formulario?.nombre || 'Formulario de evidencias';
  const corteName = respuesta.corte || 'Sin corte';
  const fechaEnvio = dayjs(respuesta.fecha_envio).format('DD/MM/YYYY HH:mm');
  const liderEmail = respuesta.lider_email_aval || 'Por asignar';

  return `
    <div style="margin:0;padding:0;background:#f1f5f9;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:28px 12px;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;">
              <tr>
                <td style="background:linear-gradient(135deg,#312e81,#2563eb);padding:28px 30px;color:#ffffff;">
                  <div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">PDI - Indicadores</div>
                  <h1 style="margin:8px 0 0;font-size:28px;line-height:1.15;">Información de Indicador Subida</h1>
                  <p style="margin:12px 0 0;font-size:16px;line-height:1.5;color:#dbeafe;">
                    Se ha registrado exitosamente la información del indicador <strong>${indicadorCodigo}</strong>
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding:28px 30px;">
                  <p style="margin:0 0 14px;font-size:16px;color:#0f172a;">Hola <strong>${respuesta.respondido_por}</strong>,</p>
                  
                  <p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#334155;">
                    Tu información ha sido subida correctamente al sistema. A continuación encontrarás los detalles de tu envío.
                  </p>

                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0;border-collapse:separate;border-spacing:0;">
                    <tr>
                      <td style="padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:12px;">
                        <div style="font-size:12px;color:#64748b;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Indicador</div>
                        <div style="font-size:16px;color:#0f172a;font-weight:800;">${indicadorCodigo}</div>
                        <div style="font-size:14px;color:#475569;margin-top:4px;">${indicadorNombre}</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:12px;">
                        <div style="font-size:12px;color:#64748b;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Formulario</div>
                        <div style="font-size:16px;color:#0f172a;font-weight:800;">${formularioNombre}</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:12px;">
                        <div style="font-size:12px;color:#64748b;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Corte/Período</div>
                        <div style="font-size:16px;color:#0f172a;font-weight:800;">${corteName}</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:12px;">
                        <div style="font-size:12px;color:#64748b;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Fecha de Envío</div>
                        <div style="font-size:16px;color:#0f172a;font-weight:800;">${fechaEnvio}</div>
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:16px;background:#ecfeff;border:1px solid #a5f3fc;border-radius:12px;">
                        <div style="font-size:12px;color:#0e7490;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Estado</div>
                        <div style="font-size:16px;color:#0e7490;font-weight:800;">Pendiente de Revisión</div>
                        <div style="font-size:13px;color:#164e63;margin-top:4px;">El líder de macroproyecto revisará tu información</div>
                      </td>
                    </tr>
                  </table>

                  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px;margin:20px 0;">
                    <p style="margin:0;font-size:14px;color:#166534;">
                      ✓ Tu información ha sido registrada correctamente y está en espera de revisión por parte del líder del macroproyecto.
                    </p>
                  </div>

                  <div style="margin:24px 0;text-align:center;">
                    <a href="https://miro.unibague.edu.co/pdi/mis-indicadores" 
                       style="background-color:#2563eb;color:white;text-decoration:none;padding:13px 24px;border-radius:999px;font-size:15px;font-weight:800;display:inline-block;">
                      Ver en la Plataforma
                    </a>
                  </div>

                  <p style="font-size:14px;color:#6c757d;margin-top:20px;">
                    Si tienes preguntas sobre tu envío, contacta al equipo de Planeación.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="background:#f8fafc;padding:20px 30px;border-top:1px solid #e2e8f0;">
                  <p style="margin:0;font-size:13px;text-align:center;color:#999;">
                    Este mensaje fue generado automáticamente por MIRÓ. Por favor no responda a este correo.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
};

const buildEmailHtmlAdministrador = (respuesta, formulario, indicador) => {
  const indicadorCodigo = indicador?.codigo || 'Sin código';
  const indicadorNombre = indicador?.nombre || 'Sin nombre';
  const formularioNombre = formulario?.nombre || 'Formulario de evidencias';
  const corteName = respuesta.corte || 'Sin corte';
  const fechaEnvio = dayjs(respuesta.fecha_envio).format('DD/MM/YYYY HH:mm');
  const responsable = respuesta.respondido_por || 'Sin especificar';
  const liderEmail = respuesta.lider_email_aval || 'Por asignar';

  return `
    <div style="margin:0;padding:0;background:#f1f5f9;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:28px 12px;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;">
              <tr>
                <td style="background:linear-gradient(135deg,#312e81,#2563eb);padding:28px 30px;color:#ffffff;">
                  <div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">📊 PDI - Reporte Administrativo</div>
                  <h1 style="margin:8px 0 0;font-size:28px;line-height:1.15;">Nueva Información de Indicador</h1>
                  <p style="margin:12px 0 0;font-size:16px;line-height:1.5;color:#dbeafe;">
                    Se ha registrado información para el indicador <strong>${indicadorCodigo}</strong>
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding:28px 30px;">
                  <p style="margin:0 0 14px;font-size:16px;color:#0f172a;">Hola,</p>
                  
                  <p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#334155;">
                    Se ha registrado una nueva información de indicador en el sistema PDI. A continuación encontrarás los detalles.
                  </p>

                  <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px;border-radius:8px;margin:20px 0;">
                    <p style="margin:0;font-size:14px;color:#92400e;font-weight:700;">
                      ⚠️ Información Registrada - Pendiente de Revisión
                    </p>
                  </div>

                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0;border-collapse:collapse;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                    <tbody>
                      <tr>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;">
                          <div style="font-weight:700;color:#0f172a;font-size:14px;">Indicador</div>
                          <div style="font-size:13px;color:#475569;margin-top:4px;">${indicadorCodigo} - ${indicadorNombre}</div>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;">
                          <div style="font-weight:700;color:#0f172a;font-size:14px;">Formulario</div>
                          <div style="font-size:13px;color:#475569;margin-top:4px;">${formularioNombre}</div>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;">
                          <div style="font-weight:700;color:#0f172a;font-size:14px;">Corte/Período</div>
                          <div style="font-size:13px;color:#475569;margin-top:4px;">${corteName}</div>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;">
                          <div style="font-weight:700;color:#0f172a;font-size:14px;">Responsable</div>
                          <div style="font-size:13px;color:#475569;margin-top:4px;">${responsable}</div>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;">
                          <div style="font-weight:700;color:#0f172a;font-size:14px;">Líder de Macroproyecto</div>
                          <div style="font-size:13px;color:#475569;margin-top:4px;">${liderEmail}</div>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding:14px 16px;background:#f8fafc;">
                          <div style="font-weight:700;color:#0f172a;font-size:14px;">Fecha de Envío</div>
                          <div style="font-size:13px;color:#475569;margin-top:4px;">${fechaEnvio}</div>
                        </td>
                      </tr>
                    </tbody>
                  </table>

                  <div style="background:#f0f9ff;border:1px solid #bfdbfe;border-radius:12px;padding:16px;margin:20px 0;">
                    <p style="margin:0;font-size:14px;color:#1e40af;font-weight:700;margin-bottom:8px;">📋 Próximos Pasos:</p>
                    <ul style="margin:0;padding-left:20px;font-size:14px;color:#334155;">
                      <li style="margin-bottom:6px;">El líder del macroproyecto revisará la información</li>
                      <li style="margin-bottom:6px;">Se aprobará o rechazará según corresponda</li>
                      <li>Se notificará al responsable del resultado</li>
                    </ul>
                  </div>

                  <div style="margin:24px 0;text-align:center;">
                    <a href="https://miro.unibague.edu.co/pdi/mis-indicadores" 
                       style="background-color:#2563eb;color:white;text-decoration:none;padding:13px 24px;border-radius:999px;font-size:15px;font-weight:800;display:inline-block;">
                      Ver Detalles en la Plataforma
                    </a>
                  </div>

                  <p style="font-size:14px;color:#6c757d;margin-top:20px;">
                    Este es un reporte informativo del sistema. No requiere acción inmediata.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="background:#f8fafc;padding:20px 30px;border-top:1px solid #e2e8f0;">
                  <p style="margin:0;font-size:13px;text-align:center;color:#999;">
                    Este mensaje fue generado automáticamente por MIRÓ. Por favor no responda a este correo.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
};

const sendIndicadorUploadNotification = async (respuesta, formulario, indicador) => {
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

    const indicadorCodigo = indicador?.codigo || 'Sin código';
    const corteName = respuesta.corte || 'Sin corte';
    const subject = `📤 Información Registrada: ${indicadorCodigo} - ${corteName}`;

    // 1. Enviar email al responsable
    if (respuesta.respondido_por) {
      try {
        await transporter.sendMail({
          from: `"${emailConfig.fromName}" <${emailConfig.fromAddress}>`,
          to: respuesta.respondido_por,
          subject,
          html: buildEmailHtmlResponsable(respuesta, formulario, indicador)
        });
        console.log(`[PDI-UPLOAD-NOTIFY] ✓ Email enviado al responsable: ${respuesta.respondido_por}`);
      } catch (error) {
        console.error(`[PDI-UPLOAD-NOTIFY] ✗ Error enviando al responsable:`, error.message);
      }
    }

    // 2. Enviar email a administradores
    const administradores = await getAdministradores();
    for (const admin of administradores) {
      try {
        await transporter.sendMail({
          from: `"${emailConfig.fromName}" <${emailConfig.fromAddress}>`,
          to: admin.email,
          subject: `[ADMIN] ${subject}`,
          html: buildEmailHtmlAdministrador(respuesta, formulario, indicador)
        });
        console.log(`[PDI-UPLOAD-NOTIFY] ✓ Email enviado al administrador: ${admin.email}`);
      } catch (error) {
        console.error(`[PDI-UPLOAD-NOTIFY] ✗ Error enviando al administrador ${admin.email}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[PDI-UPLOAD-NOTIFY] Error general:', error.message);
  }
};

module.exports = {
  sendIndicadorUploadNotification
};
