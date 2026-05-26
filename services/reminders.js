// reminderService.js
const dayjs = require('dayjs');
const User = require('../models/users');
const Dependency = require('../models/dependencies');
const Period = require('../models/periods');
const PublishedTemplate = require('../models/publishedTemplates');
const PubProdReport = require('../models/publishedProducerReports');
const ReminderLog = require('../models/reminderLog');
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;
const nodemailer = require('nodemailer');

const RemindersService = {

runReminderEmails: async function (periodId = null) {
  const today = dayjs();

  if (!periodId) {
    const activePeriod = await Period.findOne({ is_active: true }).sort({ updatedAt: -1 });
    if (!activePeriod) {
      console.log("No se encontró periodo activo");
      return 0;
    }
    periodId = activePeriod._id;
  }

  console.log(`Periodo usado para recordatorios de plantillas: ${periodId}`);

  const usuarios = await User.find({
    isActive: true,
    roles: "Productor",
    
  });

  const dependenciaCache = {};
  const logs = [];

  for (const usuario of usuarios) {
    const dependencia = dependenciaCache[usuario.dep_code] ||
      await Dependency.findOne({ dep_code: usuario.dep_code });

    if (!dependencia) continue;
    dependenciaCache[usuario.dep_code] = dependencia;

    const templates = await PublishedTemplate.find({
      'template.producers': dependencia._id,
      period: periodId,
    }).populate('template').lean();

    const plantillasPendientes = templates
      .filter(t => {
        const yaEnviada = t.loaded_data?.some(d => d.dependency === usuario.dep_code);
        return !yaEnviada && dayjs(t.deadline).isAfter(today);
      })
      .map(t => ({
        nombre: t.template?.name || 'Plantilla sin nombre',
        deadline: t.deadline
      }));

    if (plantillasPendientes.length > 0) {
      const fechaLimiteMasProxima = plantillasPendientes.reduce((min, p) =>
        dayjs(p.deadline).isBefore(min) ? p.deadline : min,
        plantillasPendientes[0].deadline
      );

      await RemindersService.sendReminderEmail(
        usuario.email,
        usuario.full_name,
        fechaLimiteMasProxima,
        plantillasPendientes.map(p => p.nombre),
        "plantilla"
      );

      await ReminderLog.create({
        recipient_email: usuario.email,
        recipient_name: usuario.full_name,
        sent_at: new Date(),
        templates_sent: plantillasPendientes.map(p => p.nombre),
        deadline: fechaLimiteMasProxima,
        period_id: periodId
      });

      logs.push({
        email:  usuario.email,
        nombre: usuario.full_name,
        deadline: fechaLimiteMasProxima,
        plantillas: plantillasPendientes.map(p => p.nombre)
      });
    }
  }

  if (logs.length > 0) {
    await RemindersService.sendSummaryEmail(logs);
  }

  return logs.length;
},


runPendingProducerReportEmails: async function(periodId = null) {
  const today = dayjs();

  if (!periodId) {
    const activePeriod = await Period.findOne({ is_active: true }).sort({ updatedAt: -1 });
    if (!activePeriod) {
      console.log("No se encontró periodo activo");
      return 0;
    }
    periodId = activePeriod._id;
  }

  console.log(`Periodo usado para correos de informes de productor: ${periodId}`);

  const usuariosPendientes = await getPendingProducerReportsByUserRaw(periodId);

  console.log(usuariosPendientes)

  const logs = [];

  for (const usuario of usuariosPendientes) {
    const deadlines = await PubProdReport.find({
      period: periodId,
      "report.producers": { $exists: true, $ne: [] }
    }).lean();

    const informesConFecha = deadlines
      .filter(r => usuario.pendingReports.includes(r.report?.name))
      .map(r => ({
        nombre: r.report?.name,
        deadline: r.deadline
      }));

    if (informesConFecha.length > 0) {
      // Escoger la fecha más próxima (si deseas mostrarla en el correo)
      const fechaLimiteMasProxima = informesConFecha.reduce((min, p) =>
        dayjs(p.deadline).isBefore(min) ? p.deadline : min,
        informesConFecha[0].deadline
      );

      await RemindersService.sendReminderEmail(
        usuario.email,
        usuario.full_name,
        fechaLimiteMasProxima,
        informesConFecha.map(p => p.nombre),
        "informe"
      );

      await ReminderLog.create({
        recipient_email: usuario.email,
        recipient_name: usuario.full_name,
        sent_at: new Date(),
        templates_sent: informesConFecha.map(p => p.nombre),
        deadline: fechaLimiteMasProxima,
        period_id: periodId
      });

      logs.push({
        email: usuario.email,
        nombre: usuario.full_name,
        deadline: fechaLimiteMasProxima,
        plantillas: informesConFecha.map(p => p.nombre)
      });
    }
  }

  if (logs.length > 0) {
    await RemindersService.sendSummaryEmail(logs);
  }

  return logs.length;
},


sendSummaryEmail: async function (logs) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.pepipost.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.REMINDER_EMAIL,
      pass: process.env.REMINDER_PASS
    },
    tls: {
      rejectUnauthorized: false
    }
  });

  const cantidad = logs.length;

  const listaHtml = logs.map(log => {
    const nombres = `<ul style="margin: 4px 0 8px 20px; padding-left: 0;">${log.plantillas.map(p => `<li>${p}</li>`).join('')}</ul>`;
    const fecha = dayjs(log.deadline).format('DD/MM/YYYY');

    return `
    <li style="margin-bottom: 16px;">
      <strong>${log.nombre}</strong> (<code>${log.email}</code>)<br/>
      Fecha límite: <em>${fecha}</em><br/>
      ${nombres}
    </li>
  `;
  }).join('');

  const html = `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; max-width: 700px; margin: auto; background-color: #f9f9f9; border-radius: 8px; border: 1px solid #ddd;">
      <div style="text-align: left;">
        <img src="https://miro.unibague.edu.co/MIRO.png" alt="Logo Miró" width="64" height="64" />
      </div>
      <h2 style="color: #1d3557; text-align: center;">Resumen de recordatorios enviados</h2>
      <p style="font-size: 16px;">
        Se han enviado <strong>${cantidad}</strong> recordatorio${cantidad !== 1 ? "s" : ""} a los siguientes usuarios:
      </p>
      <ul style="padding-left: 20px; font-size: 15px;">
        ${listaHtml}
      </ul>
      <hr style="border: none; border-top: 1px solid #ccc; margin: 30px 0;">
      <p style="font-size: 14px; text-align: center; color: #999;">— Sistema de recordatorios automáticos de Miró</p>
    </div>
  `;

  await transporter.sendMail({
    from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`,
    to: 'miro@unibague.edu.co',
    subject: "📬 Resumen de recordatorios enviados",
    html
  });
},

sendReminderEmail: async function (to, nombre, fechaLimite, items = [], tipo = "plantilla") {
  const transporter = nodemailer.createTransport({
    host: 'smtp.pepipost.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.REMINDER_EMAIL,
      pass: process.env.REMINDER_PASS
    },
    tls: {
      rejectUnauthorized: false
    }
  });

  const cantidad = items.length;

  const singular = tipo === "informe" ? "informe" : "plantilla";
  const plural = tipo === "informe" ? "informes" : "plantillas";

  const listaHtml = cantidad
    ? `<ul style="padding-left: 20px;">${items.map(i => `<li>${i}</li>`).join('')}</ul>`
    : `<p>No se encontraron nombres de ${plural}.</p>`;

  await transporter.sendMail({
    from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`,
    to,
    subject: `📩 Recordatorio de ${plural} pendientes`,
    html: `
  <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; max-width: 600px; margin: auto; background-color: #f9f9f9; border-radius: 8px; border: 1px solid #ddd;">
    
    <!-- ICONO SUPERIOR IZQUIERDO -->
    <div style="text-align: left;">
      <img src="https://miro.unibague.edu.co/MIRO.png" alt="Logo Miró" width="64" height="64" style="vertical-align: middle;" />
    </div>

    <h2 style="color: #1d3557; text-align: center;">Recordatorio de entrega pendiente</h2>
    <p style="font-size: 16px;">Hola <strong>${nombre}</strong>,</p>
${tipo === "informe" ? `
  <p style="font-size: 16px;">
    Este mensaje es para recordarte que tienes pendiente el envío del siguiente informe:
  </p>
  ${listaHtml}
  <p style="font-size: 16px;">
    El informe de productor en MIRÓ reporta la información semestral relacionada con el quehacer de la unidad a su cargo, en el marco de las estrategias que responden a requerimientos tanto internos como externos (especialmente aspectos a evaluar por el Ministerio de Educación). Este informe facilita la toma de decisiones informadas y contribuye al diseño y seguimiento de acciones orientadas al mejoramiento continuo de nuestra institución.
  </p>
  <p style="font-size: 16px;">
    Las encuestas de percepción, si bien son un insumo importante para estos documentos, sólo se considerarán en los informes que se elaboren para el Semestre B de cada año toda vez que realizamos las encuestas de forma anual y durante el semestre B desde la Dirección de Planeación se estarán entregando los resultados.
  </p>
  <div style="background-color: #fff3cd; border: 1px solid #ffeeba; padding: 12px 16px; border-radius: 6px; margin: 16px 0;">
    <p style="margin: 0; font-size: 15px; color: #856404;">
      ⚠️ <strong>Se recomienda descargar la versión más reciente de las plantillas de informes desde Miró.</strong>
    </p>
  </div>
` : `
  <p style="font-size: 16px;">
    Tienes <strong>${cantidad}</strong> ${cantidad === 1 ? singular : plural} pendiente${cantidad === 1 ? "" : "s"}.
  </p>
  <p style="font-size: 16px;">Te recordamos que debes entregar los siguientes ${plural}:</p>
  ${listaHtml}
`}
    <p style="font-size: 16px;">
      <strong style="color: #e63946;">Fecha límite:</strong> 
      <span style="font-weight: 500;">${dayjs(fechaLimite).format('DD/MM/YYYY')}</span>
    </p>
    <div style="margin: 24px 0; text-align: center;">
      <a href="https://miro.unibague.edu.co" 
         style="background-color: #457b9d; color: white; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: bold;">
        Ir a la plataforma
      </a>
    </div>
    <p style="font-size: 14px; color: #6c757d;">Por favor, asegúrate de completar tu entrega antes de la fecha límite.</p>
    <p style="font-size: 14px; color: #6c757d;">Este mensaje fue generado automáticamente por la plataforma Miró. Le pedimos no responder al mismo. Si tiene alguna inquietud por favor escribir al correo electrónico direcciondeplaneacion@unibague.edu.co</p>
    <hr style="border: none; border-top: 1px solid #ccc; margin: 30px 0;">
    <p style="font-size: 14px; text-align: center; color: #999;">— Equipo Miró</p>
  </div>
`
  });
},

