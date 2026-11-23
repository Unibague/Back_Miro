/**
 * Lógica del Buzón MEN compartida por el controlador y la tarea diaria:
 * destinatarios por línea del organigrama, procesos RC/AV de cada programa,
 * plantillas y envío automático (aviso al administrador y día de inicio).
 */
const nodemailer = require('nodemailer');
const MenMailbox = require('../models/menMailbox');
const MenMailTemplate = require('../models/menMailTemplate');
const Program = require('../models/programs');
const Process = require('../models/processes');
const { getEmailConfig } = require('../config/emailConfig');
const organigramaSvc = require('./organigrama');
const { getMenAdminUsers, getMenAdminEmails } = require('./menAdminRecipients');
const { hoyYMDLocal } = require('../helpers/cronVigencia');
const {
  PLANTILLAS_DEFECTO, NOMBRE_PROCESO, DIAS_AVISO_ADMIN, formatFecha, tablaFechas, renderPlantilla,
} = require('../helpers/menMailTemplates');

/** Días después del inicio en que aún se envía el recordatorio si el servidor no corrió ese día. */
const DIAS_GRACIA_INICIO = 7;

const crearTransporte = () => {
  const emailConfig = getEmailConfig('general');
  const transporter = nodemailer.createTransport({
    host: emailConfig.host,
    port: emailConfig.port,
    secure: false,
    auth: { user: emailConfig.username, pass: emailConfig.password },
    tls: { rejectUnauthorized: false },
  });
  const from = `"${emailConfig.fromName}" <${emailConfig.fromAddress || emailConfig.username}>`;
  return { transporter, from };
};

/**
 * Envía en copia oculta (cada unidad no ve los correos de las demás), con
 * copia visible a los administradores del MEN.
 */
const enviarCorreo = ({ transporter, from }, { destinatarios, copia = [], asunto, html }) =>
  transporter.sendMail({ from, to: from, cc: copia, bcc: destinatarios, subject: asunto, html });

/**
 * Correos de los programas indicados y de toda su línea hacia arriba.
 * Devuelve también las unidades de esa línea que aún no tienen correo.
 */
const resolverLinea = (programas) => {
  const correos = new Set();
  const sinCorreo = new Map();
  programas.forEach((p) => p.linea.forEach((u) => {
    const deUnidad = [u.correo, ...(u.lideres || [])].filter(Boolean);
    deUnidad.forEach((c) => correos.add(c));
    if (!deUnidad.length) sinCorreo.set(String(u._id), `${u.nombre} (${u.tipo})`);
  }));
  return { correos: [...correos], sinCorreo: [...sinCorreo.values()] };
};

/**
 * Procesos RC/AV en curso de cada programa del organigrama, como filas de la
 * tabla de fechas. El programa se cruza por dep_code y, si no, por nombre.
 */
const getProcesosPorPrograma = async (programasOrg) => {
  const catalogo = await Program.find({}, 'nombre dep_code_programa codigo_snies nivel_formacion nivel_academico').lean();
  const porDep = new Map(catalogo.filter((p) => p.dep_code_programa).map((p) => [String(p.dep_code_programa), p]));
  const porNombre = new Map(catalogo.map((p) => [organigramaSvc.normalizar(p.nombre), p]));

  const programaDe = new Map();
  programasOrg.forEach((o) => {
    const p = (o.dep_code && porDep.get(String(o.dep_code))) || porNombre.get(organigramaSvc.normalizar(o.nombre));
    if (p) programaDe.set(String(o._id), p);
  });

  // Los procesos guardan el _id del programa; los antiguos, su dep_code_programa
  const codigos = [...programaDe.values()].flatMap((p) => [String(p._id), p.dep_code_programa].filter(Boolean));
  const procesos = await Process.find(
    { program_code: { $in: codigos }, tipo_proceso: { $in: ['RC', 'AV'] } },
    'program_code tipo_proceso subtipo fecha_vencimiento fecha_inicio fecha_documento_par fecha_radicado_men'
  ).lean();

  const resultado = new Map();
  programaDe.forEach((p, orgId) => {
    const propios = procesos.filter((pr) => [String(p._id), p.dep_code_programa].includes(pr.program_code));
    resultado.set(orgId, propios.map((pr) => ({
      proceso_id: String(pr._id),
      nivel: p.nivel_formacion || p.nivel_academico || '',
      snies: p.codigo_snies || '',
      programa: p.nombre,
      tipo_proceso: pr.tipo_proceso,
      subtipo: pr.subtipo || '',
      fecha_vencimiento: pr.fecha_vencimiento,
      fecha_inicio: pr.fecha_inicio,
      fecha_documento_par: pr.fecha_documento_par,
      fecha_radicado_men: pr.fecha_radicado_men,
    })));
  });
  return resultado;
};

