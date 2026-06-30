/**
 * Servicio de notificaciones para PDI - Respuestas (Formularios)
 * Envía emails cuando se evalúan respuestas de formularios
 */

const nodemailer = require('nodemailer');
const { getEmailConfig } = require('../config/emailConfig');

const buildEmailHtmlRespuestaEvaluation = (respuesta, formulario, indicador, estado, comentario) => {
  const indicadorCodigo = indicador?.codigo || indicador?.code || 'Sin código';
  const indicadorNombre = indicador?.nombre || indicador?.name || 'Sin nombre';
  const corteName = respuesta.corte || 'Sin corte';

  // Determinar colores y mensajes según el estado
  const isAprobado = estado === 'Aprobado';
  const statusColor = isAprobado ? '#16a34a' : '#dc2626';
  const statusText = isAprobado ? 'APROBADO' : 'RECHAZADO';
  const actionText = isAprobado ? 'Información Confirmada' : 'Revisar comentarios y reenviar';
  const nextStepsMessage = isAprobado 
    ? 'Su avance ha sido aprobado exitosamente. El administrador lo revisará para la autorización final. Puede acceder a la plataforma para ver el estado actualizado.'
    : 'Revise cuidadosamente los comentarios del evaluador. Realice los ajustes necesarios en el formulario y envíelo nuevamente para su revisión. Si tiene dudas, comuníquese con el responsable del proceso.';
  const nextStepsColor = isAprobado ? '#f0fdf4' : '#f0fdf4';
  const nextStepsBorderColor = isAprobado ? '#16a34a' : '#16a34a';
  const nextStepsTextColor = isAprobado ? '#166534' : '#166534';

  return `
    <div style="margin:0;padding:0;background:#f5f7fa;font-family:'Segoe UI',Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fa;padding:20px 15px;">
        <tr><td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
            
            <!-- Header -->
            <tr><td style="background:#1e3a5f;padding:30px 20px;text-align:left;">
              <div style="font-size:11px;color:#8899aa;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">PDI - Sistema de Gestión</div>
              <h1 style="margin:0;font-size:20px;line-height:1.3;font-weight:600;color:#ffffff;">Evaluación de Formulario</h1>
            </td></tr>
            
            <!-- Body -->
            <tr><td style="padding:30px 20px;color:#2c3e50;line-height:1.7;">
              
              <p style="margin:0 0 20px;font-size:15px;color:#2c3e50;">Estimado colaborador,</p>
              
              <p style="margin:0 0 28px;font-size:14px;color:#475569;line-height:1.8;">
                Le informamos que el formulario de evaluación que usted envió ha sido revisado. A continuación encontrará el resultado de la evaluación y los detalles relevantes.
              </p>

              <!-- Status Section -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:32px 0;border-top:2px solid #e5e7eb;border-bottom:2px solid #e5e7eb;">
                <tr><td style="padding:20px 0;text-align:center;">
                  <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Estado de Evaluación</div>
                  <div style="font-size:24px;color:${statusColor};font-weight:700;margin-bottom:20px;">${statusText}</div>
                  <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Acción Requerida</div>
                  <div style="font-size:14px;color:#2c3e50;font-weight:600;">${actionText}</div>
                </td></tr>
              </table>

              <!-- Details Table -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:28px 0;border:1px solid #e5e7eb;border-radius:6px;overflow:hidden;">
                <tr style="background:#f9fafb;">
                  <td style="padding:12px 16px;border-right:1px solid #e5e7eb;width:40%;">
                    <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Indicador</div>
                  </td>
                  <td style="padding:12px 16px;width:60%;">
                    <div style="font-size:14px;color:#2c3e50;font-weight:600;">${indicadorCodigo}</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 16px;border-right:1px solid #e5e7eb;border-top:1px solid #e5e7eb;width:40%;">
                    <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Descripción</div>
                  </td>
                  <td style="padding:12px 16px;border-top:1px solid #e5e7eb;width:60%;">
                    <div style="font-size:14px;color:#475569;">${indicadorNombre}</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding:12px 16px;border-right:1px solid #e5e7eb;border-top:1px solid #e5e7eb;width:40%;">
                    <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Corte/Período</div>
                  </td>
                  <td style="padding:12px 16px;border-top:1px solid #e5e7eb;width:60%;">
                    <div style="font-size:14px;color:#475569;">${corteName}</div>
                  </td>
                </tr>
              </table>

              <!-- Comments Section -->
              ${comentario ? `
                <div style="margin:28px 0;padding:20px;background:#f9fafb;border-left:4px solid ${statusColor};border-radius:4px;">
                  <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Comentarios del Evaluador</div>
                  <div style="font-size:14px;color:#2c3e50;line-height:1.8;font-weight:500;">${comentario}</div>
                </div>
              ` : ''}

              <!-- Next Steps -->
              <div style="margin:32px 0;padding:20px;background:${nextStepsColor};border-left:4px solid ${nextStepsBorderColor};border-radius:4px;">
                <div style="font-size:11px;color:${nextStepsTextColor};font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Próximos Pasos</div>
                <div style="font-size:14px;color:${nextStepsTextColor};line-height:1.8;">
                  ${nextStepsMessage}
                </div>
              </div>

              <!-- CTA -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:32px 0;">
                <tr><td align="center">
                  <a href="https://miro.unibague.edu.co/pdi" 
                     style="background-color:#1e3a5f;color:#ffffff;text-decoration:none;padding:12px 32px;border-radius:4px;font-size:14px;font-weight:600;display:inline-block;border:none;cursor:pointer;">
                    Acceder a la Plataforma
                  </a>
                </td></tr>
              </table>

              <p style="font-size:13px;color:#7c8fa3;margin:28px 0 0;line-height:1.6;border-top:1px solid #e5e7eb;padding-top:20px;">
                Para más información comunicarse al correo: <strong>gestionpdi@unibague.edu.co</strong>
              </p>

            </td></tr>
            
            <!-- Footer -->
            <tr><td style="background:#f9fafb;padding:15px 20px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;font-size:11px;color:#999;line-height:1.6;">
                Este es un mensaje automático del sistema de gestión institucional. Por favor, no responda directamente a este correo.
              </p>
            </td></tr>

          </table>
        </td></tr>
      </table>
    </div>
  `;
};