sendUploadNotificationEmail: async function (to, nombreResponsable, nombrePlantilla, nombreDependencia, nombreProductor, fechaCarga) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.pepipost.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.REMINDER_EMAIL,
      pass: process.env.REMINDER_PASS
    },
    tls: { rejectUnauthorized: false }
  });

  const fechaFormateada = dayjs(fechaCarga).format('DD/MM/YYYY HH:mm');

  await transporter.sendMail({
    from: `"${process.env.MAIL_FROM_NAME}" <${process.env.MAIL_FROM_ADDRESS}>`,
    to,
    subject: `📥 Nueva información cargada en: ${nombrePlantilla}`,
    html: `
<div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; max-width: 600px; margin: auto; background-color: #f9f9f9; border-radius: 8px; border: 1px solid #ddd;">
  <div style="text-align: left;">
    <img src="https://miro.unibague.edu.co/MIRO.png" alt="Logo Miró" width="64" height="64" />
  </div>
  <h2 style="color: #1d3557;">Nueva información cargada</h2>
  <p style="font-size: 16px;">Hola <strong>${nombreResponsable}</strong>,</p>
  <p style="font-size: 16px;">
    La dependencia <strong>${nombreDependencia}</strong> (${nombreProductor}) ha cargado información en la plantilla:
  </p>
  <div style="background: #e8f4fd; border-left: 4px solid #457b9d; padding: 12px 16px; border-radius: 4px; margin: 16px 0;">
    <strong style="font-size: 17px;">${nombrePlantilla}</strong><br/>
    <span style="color: #6c757d; font-size: 14px;">Fecha de carga: ${fechaFormateada}</span>
  </div>
  <div style="margin: 24px 0; text-align: center;">
    <a href="https://miro.unibague.edu.co"
       style="background-color: #457b9d; color: white; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-weight: bold;">
      Ver en la plataforma
    </a>
  </div>
  <p style="font-size: 14px; color: #6c757d;">Este mensaje fue generado automáticamente. Si tiene alguna inquietud, escriba a direcciondeplaneacion@unibague.edu.co</p>
  <hr style="border: none; border-top: 1px solid #ccc; margin: 30px 0;">
  <p style="font-size: 14px; text-align: center; color: #999;">— Equipo Miró</p>
</div>
    `
  });
},

};