/** Programas del organigrama con su línea y sus procesos RC/AV */
const getProgramasConProcesos = async () => {
  const programas = await organigramaSvc.getProgramasConLinea();
  const procesos = await getProcesosPorPrograma(programas);
  return programas.map((p) => ({ ...p, procesos: procesos.get(String(p._id)) || [] }));
};

/* ── Plantillas ───────────────────────────────────────────────────────── */

const getPlantilla = async (clave) => {
  const guardada = await MenMailTemplate.findOne({ clave }).lean();
  return guardada
    ? { asunto: guardada.asunto, cuerpo: guardada.cuerpo, personalizada: true, updatedAt: guardada.updatedAt, actualizado_por: guardada.actualizado_por }
    : { ...PLANTILLAS_DEFECTO[clave], personalizada: false };
};

const variablesProceso = (fila) => ({
  programa: fila.programa,
  tipo: fila.tipo_proceso,
  proceso: NOMBRE_PROCESO[fila.tipo_proceso] || 'el proceso',
});

/** Correo de un proceso para el programa y su línea (sin la radicación) */
const renderResponsable = (plantilla, fila) =>
  renderPlantilla(plantilla, variablesProceso(fila), tablaFechas(fila));

/** Aviso al administrador antes del inicio: mismas fechas más la radicación */
const renderAdministrador = (plantilla, fila, dias = DIAS_AVISO_ADMIN) => renderPlantilla(plantilla, {
  ...variablesProceso(fila),
  fecha_inicio: formatFecha(fila.fecha_inicio),
  dias,
}, tablaFechas(fila, { radicacion: true }));

/* ── Envío automático ─────────────────────────────────────────────────── */

/** Administradores del MEN según su perfil: reciben los avisos y las copias */
const getConfig = async () => {
  const admins = await getMenAdminUsers();
  return { perfiles: admins.perfiles, administradores: admins.usuarios };
};