const sendRespuestaEvaluationNotification = async (respuesta, formulario, indicador, estado, comentario) => {
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
    const statusLabel = estado === 'Aprobado' ? 'Aprobado' : 'Requiere Ajustes';
    const subject = `${statusLabel}: ${indicadorCodigo} - ${corteName}`;

    // Obtener email del responsable
    const producerEmail = respuesta.respondido_por;

    // Email para el responsable (quien envió el formulario)
    if (producerEmail) {
      try {
        await transporter.sendMail({
          from: `"${emailConfig.fromName}" <${emailConfig.fromAddress}>`,
          to: producerEmail,
          subject,
          html: buildEmailHtmlRespuestaEvaluation(respuesta, formulario, indicador, estado, comentario)
        });
        console.log(`[PDI-RESPUESTA-EVALUATION] ✓ Email enviado al responsable: ${producerEmail} - Estado: ${estado}`);
      } catch (error) {
        console.error(`[PDI-RESPUESTA-EVALUATION] ✗ Error enviando al responsable:`, error.message);
      }
    } else {
      console.warn('[PDI-RESPUESTA-EVALUATION] No se encontró email del responsable');
    }
  } catch (error) {
    console.error('[PDI-RESPUESTA-EVALUATION] Error general:', error.message);
  }
};