async function getPendingProducerReportsByUserRaw (periodId) {

  const dependencies = await Dependency.find().lean();

  // Construimos un Set con todos los correos de visualizers (líderes de dependencia)
  const visualizerEmails = new Set();
  for (const dep of dependencies) {
    for (const email of dep.visualizers || []) {
      visualizerEmails.add(email);
    }
  }

  // Solo seleccionamos usuarios que son Productor y también líderes (visualizers)
  const users = await User.find({ 
    isActive: true, 
    roles: "Productor", 
    email: { $in: Array.from(visualizerEmails) }
  }).lean();


  const reports = await PubProdReport.find({ period: new ObjectId(periodId) }).lean()

  const results = [];

  for (const user of users) {
const userDeps = dependencies.filter(dep =>
  dep.members?.includes(user.email)
);

    const pendingTemplates = [];

    for (const report of reports) {
      
      const assignedDepIds = (report.report?.producers || []).map(id => id.toString());
      const filledDepIds = new Set((report.filled_reports || []).map(fr => fr.dependency.toString()));

      for (const dep of userDeps) {
        const depIdStr = dep._id.toString();
        if (assignedDepIds.includes(depIdStr) && !filledDepIds.has(depIdStr)) {
          const reportName = report.report?.name || "Informe sin nombre";
          if (!pendingTemplates.includes(reportName)) {
            pendingTemplates.push(reportName);
          }
        }
      }
    }

    if (pendingTemplates.length > 0) {
      results.push({
        full_name: user.full_name,
        email: user.email,
        pendingReports: pendingTemplates
      });
    }
  }

  return results;
}

module.exports = RemindersService;
