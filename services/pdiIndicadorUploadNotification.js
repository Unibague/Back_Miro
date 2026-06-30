/**
 * Servicio de notificaciones para PDI - Indicadores
 * Envía emails cuando se sube información de indicadores
 */

const nodemailer = require('nodemailer');
const { getEmailConfig } = require('../config/emailConfig');
const User = require('../models/users');

const buildEmailHtmlResponsable = (respuesta, indicador) => {
  const indicadorCodigo = indicador?.codigo || indicador?.code || 'Sin código';
  const indicadorNombre = indicador?.nombre || indicador?.name || 'Sin nombre';
  const corteName = respuesta.corte || 'Sin corte';

  return `
    <div style="margin:0;padding:0;background:#f5f7fa;font-family:'Segoe UI',Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fa;padding:20px 15px;">
        <tr><td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
            
            <!-- Header -->
            <tr><td style="background:#1e3a5f;padding:30px 20px;text-align:left;">
              <div style="font-size:11px;color:#8899aa;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">PDI - Sistema de Gestión</div>
              <h1 style="margin:0;font-size:20px;line-height:1.3;font-weight:600;color:#ffffff;">Información Registrada</h1>
            </td></tr>
            
            <!-- Body -->
            <tr><td style="padding:30px 20px;color:#2c3e50;line-height:1.7;">
              
              <p style="margin:0 0 20px;font-size:15px;color:#2c3e50;">Estimado colaborador,</p>
              
              <p style="margin:0 0 28px;font-size:14px;color:#475569;line-height:1.8;">
                Le informamos que su información ha sido registrada correctamente en el sistema. A continuación encontrará los detalles.
              </p>

              <!-- Status Section -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:32px 0;border-top:2px solid #e5e7eb;border-bottom:2px solid #e5e7eb;">
                <tr><td style="padding:20px 0;text-align:center;">
                  <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Estado Actual</div>
                  <div style="font-size:24px;color:#f59e0b;font-weight:700;">PENDIENTE</div>
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

              <!-- Next Steps -->
              <div style="margin:32px 0;padding:20px;background:#f0fdf4;border-left:4px solid #16a34a;border-radius:4px;">
                <div style="font-size:11px;color:#166534;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Próximos Pasos</div>
                <div style="font-size:14px;color:#166534;line-height:1.8;">
                  Su información está siendo revisada. El líder del macroproyecto evaluará los datos y notificará el resultado en breve. Puede acceder a la plataforma para monitorear el estado.
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

const buildEmailHtmlForAdmin = (respuesta, formulario, indicador, liderNombre) => {
  const indicadorCodigo = indicador?.codigo || indicador?.code || 'Sin código';
  const indicadorNombre = indicador?.nombre || indicador?.name || 'Sin nombre';
  const corteName = respuesta.corte || 'Sin corte';

  return `
    <div style="margin:0;padding:0;background:#f5f7fa;font-family:'Segoe UI',Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fa;padding:20px 15px;">
        <tr><td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
            
            <!-- Header -->
            <tr><td style="background:#1e3a5f;padding:30px 20px;text-align:left;">
              <div style="font-size:11px;color:#8899aa;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">PDI - Sistema de Gestión</div>
              <h1 style="margin:0;font-size:20px;line-height:1.3;font-weight:600;color:#ffffff;">Evaluación de Indicador</h1>
            </td></tr>
            
            <!-- Body -->
            <tr><td style="padding:30px 20px;color:#2c3e50;line-height:1.7;">
              
              <p style="margin:0 0 20px;font-size:15px;color:#2c3e50;">Estimado Administrador,</p>
              
              <p style="margin:0 0 28px;font-size:14px;color:#475569;line-height:1.8;">
                Le informamos que el líder del macroproyecto ha evaluado y aprobado un avance de indicador. A continuación encontrará los detalles para su revisión administrativa final.
              </p>

              <!-- Status Section -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:32px 0;border-top:2px solid #e5e7eb;border-bottom:2px solid #e5e7eb;">
                <tr><td style="padding:20px 0;text-align:center;">
                  <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Estado</div>
                  <div style="font-size:24px;color:#16a34a;font-weight:700;margin-bottom:20px;">APROBADO</div>
                  <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Por Evaluador</div>
                  <div style="font-size:14px;color:#2c3e50;font-weight:600;">Líder del Macroproyecto</div>
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
                <tr>
                  <td style="padding:12px 16px;border-right:1px solid #e5e7eb;border-top:1px solid #e5e7eb;width:40%;">
                    <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Evaluador</div>
                  </td>
                  <td style="padding:12px 16px;border-top:1px solid #e5e7eb;width:60%;">
                    <div style="font-size:14px;color:#475569;">${liderNombre || 'Líder del Macroproyecto'}</div>
                  </td>
                </tr>
              </table>

              <!-- Action Section -->
              <div style="margin:32px 0;padding:20px;background:#fef3c7;border-left:4px solid #f59e0b;border-radius:4px;">
                <div style="font-size:11px;color:#92400e;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Acción Requerida</div>
                <div style="font-size:14px;color:#b45309;line-height:1.8;">
                  Ingrese a la plataforma para realizar la respectiva validación de este avance. Verifique que cumpla con todos los requisitos.
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
                Mensaje automático del sistema. No responder.
              </p>
            </td></tr>

          </table>
        </td></tr>
      </table>
    </div>
  `;
};

const buildEmailHtmlForLeader = (respuesta, formulario, indicador) => {
  const indicadorCodigo = indicador?.codigo || indicador?.code || 'Sin código';
  const indicadorNombre = indicador?.nombre || indicador?.name || 'Sin nombre';
  const corteName = respuesta.corte || 'Sin corte';

  return `
    <div style="margin:0;padding:0;background:#f5f7fa;font-family:'Segoe UI',Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fa;padding:20px 15px;">
        <tr><td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
            
            <!-- Header -->
            <tr><td style="background:#1e3a5f;padding:30px 20px;text-align:left;">
              <div style="font-size:11px;color:#8899aa;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">PDI - Sistema de Gestión</div>
              <h1 style="margin:0;font-size:20px;line-height:1.3;font-weight:600;color:#ffffff;">Evaluación Pendiente</h1>
            </td></tr>
            
            <!-- Body -->
            <tr><td style="padding:30px 20px;color:#2c3e50;line-height:1.7;">
              
              <p style="margin:0 0 20px;font-size:15px;color:#2c3e50;">Estimado Líder del Macroproyecto,</p>
              
              <p style="margin:0 0 28px;font-size:14px;color:#475569;line-height:1.8;">
                Se ha registrado nueva información de indicadores que requiere su revisión y calificación. Por favor, ingrese a la plataforma para evaluar los datos adjuntos.
              </p>

              <!-- Status Section -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:32px 0;border-top:2px solid #e5e7eb;border-bottom:2px solid #e5e7eb;">
                <tr><td style="padding:20px 0;text-align:center;">
                  <div style="font-size:11px;color:#7c8fa3;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Estado</div>
                  <div style="font-size:24px;color:#f59e0b;font-weight:700;">PENDIENTE</div>
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

              <!-- Action Section -->
              <div style="margin:32px 0;padding:20px;background:#fef3c7;border-left:4px solid #f59e0b;border-radius:4px;">
                <div style="font-size:11px;color:#92400e;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Acción Requerida</div>
                <div style="font-size:14px;color:#b45309;line-height:1.8;">
                  Revise cuidadosamente los detalles del indicador y la información subida. Califique como Aprobado o Rechazado según corresponda. Agregue comentarios si lo considera necesario.
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
                Si requiere asistencia adicional, contacte al equipo de Planeación y Desarrollo Institucional.
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

const buildEmailHtmlEvaluation = (respuesta, formulario, indicador, estado, comentario) => {
  const indicadorCodigo = indicador?.codigo || indicador?.code || 'Sin código';
  const indicadorNombre = indicador?.nombre || indicador?.name || 'Sin nombre';
  const corteName = respuesta.corte || 'Sin corte';

  // Determinar colores y mensajes según el estado
  const isAprobado = estado === 'Aprobado';
  const statusColor = isAprobado ? '#16a34a' : '#dc2626';
  const statusText = isAprobado ? 'APROBADO' : 'RECHAZADO';
  const actionText = isAprobado ? 'Información Confirmada' : 'Revisar comentarios y reenviar';
  const nextStepsMessage = isAprobado 
    ? 'Su información ha sido aprobada exitosamente. El administrador lo revisará para la autorización final. Puede acceder a la plataforma para ver el estado actualizado.'
    : 'Revise cuidadosamente los comentarios del líder. Realice los ajustes necesarios en el formulario y envíelo nuevamente para su revisión. Si tiene dudas, comuníquese con el responsable del proceso.';

  return `
    <div style="margin:0;padding:0;background:#f5f7fa;font-family:'Segoe UI',Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fa;padding:20px 15px;">
        <tr><td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
            
            <!-- Header -->
            <tr><td style="background:#1e3a5f;padding:30px 20px;text-align:left;">
              <div style="font-size:11px;color:#8899aa;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">PDI - Sistema de Gestión</div>
              <h1 style="margin:0;font-size:20px;line-height:1.3;font-weight:600;color:#ffffff;">Evaluación de Indicador</h1>
            </td></tr>
            
            <!-- Body -->
            <tr><td style="padding:30px 20px;color:#2c3e50;line-height:1.7;">
              
              <p style="margin:0 0 20px;font-size:15px;color:#2c3e50;">Estimado colaborador,</p>
              
              <p style="margin:0 0 28px;font-size:14px;color:#475569;line-height:1.8;">
                Le informamos que el líder del macroproyecto ha completado la evaluación de su información. A continuación encontrará el resultado.
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
              <div style="margin:32px 0;padding:20px;background:#f0fdf4;border-left:4px solid #16a34a;border-radius:4px;">
                <div style="font-size:11px;color:#166534;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">Próximos Pasos</div>
                <div style="font-size:14px;color:#166534;line-height:1.8;">
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

    // Obtener email del productor - puede venir de respondido_por o de send_by.email
    const producerEmail = respuesta.respondido_por || respuesta.send_by?.email;

    // 1. Enviar email al responsable (quien subió la información)
    if (producerEmail) {
      try {
        await transporter.sendMail({
          from: `"${emailConfig.fromName}" <${emailConfig.fromAddress}>`,
          to: producerEmail,
          subject,
          html: buildEmailHtmlResponsable(respuesta, formulario, indicador)
        });
        console.log(`[PDI-UPLOAD-NOTIFY] ✓ Email enviado al responsable: ${producerEmail}`);
      } catch (error) {
        console.error(`[PDI-UPLOAD-NOTIFY] ✗ Error enviando al responsable:`, error.message);
      }
    } else {
      console.warn('[PDI-UPLOAD-NOTIFY] No se encontró email del productor');
    }

    // 2. Enviar email a TODOS los líderes del macroproyecto (para que revisen)
    if (respuesta.lider_email_aval && respuesta.lider_email_aval !== 'Por asignar') {
      try {
        // Obtener todos los líderes del macroproyecto del indicador
        const svc = require('./pdiFormulario');
        const lideresEmails = await svc.getLideresEmailsForIndicador(respuesta.indicador_id);
        
        if (lideresEmails && lideresEmails.length > 0) {
          // Enviar a CADA líder por separado (evita exponer emails)
          for (const liderEmail of lideresEmails) {
            try {
              await transporter.sendMail({
                from: `"${emailConfig.fromName}" <${emailConfig.fromAddress}>`,
                to: liderEmail,
                subject: `[REVISIÓN] ${subject}`,
                html: buildEmailHtmlForLeader(respuesta, formulario, indicador)
              });
              console.log(`[PDI-UPLOAD-NOTIFY] ✓ Email enviado al líder: ${liderEmail}`);
            } catch (error) {
              console.error(`[PDI-UPLOAD-NOTIFY] ✗ Error enviando al líder ${liderEmail}:`, error.message);
            }
          }
        }
      } catch (error) {
        console.error(`[PDI-UPLOAD-NOTIFY] Error obteniendo líderes:`, error.message);
      }
    }
  } catch (error) {
    console.error('[PDI-UPLOAD-NOTIFY] Error general:', error.message);
  }
};

const sendIndicadorEvaluationNotification = async (respuesta, formulario, indicador, estado, comentario) => {
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
    const statusLabel = estado === 'Aprobado' ? ' Aprobado' : ' Rechazado';
    const subject = `${statusLabel}: ${indicadorCodigo} - ${corteName}`;

    // Obtener email del productor - puede venir de respondido_por o de send_by.email
    const producerEmail = respuesta.respondido_por || respuesta.send_by?.email;

    // Email para el productor (quien subió la información)
    if (producerEmail) {
      try {
        await transporter.sendMail({
          from: `"${emailConfig.fromName}" <${emailConfig.fromAddress}>`,
          to: producerEmail,
          subject,
          html: buildEmailHtmlEvaluation(respuesta, formulario, indicador, estado, comentario)
        });
        console.log(`[PDI-EVALUATION-NOTIFY] ✓ Email enviado al productor: ${producerEmail} - Estado: ${estado}`);
      } catch (error) {
        console.error(`[PDI-EVALUATION-NOTIFY] ✗ Error enviando al productor:`, error.message);
      }
    } else {
      console.warn('[PDI-EVALUATION-NOTIFY] No se encontró email del productor');
    }

    // Enviar correo al administrador SOLO si fue aprobado
    if (estado === 'Aprobado') {
      try {
        // Obtener correos de administradores
        const User = require('../models/users');
        const admins = await User.find({ rol: 'admin' }).select('email full_name').lean();
        
        if (admins && admins.length > 0) {
          const adminEmails = admins.map(admin => admin.email).filter(Boolean);
          const liderNombre = respuesta.send_by?.full_name || respuesta.send_by?.name || 'Líder del Macroproyecto';
          
          if (adminEmails.length > 0) {
            await transporter.sendMail({
              from: `"${emailConfig.fromName}" <${emailConfig.fromAddress}>`,
              to: adminEmails.join(','),
              subject: `[APROBADO] ${indicadorCodigo} - ${corteName}`,
              html: buildEmailHtmlForAdmin(respuesta, formulario, indicador, liderNombre)
            });
            console.log(`[PDI-EVALUATION-NOTIFY] ✓ Email enviado a administradores: ${adminEmails.join(', ')}`);
          }
        }
      } catch (error) {
        console.error(`[PDI-EVALUATION-NOTIFY] ✗ Error enviando a administradores:`, error.message);
      }
    }
  } catch (error) {
    console.error('[PDI-EVALUATION-NOTIFY] Error general:', error.message);
  }
};

module.exports = {
  sendIndicadorUploadNotification,
  sendIndicadorEvaluationNotification,
  buildEmailHtmlForLeader,
  buildEmailHtmlForAdmin
};
