const MenMailbox = require('../models/menMailbox');
const MenMailTemplate = require('../models/menMailTemplate');
const svc = require('../services/menMailbox');
const {
  PLANTILLAS_DEFECTO, VARIABLES, FILA_EJEMPLO, VARIABLES_EJEMPLO, escapeHtml, tablaFechas, renderPlantilla,
} = require('../helpers/menMailTemplates');

const menMailboxController = {};

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

// 'administradores' solo lo envía la tarea automática (aviso antes de la fecha de inicio)
const TIPOS_MENSAJE = ['general', 'responsables'];
const CLAVES_PLANTILLA = Object.keys(PLANTILLAS_DEFECTO);

/* GET /men-mailbox/programas — programas del organigrama con su línea
 * (programa → área → escuela → facultad), el correo de cada unidad y sus procesos */
menMailboxController.getProgramas = async (req, res) => {
  try {
    res.status(200).json({ programas: await svc.getProgramasConProcesos() });
  } catch (error) {
    console.error('Error obteniendo programas del buzón MEN:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* ── Mensajes predeterminados ─────────────────────────────────────────── */

/* GET /men-mailbox/plantillas */
menMailboxController.getPlantillas = async (req, res) => {
  try {
    const plantillas = {};
    for (const clave of CLAVES_PLANTILLA) {
      plantillas[clave] = { ...(await svc.getPlantilla(clave)), variables: VARIABLES[clave], defecto: PLANTILLAS_DEFECTO[clave] };
    }
    res.status(200).json(plantillas);
  } catch (error) {
    console.error('Error obteniendo plantillas del buzón MEN:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /men-mailbox/plantillas/:clave — guarda el mensaje predeterminado */
menMailboxController.updatePlantilla = async (req, res) => {
  const { clave } = req.params;
  if (!CLAVES_PLANTILLA.includes(clave)) return res.status(404).json({ error: 'Plantilla no encontrada' });
  const asunto = String(req.body.asunto ?? '').trim();
  const cuerpo = String(req.body.cuerpo ?? '').trim();
  if (!asunto || !cuerpo) return res.status(400).json({ error: 'El asunto y el cuerpo son obligatorios' });
  try {
    await MenMailTemplate.findOneAndUpdate(
      { clave },
      { asunto, cuerpo, actualizado_por: req.user.email },
      { upsert: true, new: true, runValidators: true }
    );
    res.status(200).json(await svc.getPlantilla(clave));
  } catch (error) {
    console.error('Error guardando plantilla del buzón MEN:', error);
    res.status(500).json({ error: 'No se pudo guardar el mensaje predeterminado' });
  }
};

/* POST /men-mailbox/vista-previa — { clave, asunto?, cuerpo?, programas? }
 * Sin programas: ejemplo de la plantilla, con marcadores de lo que va en cada
 * lugar. Con programas: el mensaje real del primero que tenga proceso. */
menMailboxController.vistaPrevia = async (req, res) => {
  const clave = CLAVES_PLANTILLA.includes(req.body.clave) ? req.body.clave : 'responsables';
  try {
    const guardada = await svc.getPlantilla(clave);
    const plantilla = {
      asunto: req.body.asunto ?? guardada.asunto,
      cuerpo: req.body.cuerpo ?? guardada.cuerpo,
    };
    const elegidos = new Set((Array.isArray(req.body.programas) ? req.body.programas : []).map(String));

    if (!elegidos.size) {
      const render = renderPlantilla(
        plantilla,
        VARIABLES_EJEMPLO,
        tablaFechas(FILA_EJEMPLO, { radicacion: clave === 'administradores', ejemplo: true }),
        { ejemplo: true }
      );
      return res.status(200).json({ ...render, programa: null, ejemplo: true });
    }

    const todos = await svc.getProgramasConProcesos();
    const fila = todos.filter((p) => elegidos.has(String(p._id))).flatMap((p) => p.procesos)[0];
    if (!fila) {
      return res.status(404).json({ error: 'Los programas elegidos no tienen procesos RC o AV para armar la vista previa' });
    }
    const render = clave === 'administradores'
      ? svc.renderAdministrador(plantilla, fila)
      : svc.renderResponsable(plantilla, fila);
    res.status(200).json({ ...render, programa: fila.programa });
  } catch (error) {
    console.error('Error armando vista previa del buzón MEN:', error);
    res.status(500).json({ error: 'No se pudo armar la vista previa' });
  }
};

/* ── Envío automático ─────────────────────────────────────────────────── */

const calendarioRespuesta = async () => ({
  config: await svc.getConfig(),
  dias_aviso_admin: svc.DIAS_AVISO_ADMIN,
  calendario: (await svc.getCalendario()).map(({ fila, aviso_admin: avisoAdmin, aviso_programa: avisoPrograma }) => ({
    proceso_id: fila.proceso_id,
    programa: fila.programa,
    tipo_proceso: fila.tipo_proceso,
    subtipo: fila.subtipo,
    fecha_inicio: fila.fecha_inicio,
    aviso_admin: avisoAdmin,
    aviso_programa: avisoPrograma,
  })),
});

/* GET /men-mailbox/automatico — configuración y calendario de envíos */
menMailboxController.getAutomatico = async (req, res) => {
  try {
    res.status(200).json(await calendarioRespuesta());
  } catch (error) {
    console.error('Error obteniendo envío automático del buzón MEN:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* ── Envío manual ─────────────────────────────────────────────────────── */

/* POST /men-mailbox/enviar — recordatorio general o a responsables.
 * general: texto libre a todos los programas y su línea (área, escuela, facultad).
 * responsables: por cada proceso RC/AV de los programas elegidos, un correo con
 * sus fechas al programa y su línea.
 * Los administradores del perfil del módulo MEN reciben copia de todo. */
menMailboxController.enviar = async (req, res) => {
  const tipo = TIPOS_MENSAJE.includes(req.body.tipo) ? req.body.tipo : 'general';
  const asunto = String(req.body.asunto ?? '').trim();
  const cuerpo = String(req.body.cuerpo ?? '').trim();
  if (!asunto || !cuerpo) {
    return res.status(400).json({ error: 'El asunto y el cuerpo son obligatorios' });
  }

  let todos;
  try {
    todos = await svc.getProgramasConProcesos();
  } catch (error) {
    console.error('Error consultando el organigrama para el buzón MEN:', error);
    return res.status(500).json({ error: 'No se pudo consultar el organigrama' });
  }
  const elegidos = new Set((Array.isArray(req.body.programas) ? req.body.programas : []).map(String));
  const programas = tipo === 'general' ? todos : todos.filter((p) => elegidos.has(String(p._id)));
  if (!programas.length) {
    return res.status(400).json({ error: 'Selecciona al menos un programa' });
  }

  return tipo === 'general'
    ? enviarGeneral(req, res, { asunto, cuerpo, programas })
    : enviarResponsables(req, res, { asunto, cuerpo, programas });
};

const enviarGeneral = async (req, res, { asunto, cuerpo, programas }) => {
  const { correos: destinatarios, sinCorreo } = svc.resolverLinea(programas);
  if (!destinatarios.length) {
    return res.status(400).json({
      error: 'Ninguna unidad de la línea seleccionada tiene correo registrado en el organigrama',
      sin_correo: sinCorreo,
    });
  }

  const copia = await svc.getMenAdminEmails();
  const registro = {
    tipo: 'general', asunto, cuerpo, destinatarios, copia, programas: programas.map((p) => p.nombre),
    sin_correo: sinCorreo, enviado_por: req.user.email,
  };

  try {
    await svc.enviarCorreo(svc.crearTransporte(), {
      destinatarios, copia, asunto, html: cuerpoAHtml(cuerpo),
    });
    const mensaje = await MenMailbox.create({ ...registro, estado: 'enviado' });
    res.status(201).json(mensaje);
  } catch (error) {
    console.error('Error enviando mensaje del buzón MEN:', error);
    const mensaje = await MenMailbox.create({ ...registro, estado: 'error', error: error.message }).catch(() => null);
    res.status(500).json({ error: 'No se pudo enviar el mensaje', detalle: error.message, mensaje });
  }
};

const enviarResponsables = async (req, res, { asunto, cuerpo, programas }) => {
  const plantilla = { asunto, cuerpo };
  const sinProceso = programas.filter((p) => !p.procesos.length).map((p) => p.nombre);

  // Un correo por proceso: el programa y su línea reciben solo sus propias fechas
  const envios = [];
  const sinCorreo = new Set();
  programas.filter((p) => p.procesos.length).forEach((p) => {
    const linea = svc.resolverLinea([p]);
    linea.sinCorreo.forEach((u) => sinCorreo.add(u));
    if (!linea.correos.length) return;
    p.procesos.forEach((fila) => envios.push({ fila, destinatarios: linea.correos, ...svc.renderResponsable(plantilla, fila) }));
  });

  if (!envios.length) {
    return res.status(400).json({
      error: sinProceso.length === programas.length
        ? 'Los programas elegidos no tienen procesos RC o AV en curso'
        : 'Ninguna unidad de la línea de los programas elegidos tiene correo',
      sin_proceso: sinProceso,
      sin_correo: [...sinCorreo],
    });
  }

  const copia = await svc.getMenAdminEmails();
  const registro = {
    tipo: 'responsables', asunto, cuerpo, copia,
    destinatarios: [...new Set(envios.flatMap((e) => e.destinatarios))],
    programas: [...new Set(envios.map((e) => e.fila.programa))],
    sin_correo: [...sinCorreo, ...sinProceso.map((n) => `${n} (sin proceso RC/AV)`)],
    enviado_por: req.user.email,
  };

  try {
    const transporte = svc.crearTransporte();
    for (const e of envios) {
      await svc.enviarCorreo(transporte, {
        destinatarios: e.destinatarios, copia, asunto: e.asunto, html: e.html,
      });
    }
    const mensaje = await MenMailbox.create({ ...registro, estado: 'enviado' });
    res.status(201).json({ ...mensaje.toObject(), correos_enviados: envios.length });
  } catch (error) {
    console.error('Error enviando mensaje del buzón MEN:', error);
    const mensaje = await MenMailbox.create({ ...registro, estado: 'error', error: error.message }).catch(() => null);
    res.status(500).json({ error: 'No se pudo enviar el mensaje', detalle: error.message, mensaje });
  }
};

module.exports = menMailboxController;
