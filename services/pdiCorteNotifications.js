const nodemailer = require('nodemailer');
const Proyecto = require('../models/pdiProyecto');
const User = require('../models/users');

const DEFAULT_FROM_ADDRESS = 'gestionpdi@unibague.edu.co';
const DEFAULT_FROM_NAME = 'Gestión PDI';
const DEFAULT_PLATFORM_URL = 'https://miro.unibague.edu.co';

const cleanEnv = (value) => String(value || '').trim();
const cleanPassword = (value) => String(value || '').replace(/\s/g, '');
const cleanEmail = (value) => String(value || '').trim().toLowerCase();

const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail(value));

const normalizePersonName = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatDate = (value) => {
    if (!value) return 'Sin fecha definida';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Sin fecha definida';
    return new Intl.DateTimeFormat('es-CO', {
        timeZone: 'America/Bogota',
        day: '2-digit',
        month: 'long',
        year: 'numeric',
    }).format(date);
};

const getPlatformUrl = () => (
    process.env.PDI_FRONTEND_URL
    || process.env.FRONTEND_URL
    || process.env.NEXT_PUBLIC_FRONTEND_URL
    || process.env.APP_URL
    || DEFAULT_PLATFORM_URL
).replace(/\/+$/, '');

const getSmtpConfig = () => {
    const user = cleanEnv(
        process.env.PDI_EMAIL_USERNAME
        || process.env.SMTP_USER
        || process.env.REMINDER_EMAIL
    );
    const pass = cleanPassword(
        process.env.PDI_EMAIL_PASSWORD
        || process.env.SMTP_PASS
        || process.env.REMINDER_PASS
    );
    const host = cleanEnv(
        process.env.PDI_EMAIL_HOST
        || process.env.SMTP_HOST
    ) || 'smtp.gmail.com';
    const port = Number(cleanEnv(
        process.env.PDI_EMAIL_PORT
        || process.env.SMTP_PORT
    ) || 587);
    const secure = String(process.env.PDI_SMTP_SECURE || process.env.SMTP_SECURE || '').toLowerCase() === 'true';

    console.log('[PDI-SMTP] Config leída:', { host, port, secure, user: user || '(vacío)' });

    if (!user || !pass) {
        throw new Error('Credenciales SMTP no configuradas: define PDI_EMAIL_USERNAME/PDI_EMAIL_PASSWORD en el .env.');
    }
    if (!Number.isInteger(port) || port <= 0) {
        throw new Error('PDI_EMAIL_PORT no es valido. Usa 587 para STARTTLS o 465 con PDI_SMTP_SECURE=true.');
    }

    return { user, pass, host, port, secure };
};

const formatSmtpError = (error, config) => {
    const rawMessage = error?.message || 'Error desconocido enviando correo';
    const responseCode = error?.responseCode || error?.code;
    const authFailed = responseCode === 535
        || /535|invalid login|authentication failed|auth/i.test(rawMessage);

    if (authFailed) {
        return `Autenticacion SMTP fallida para ${config.host}:${config.port}. Revisa SMTP_USER/SMTP_PASS o REMINDER_EMAIL/REMINDER_PASS. Detalle: ${rawMessage}`;
    }

    return rawMessage;
};

const createTransporter = () => {
    const config = getSmtpConfig();

    const transporter = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
            user: config.user,
            pass: config.pass,
        },
        tls: {
            rejectUnauthorized: false,
        },
    });

    transporter.verify((error) => {
        if (error) {
            console.error('[PDI-SMTP] Error al verificar conexión SMTP:', error.message);
        } else {
            console.log('[PDI-SMTP] Conexión SMTP verificada correctamente con', config.host);
        }
    });

    return { transporter, config };
};

const addRecipient = (recipients, { email, name, role, item }) => {
    const normalizedEmail = cleanEmail(email);
    if (!isEmail(normalizedEmail)) return;

    const current = recipients.get(normalizedEmail) || {
        email: normalizedEmail,
        name: String(name || '').trim() || normalizedEmail,
        roles: new Set(),
        items: [],
    };

    if (!current.name || current.name === current.email) {
        current.name = String(name || '').trim() || normalizedEmail;
    }

    current.roles.add(role);
    if (item) current.items.push(item);
    recipients.set(normalizedEmail, current);
};

const buildUsersByName = async (names) => {
    const targetNames = new Set(
        names.map(normalizePersonName).filter(Boolean)
    );
    const usersByName = new Map();

    if (!targetNames.size) return usersByName;

    const users = await User.find({ isActive: true }, 'full_name email').lean();
    for (const user of users) {
        const nameKey = normalizePersonName(user.full_name);
        if (!targetNames.has(nameKey) || !isEmail(user.email)) continue;

        const matches = usersByName.get(nameKey) || [];
        matches.push(user);
        usersByName.set(nameKey, matches);
    }

    return usersByName;
};