const sumarDias = (ymd, dias) => {
  const d = new Date(`${String(ymd).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + dias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const diasEntre = (desde, hasta) =>
  Math.round((new Date(`${hasta}T12:00:00`) - new Date(`${desde}T12:00:00`)) / 86400000);

const claveAutomatico = (evento, fila) => `${evento}:${fila.proceso_id}:${fila.fecha_inicio}`;

/**
 * Calendario de envíos automáticos de cada proceso con fecha de inicio:
 * el aviso al administrador (15 días antes) y el recordatorio a los programas
 * (el día de inicio), con su estado (pendiente, enviado, vencido).
 */
const getCalendario = async ({ hoy = hoyYMDLocal() } = {}) => {
  const programas = await getProgramasConProcesos();
  const filas = programas.flatMap((p) => p.procesos.map((f) => ({ ...f, programa_org: p })))
    .filter((f) => /^\d{4}-\d{2}-\d{2}/.test(String(f.fecha_inicio || '')));

  const claves = filas.flatMap((f) => [claveAutomatico('admin', f), claveAutomatico('programa', f)]);
  const enviados = await MenMailbox.find({ clave_automatico: { $in: claves }, estado: 'enviado' }, 'clave_automatico createdAt').lean();
  const enviadoEn = new Map(enviados.map((e) => [e.clave_automatico, e.createdAt]));

  const estado = (clave, desde, hasta) => {
    if (enviadoEn.has(clave)) return { estado: 'enviado', enviado_en: enviadoEn.get(clave) };
    if (hoy < desde) return { estado: 'pendiente' };
    if (hoy <= hasta) return { estado: 'hoy' };
    return { estado: 'vencido' };
  };

  return filas.map((f) => {
    const inicio = f.fecha_inicio.slice(0, 10);
    const avisoAdmin = sumarDias(inicio, -DIAS_AVISO_ADMIN);
    return {
      fila: f,
      aviso_admin: { fecha: avisoAdmin, ...estado(claveAutomatico('admin', f), avisoAdmin, sumarDias(inicio, -1)) },
      aviso_programa: { fecha: inicio, ...estado(claveAutomatico('programa', f), inicio, sumarDias(inicio, DIAS_GRACIA_INICIO)) },
    };
  }).sort((a, b) => a.fila.fecha_inicio.localeCompare(b.fila.fecha_inicio));
};

/**
 * Tarea diaria: envía lo que toca hoy y no se ha enviado. Si el servidor no
 * corrió algún día, el aviso al administrador sale mientras no haya llegado
 * el inicio, y el de los programas hasta 7 días después del inicio.
 */
const ejecutarAutomatico = async ({ hoy = hoyYMDLocal() } = {}) => {
  const resumen = { avisos_admin: 0, avisos_programa: 0, omitidos: [] };
  const admins = await getMenAdminEmails();
  const calendario = await getCalendario({ hoy });
  const pendientes = calendario.filter((c) => c.aviso_admin.estado === 'hoy' || c.aviso_programa.estado === 'hoy');
  if (!pendientes.length) return resumen;

  const [plantillaResp, plantillaAdmin] = await Promise.all([getPlantilla('responsables'), getPlantilla('administradores')]);
  const transporte = crearTransporte();

  const registrar = async (datos, enviar) => {
    try {
      await enviar();
      await MenMailbox.create({ ...datos, estado: 'enviado' });
      return true;
    } catch (error) {
      console.error('[buzonMEN] Error en envío automático:', error.message);
      await MenMailbox.create({ ...datos, estado: 'error', error: error.message }).catch(() => null);
      return false;
    }
  };

  for (const { fila, aviso_admin: avisoAdmin, aviso_programa: avisoPrograma } of pendientes) {
    const base = {
      cuerpo: '', programas: [fila.programa], automatico: true, enviado_por: 'Envío automático',
    };

    if (avisoAdmin.estado === 'hoy') {
      if (!admins.length) {
        resumen.omitidos.push(`${fila.programa}: no hay administradores en el perfil del módulo MEN`);
      } else {
        const render = renderAdministrador(plantillaAdmin, fila, diasEntre(hoy, fila.fecha_inicio.slice(0, 10)));
        const ok = await registrar(
          { ...base, tipo: 'administradores', asunto: render.asunto, cuerpo: plantillaAdmin.cuerpo,
            destinatarios: admins, clave_automatico: claveAutomatico('admin', fila) },
          () => transporte.transporter.sendMail({ from: transporte.from, to: transporte.from, bcc: admins, subject: render.asunto, html: render.html })
        );
        if (ok) resumen.avisos_admin += 1;
      }
    }

    if (avisoPrograma.estado === 'hoy') {
      const linea = resolverLinea([fila.programa_org]);
      if (!linea.correos.length) {
        resumen.omitidos.push(`${fila.programa}: su línea no tiene correos`);
      } else {
        const render = renderResponsable(plantillaResp, fila);
        const ok = await registrar(
          { ...base, tipo: 'responsables', asunto: render.asunto, cuerpo: plantillaResp.cuerpo,
            destinatarios: linea.correos, copia: admins, sin_correo: linea.sinCorreo, clave_automatico: claveAutomatico('programa', fila) },
          () => enviarCorreo(transporte, {
            destinatarios: linea.correos, copia: admins, asunto: render.asunto, html: render.html,
          })
        );
        if (ok) resumen.avisos_programa += 1;
      }
    }
  }
  return resumen;
};

module.exports = {
  DIAS_AVISO_ADMIN,
  crearTransporte,
  enviarCorreo,
  resolverLinea,
  getProgramasConProcesos,
  getPlantilla,
  getMenAdminEmails,
  renderResponsable,
  renderAdministrador,
  getConfig,
  getCalendario,
  ejecutarAutomatico,
};
