const ProcessReminder = require('../models/processReminder');
const Process = require('../models/processes');
const Program = require('../models/programs');

const processRemindersController = {};

async function mapAlertaToReminderRow(p) {
  const program = await Program.findOne({ dep_code_programa: p.program_code }).lean();
  const ProcessDoc = require('../models/processDocuments');
  const docs = await ProcessDoc.find({ process_id: p._id, doc_type: 'resolucion' }).lean();
  const documentos = docs.map((d) => ({ name: d.name, view_link: d.view_link }));
  return {
    _id: p._id,
    process_history_id: p.cerrado_process_history_id,
    program_code: p.program_code,
    dep_code_facultad: program?.dep_code_facultad ?? null,
    nombre_programa: program?.nombre ?? p.program_code,
    nivel_academico: program?.nivel_academico ?? null,
    tipo_proceso: p.alert_para_tipo,
    subtipo: p.subtipo ?? null,
    codigo_resolucion: p.snapshot_codigo_resolucion ?? null,
    fecha_resolucion: p.snapshot_fecha_resolucion ?? null,
    duracion_resolucion: p.snapshot_duracion_anos ?? null,
    fecha_vencimiento: p.fecha_vencimiento ?? null,
    fecha_inicio: p.fecha_inicio ?? null,
    fecha_documento_par: p.fecha_documento_par ?? null,
    fecha_digitacion_saces: p.fecha_digitacion_saces ?? null,
    fecha_radicado_men: p.fecha_radicado_men ?? null,
    obs_vencimiento: p.obs_vencimiento ?? '',
    obs_inicio: p.obs_inicio ?? '',
    obs_documento_par: p.obs_documento_par ?? '',
    obs_digitacion_saces: p.obs_digitacion_saces ?? '',
    obs_radicado_men: p.obs_radicado_men ?? '',
    documentos,
    createdAt: p.createdAt,
    __origen: 'ALERTA',
  };
}

/* GET /process-reminders — legacy + procesos ALERTA (misma forma para el front) */
processRemindersController.getAll = async (req, res) => {
  try {
    const legacyQuery = {};
    if (req.query.dep_code_facultad) legacyQuery.dep_code_facultad = req.query.dep_code_facultad;
    if (req.query.program_code) legacyQuery.program_code = req.query.program_code;
    if (req.query.nivel_academico) legacyQuery.nivel_academico = req.query.nivel_academico;

    const [legacyRows, alertProcesses] = await Promise.all([
      ProcessReminder.find(legacyQuery).sort({ createdAt: -1 }).lean(),
      Process.find({ tipo_proceso: 'ALERTA' }).sort({ createdAt: -1 }).lean(),
    ]);

    let mappedAlerts = await Promise.all(alertProcesses.map(mapAlertaToReminderRow));
    if (req.query.dep_code_facultad) {
      mappedAlerts = mappedAlerts.filter((r) => r.dep_code_facultad === req.query.dep_code_facultad);
    }
    if (req.query.program_code) {
      mappedAlerts = mappedAlerts.filter((r) => r.program_code === req.query.program_code);
    }
    if (req.query.nivel_academico) {
      mappedAlerts = mappedAlerts.filter((r) => r.nivel_academico === req.query.nivel_academico);
    }

    const byKey = new Map();
    for (const r of mappedAlerts) {
      byKey.set(`${r.program_code}|${r.tipo_proceso}`, r);
    }
    for (const r of legacyRows) {
      const k = `${r.program_code}|${r.tipo_proceso}`;
      if (!byKey.has(k)) byKey.set(k, { ...r, __origen: 'legacy' });
    }

    const out = [...byKey.values()].sort(
      (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
    );

    res.status(200).json(out);
  } catch (error) {
    console.error('Error obteniendo alertas / recordatorios:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = processRemindersController;