const resolveUserRecipient = (usersByName, name, fallbackEmail) => {
    const matches = usersByName.get(normalizePersonName(name)) || [];
    const normalizedFallbackEmail = cleanEmail(fallbackEmail);
    const user = matches.find((match) => cleanEmail(match.email) === normalizedFallbackEmail)
        || matches[0];

    return {
        email: user ? cleanEmail(user.email) : normalizedFallbackEmail,
        name: user?.full_name || name,
    };
};

const collectRecipients = async () => {
    const recipients = new Map();

    const proyectos = await Proyecto.find({}, 'codigo nombre responsable responsable_email macroproyecto_id')
        .populate('macroproyecto_id', 'codigo nombre lÍder lider_email')
        .lean();
    const proyectosVigentes = proyectos.filter((proyecto) => proyecto.macroproyecto_id);
    const macrosById = new Map();
    const personNames = [];

    for (const proyecto of proyectosVigentes) {
        macrosById.set(String(proyecto.macroproyecto_id._id), proyecto.macroproyecto_id);
        personNames.push(proyecto.responsable);
    }

    for (const macro of macrosById.values()) {
        personNames.push(macro.lider);
    }

    const usersByName = await buildUsersByName(personNames);

    for (const macro of macrosById.values()) {
        const recipient = resolveUserRecipient(usersByName, macro.lider, macro.lider_email);
        addRecipient(recipients, {
            email: recipient.email,
            name: recipient.name,
            role: 'Lider de macroproyecto',
            item: {
                tipo: 'Macroproyecto',
                codigo: macro.codigo,
                nombre: macro.nombre,
            },
        });
    }

    for (const proyecto of proyectosVigentes) {
        const recipient = resolveUserRecipient(usersByName, proyecto.responsable, proyecto.responsable_email);
        addRecipient(recipients, {
            email: recipient.email,
            name: recipient.name,
            role: 'Responsable de proyecto',
            item: {
                tipo: 'Proyecto',
                codigo: proyecto.codigo,
                nombre: proyecto.nombre,
                macro: proyecto.macroproyecto_id
                    ? `${proyecto.macroproyecto_id.codigo} - ${proyecto.macroproyecto_id.nombre}`
                    : '',
            },
        });
    }

    return [...recipients.values()].map((recipient) => ({
        ...recipient,
        roles: [...recipient.roles],
    }));
};

const buildItemsHtml = (items = []) => {
    if (!items.length) {
        return '<p style="margin:0;color:#64748b;font-size:14px;">Tienes responsabilidades asociadas al PDI.</p>';
    }

    const visibleItems = items.slice(0, 5);
    const rows = visibleItems.map((item) => `
        <tr>
            <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;">
                <div style="font-weight:700;color:#0f172a;">${escapeHtml(item.codigo || item.tipo)}</div>
                <div style="font-size:13px;color:#475569;line-height:1.35;">${escapeHtml(item.nombre || '')}</div>
                ${item.macro ? `<div style="font-size:12px;color:#64748b;margin-top:3px;">${escapeHtml(item.macro)}</div>` : ''}
            </td>
            <td style="padding:10px 12px;border-bottom:1px solid #e2e8f0;text-align:right;">
                <span style="display:inline-block;background:#eef2ff;color:#4338ca;border-radius:999px;padding:4px 8px;font-size:12px;font-weight:700;">
                    ${escapeHtml(item.tipo)}
                </span>
            </td>
        </tr>
    `).join('');

    const extra = items.length > visibleItems.length
        ? `<p style="margin:10px 0 0;color:#64748b;font-size:13px;">Y ${items.length - visibleItems.length} responsabilidad(es) adicional(es) en el PDI.</p>`
        : '';

    return `
        <table style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;">
            <tbody>${rows}</tbody>
        </table>
        ${extra}
    `;
};