const buildEmailHtmlApprovedForAdmins = (respuesta, formulario, indicador, liderNombre) => {
  const indicadorCodigo = indicador?.codigo || 'Sin código';
  const indicadorNombre = indicador?.nombre || 'Sin nombre';
  const corteName = respuesta.corte || 'Sin corte';

  return `
    <div style="margin:0;padding:0;background:#f5f7fa;font-family:'Segoe UI',Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fa;padding:20px 15px;">
        <tr><td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
            
            <!-- Header -->
            <tr><td style="background:#1e3a5f;padding:30px 20px;text-align:left;">
              <div style="font-size:11px;color:#8899aa;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">PDI - Sistema de Gestión</div>
              <h1 style="margin:0;font-size:20px;line-height:1.3;font-weight:600;color:#ffffff;">Avance Evaluado y Aprobado</h1>
            </td></tr>
            
            <!-- Body -->
            <tr><td style="padding:30px 20px;color:#2c3e50;line-height:1.7;">
              
              <p style="margin:0 0 20px;font-size:15px;color:#2c3e50;">Estimado Administrador,</p>
              
              <p style="margin:0 0 28px;font-size:14px;color:#475569;line-height:1.8;">
                Le informamos que el líder del macroproyecto ha evaluado y aprobado el avance del indicador. A continuación encontrará los detalles de la información evaluada.
              </p>

              <!-- Status Section -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:32px 0;border-top:2px solid #e5e7eb;border-bottom:2px solid #e5e7eb;">
                <tr><td style="padding:20px 0;text-align:center;">
                  <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Estado</div>
                  <div style="font-size:24px;color:#16a34a;font-weight:700;">APROBADO</div>
                </td></tr>
              </table>

              <!-- Details -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:28px 0;">
                <tr>
                  <td style="padding-bottom:12px;">
                    <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Indicador</div>
                    <div style="font-size:14px;color:#2c3e50;font-weight:600;">${indicadorCodigo}</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom:12px;">
                    <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Descripción</div>
                    <div style="font-size:14px;color:#475569;">${indicadorNombre}</div>
                  </td>
                </tr>
                <tr>
                  <td style="padding-bottom:12px;">
                    <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Corte/Período</div>
                    <div style="font-size:14px;color:#475569;">${corteName}</div>
                  </td>
                </tr>
                <tr>
                  <td>
                    <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Responsable</div>
                    <div style="font-size:14px;color:#475569;">${respuesta.respondido_por || 'No especificado'}</div>
                  </td>
                </tr>
              </table>

              <!-- Action Required -->
              <div style="margin:32px 0;padding:20px;background:#fef3c7;border-left:4px solid #f59e0b;border-radius:4px;">
                <div style="font-size:11px;color:#92400e;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Acción Requerida</div>
                <div style="font-size:14px;color:#b45309;line-height:1.8;">
                  Ingrese a la plataforma para realizar la revisión administrativa final de este avance. Verifique que cumpla con todos los requisitos institucionales.
                </div>
              </div>

              <!-- CTA -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:32px 0;">
                <tr><td align="center">
                  <a href="https://miro.unibague.edu.co/pdi" 
                     style="background-color:#1e3a5f;color:#ffffff;text-decoration:none;padding:12px 32px;border-radius:4px;font-size:14px;font-weight:600;display:inline-block;border:none;cursor:pointer;">
                    Acceder a la Plataforma
                  </a>
                </td></tr>
              </table>

              <p style="font-size:13px;color:#7c8fa3;margin:28px 0 0;line-height:1.6;border-top:1px solid #e5e7eb;padding-top:20px;">
                Este es un mensaje del sistema de gestión institucional. Por favor, no responda directamente a este correo.
              </p>

            </td></tr>
            
            <!-- Footer -->
            <tr><td style="background:#f9fafb;padding:15px 20px;border-top:1px solid #e5e7eb;text-align:center;">
              <p style="margin:0;font-size:11px;color:#999;line-height:1.6;">
                Mensaje automático del sistema. No responder.
              </p>
            </td></tr>

          </table>
        </td></tr>
      </table>
    </div>
  `;
};

const sendRespuestaApprovedToAdmins = async (respuesta, formulario, indicador, liderNombre, adminEmails) => {
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
    const subject = `[EVALUACIÓN] Formulario Aprobado por Líder: ${indicadorCodigo}`;

    if (adminEmails && adminEmails.length > 0) {
      try {
        await transporter.sendMail({
          from: `"${emailConfig.fromName}" <${emailConfig.fromAddress}>`,
          to: adminEmails.join(','),
          subject,
          html: buildEmailHtmlApprovedForAdmins(respuesta, formulario, indicador, liderNombre)
        });
        console.log(`[PDI-RESPUESTA-APPROVED] ✓ Email enviado a administradores: ${adminEmails.join(', ')}`);
      } catch (error) {
        console.error(`[PDI-RESPUESTA-APPROVED] ✗ Error enviando a administradores:`, error.message);
      }
    }
  } catch (error) {
    console.error('[PDI-RESPUESTA-APPROVED] Error general:', error.message);
  }
};

module.exports = {
  sendRespuestaEvaluationNotification,
  buildEmailHtmlRespuestaEvaluation,
  sendRespuestaApprovedToAdmins,
  buildEmailHtmlApprovedForAdmins
};
