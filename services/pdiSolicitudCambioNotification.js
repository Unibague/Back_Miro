/**
 * Servicio de notificaciones para solicitudes de cambio PDI
 * Envía emails cuando se solicita un cambio
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
    console.error('[PDI-CAMBIO-NOTIFY] Error obteniendo administradores:', error.message);
    return [];
  }
};

const buildEmailHtmlAdministrador = (solicitud) => {
  const tiposCambio = {
    'alcance': 'Alcance',
    'meta': 'Meta',
    'cronograma': 'Cronograma',
    'presupuesto': 'Presupuesto',
    'responsable': 'Responsable',
    'otro': 'Otro'
  };

  const tiposEntidad = {
    'macroproyecto': 'Macroproyecto',
    'proyecto': 'Proyecto',
    'accion': 'Acción Estratégica',
    'indicador': 'Indicador'
  };

  const tipoCambioLabel = tiposCambio[solicitud.tipo_cambio] || solicitud.tipo_cambio;
  const tipoEntidadLabel = tiposEntidad[solicitud.entidad_tipo] || solicitud.entidad_tipo;
  const fechaSolicitud = dayjs(solicitud.fecha_solicitud).format('DD/MM/YYYY HH:mm');

  return `
    <div style="margin:0;padding:0;background:#f1f5f9;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:28px 12px;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;">
              <tr>
                <td style="background:linear-gradient(135deg,#312e81,#2563eb);padding:28px 30px;color:#ffffff;">
                  <div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">📋 PDI - Solicitud de Cambio</div>
                  <h1 style="margin:8px 0 0;font-size:28px;line-height:1.15;">Nueva Solicitud de Cambio</h1>
                  <p style="margin:12px 0 0;font-size:16px;line-height:1.5;color:#dbeafe;">
                    Se requiere tu revisión y aprobación
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding:28px 30px;">
                  <p style="margin:0 0 14px;font-size:16px;color:#0f172a;">Hola,</p>
                  
                  <p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#334155;">
                    Se ha recibido una nueva solicitud de cambio en el PDI que requiere tu revisión y aprobación.
                  </p>

                  <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:16px;border-radius:8px;margin:20px 0;">
                    <p style="margin:0;font-size:14px;color:#92400e;font-weight:700;">
                      ⚠️ Estado: Pendiente de Revisión
                    </p>
                  </div>

                  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:20px 0;border-collapse:collapse;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
                    <tbody>
                      <tr>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;width:40%;font-weight:700;color:#0f172a;font-size:13px;">Tipo de Cambio</td>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;color:#475569;font-size:14px;">${tipoCambioLabel}</td>
                      </tr>
                      <tr>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;font-weight:700;color:#0f172a;font-size:13px;">Entidad Afectada</td>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;color:#475569;font-size:14px;">${tipoEntidadLabel}</td>
                      </tr>
                      <tr>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;font-weight:700;color:#0f172a;font-size:13px;">Código/Nombre</td>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;color:#475569;font-size:14px;">${solicitud.entidad_codigo || solicitud.entidad_nombre || 'N/A'}</td>
                      </tr>
                      <tr>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;font-weight:700;color:#0f172a;font-size:13px;">Solicitado por</td>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;color:#475569;font-size:14px;">${solicitud.solicitado_por}</td>
                      </tr>
                      <tr>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;font-weight:700;color:#0f172a;font-size:13px;">Email</td>
                        <td style="padding:14px 16px;border-bottom:1px solid #e2e8f0;background:#f8fafc;color:#475569;font-size:14px;">${solicitud.solicitado_email}</td>
                      </tr>
                      <tr>
                        <td style="padding:14px 16px;background:#f8fafc;font-weight:700;color:#0f172a;font-size:13px;">Fecha</td>
                        <td style="padding:14px 16px;background:#f8fafc;color:#475569;font-size:14px;">${fechaSolicitud}</td>
                      </tr>
                    </tbody>
                  </table>

                  <div style="background:#f0f9ff;border:1px solid #bfdbfe;border-radius:12px;padding:16px;margin:20px 0;">
                    <p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#1e40af;">📝 Descripción del Cambio:</p>
                    <p style="margin:0;font-size:14px;color:#334155;line-height:1.6;">${solicitud.descripcion}</p>
                  </div>

                  ${solicitud.justificacion ? `
                  <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:12px;padding:16px;margin:20px 0;">
                    <p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#166534;">💡 Justificación:</p>
                    <p style="margin:0;font-size:14px;color:#334155;line-height:1.6;">${solicitud.justificacion}</p>
                  </div>
                  ` : ''}

                  ${solicitud.valor_anterior || solicitud.valor_propuesto ? `
                  <div style="background:#fef3c7;border:1px solid #fde68a;border-radius:12px;padding:16px;margin:20px 0;">
                    <p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#92400e;">🔄 Cambio Propuesto:</p>
                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                      <tr>
                        <td style="width:50%;padding:12px;background:#fee2e2;border-radius:8px;margin-right:8px;border:1px solid #fecaca;">
                          <div style="font-weight:700;color:#991b1b;font-size:13px;margin-bottom:4px;">Valor Anterior</div>
                          <div style="color:#334155;font-size:14px;">${solicitud.valor_anterior || 'N/A'}</div>
                        </td>
                        <td style="width:50%;padding:12px;background:#dcfce7;border-radius:8px;border:1px solid #bbf7d0;">
                          <div style="font-weight:700;color:#166534;font-size:13px;margin-bottom:4px;">Valor Propuesto</div>
                          <div style="color:#334155;font-size:14px;">${solicitud.valor_propuesto || 'N/A'}</div>
                        </td>
                      </tr>
                    </table>
                  </div>
                  ` : ''}

                  <div style="background:#f3f4f6;border:1px solid #d1d5db;border-radius:12px;padding:16px;margin:20px 0;">
                    <p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#374151;">📋 Próximos Pasos:</p>
                    <ul style="margin:0;padding-left:20px;font-size:14px;color:#334155;">
                      <li style="margin-bottom:6px;">Revisa los detalles de la solicitud</li>
                      <li style="margin-bottom:6px;">Aprueba o rechaza según corresponda</li>
                      <li>Se notificará al solicitante del resultado</li>
                    </ul>
                  </div>

                  <div style="margin:24px 0;text-align:center;">
                    <a href="https://miro.unibague.edu.co/pdi/cambios" 
                       style="background-color:#2563eb;color:white;text-decoration:none;padding:13px 24px;border-radius:999px;font-size:15px;font-weight:800;display:inline-block;">
                      Revisar Solicitud
                    </a>
                  </div>

                  <p style="font-size:14px;color:#6c757d;margin-top:20px;">
                    Por favor, revisa esta solicitud en la plataforma Miró y aprueba o rechaza según corresponda.
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

const sendSolicitudCambioNotification = async (solicitud) => {
  try {
    const administradores = await getAdministradores();
    
    if (administradores.length === 0) {
      console.log('[PDI-CAMBIO-NOTIFY] No hay administradores activos para notificar');
      return;
    }

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

    const tiposCambio = {
      'alcance': 'Alcance',
      'meta': 'Meta',
      'cronograma': 'Cronograma',
      'presupuesto': 'Presupuesto',
      'responsable': 'Responsable',
      'otro': 'Otro'
    };

    const tipoCambioLabel = tiposCambio[solicitud.tipo_cambio] || solicitud.tipo_cambio;
    const subject = `📋 Nueva Solicitud de Cambio: ${tipoCambioLabel} - ${solicitud.entidad_codigo || solicitud.entidad_nombre}`;

    for (const admin of administradores) {
      try {
        await transporter.sendMail({
          from: `"${emailConfig.fromName}" <${emailConfig.fromAddress}>`,
          to: admin.email,
          subject,
          html: buildEmailHtmlAdministrador(solicitud)
        });
        console.log(`[PDI-CAMBIO-NOTIFY] ✓ Email enviado a ${admin.email}`);
      } catch (error) {
        console.error(`[PDI-CAMBIO-NOTIFY] ✗ Error enviando a ${admin.email}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[PDI-CAMBIO-NOTIFY] Error general:', error.message);
  }
};

module.exports = {
  sendSolicitudCambioNotification
};