const buildEmailHtml = ({ recipient, corte, appUrl }) => {
    const fechaInicio = formatDate(corte.fecha_inicio);
    const fechaFin = formatDate(corte.fecha_fin);
    const roles = recipient.roles.join(' y ');

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Periodo PDI abierto</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;">
        <div style="margin:0;padding:0;background:#f1f5f9;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f1f5f9;padding:28px 12px;">
                <tr>
                    <td align="center">
                        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:680px;background:#ffffff;border-radius:18px;overflow:hidden;border:1px solid #e2e8f0;font-family:Arial,Helvetica,sans-serif;">
                            <tr>
                                <td style="background:linear-gradient(135deg,#312e81,#2563eb);padding:28px 30px;color:#ffffff;">
                                    <div style="font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;opacity:.85;">Gesti&#243;n PDI</div>
                                    <h1 style="margin:8px 0 0;font-size:28px;line-height:1.15;">Periodo abierto para evidencias y evaluaci&#243;n</h1>
                                    <p style="margin:12px 0 0;font-size:16px;line-height:1.5;color:#dbeafe;">
                                        El corte <strong style="color:#ffffff;">${escapeHtml(corte.nombre)}</strong> ya se encuentra habilitado en MIRÓ.
                                    </p>
                                </td>
                            </tr>
                            <tr>
                                <td style="padding:28px 30px;">
                                    <p style="margin:0 0 14px;font-size:16px;color:#0f172a;">Hola <strong>${escapeHtml(recipient.name)}</strong>,</p>
                                    <p style="margin:0 0 18px;font-size:15px;line-height:1.65;color:#334155;">
                                        Te notificamos que el periodo <strong>${escapeHtml(corte.nombre)}</strong>, desde
                                        <strong>${escapeHtml(fechaInicio)}</strong> hasta <strong>${escapeHtml(fechaFin)}</strong>,
                                        est&#225; abierto para cargar evidencias, reportar avances y realizar las evaluaciones correspondientes.
                                    </p>

                                    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:18px 0;border-collapse:separate;border-spacing:0 10px;">
                                        <tr>
                                            <td style="width:50%;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;">
                                                <div style="font-size:12px;color:#64748b;font-weight:700;text-transform:uppercase;">Apertura</div>
                                                <div style="font-size:16px;color:#0f172a;font-weight:800;margin-top:4px;">${escapeHtml(fechaInicio)}</div>
                                            </td>
                                            <td style="width:12px;"></td>
                                            <td style="width:50%;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:14px;">
                                                <div style="font-size:12px;color:#64748b;font-weight:700;text-transform:uppercase;">Cierre</div>
                                                <div style="font-size:16px;color:#0f172a;font-weight:800;margin-top:4px;">${escapeHtml(fechaFin)}</div>
                                            </td>
                                        </tr>
                                    </table>

                                    <div style="background:#ecfeff;border:1px solid #a5f3fc;border-radius:14px;padding:16px 18px;margin:20px 0;">
                                        <div style="font-size:13px;color:#0e7490;font-weight:800;text-transform:uppercase;">Tu rol en este periodo</div>
                                        <p style="margin:6px 0 0;font-size:15px;color:#164e63;line-height:1.55;">
                                            ${escapeHtml(roles)}. Ingresa a MIRO para subir o revisar evidencias seg&#250;n corresponda.
                                        </p>
                                    </div>

                                    ${buildItemsHtml(recipient.items)}

                                    <div style="margin:26px 0 8px;text-align:center;">
                                        <a href="${escapeHtml(appUrl)}"
                                           style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:13px 24px;border-radius:999px;font-size:15px;font-weight:800;">
                                            Ir a subir evidencias y evaluar
                                        </a>
                                    </div>

                                    <p style="margin:20px 0 0;font-size:13px;line-height:1.55;color:#64748b;">
                                        Este correo fue generado autom&#225;ticamente por MIRÓ. Por favor no respondas a este mensaje.
                                        Para inquietudes del proceso PDI, escribe a gestionpdi@unibague.edu.co.
                                    </p>
                                </td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </div>
</body>
</html>`;
};

const notifyPdiPeriodUsers = async (corte) => {
    console.log('[PDI-NOTIFY] Iniciando notificación para corte:', corte?.nombre || corte?._id);

    const recipients = await collectRecipients();
    console.log(`[PDI-NOTIFY] Destinatarios encontrados: ${recipients.length}`);

    if (recipients.length === 0) {
        console.warn('[PDI-NOTIFY] No hay destinatarios. Verifica que haya líderes y responsables en la BD.');
    }

    const { transporter, config } = createTransporter();
    const platformUrl = getPlatformUrl();
    const appUrl = `${platformUrl}/pdi/mis-indicadores`;
    const fromName = cleanEnv(process.env.PDI_MAIL_FROM_NAME) || DEFAULT_FROM_NAME;
    const fromAddress = cleanEnv(process.env.PDI_MAIL_FROM_ADDRESS) || DEFAULT_FROM_ADDRESS;

    console.log(`[PDI-NOTIFY] Enviando desde: "${fromName}" <${fromAddress}>`);

    const results = [];

    for (const recipient of recipients) {
        console.log(`[PDI-NOTIFY] Enviando a: ${recipient.email}`);
        try {
            await transporter.sendMail({
                from: `"${fromName}" <${fromAddress}>`,
                to: recipient.email,
                subject: `Periodo PDI abierto: ${corte.nombre}`,
                html: buildEmailHtml({ recipient, corte, appUrl }),
            });
            console.log(`[PDI-NOTIFY] ✓ Enviado a ${recipient.email}`);
            results.push({ email: recipient.email, ok: true });
        } catch (error) {
            const msg = formatSmtpError(error, config);
            console.error(`[PDI-NOTIFY] ✗ Error enviando a ${recipient.email}:`, msg);
            results.push({ email: recipient.email, ok: false, error: msg });
        }
    }

    const sent = results.filter((item) => item.ok).length;
    const failed = results.filter((item) => !item.ok);

    console.log(`[PDI-NOTIFY] Resultado: ${sent} enviados, ${failed.length} fallidos`);

    return {
        corte: {
            _id: corte._id,
            nombre: corte.nombre,
            fecha_inicio: corte.fecha_inicio,
            fecha_fin: corte.fecha_fin,
        },
        total: recipients.length,
        enviados: sent,
        fallidos: failed.length,
        errores: failed,
    };
};

module.exports = {
    notifyPdiPeriodUsers,
};
