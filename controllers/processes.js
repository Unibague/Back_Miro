const Process          = require('../models/processes');
const Phase            = require('../models/phases');
const FASES_PREDEFINIDAS = require('../helpers/fasesBase');

/* Suma N meses a una fecha YYYY-MM-DD y devuelve YYYY-MM-DD */
function sumarMeses(fechaStr, meses) {
  if (!fechaStr || meses == null) return null;
  const d = new Date(fechaStr + 'T12:00:00');
  if (isNaN(d.getTime())) return null;
  d.setMonth(d.getMonth() + meses);
  return d.toISOString().split('T')[0];
}

/* Si cae sábado o domingo, corre al lunes siguiente */
function siguienteDiaHabil(fechaStr) {
  if (!fechaStr) return null;
  const d = new Date(fechaStr + 'T12:00:00');
  const dow = d.getDay(); // 0=dom, 6=sab
  if (dow === 6) d.setDate(d.getDate() + 2); // sábado → lunes
  if (dow === 0) d.setDate(d.getDate() + 1); // domingo → lunes
  return d.toISOString().split('T')[0];
}

/* Calcula las fechas del proceso a partir de la resolución vigente.
   - Para RC y PM: la duración viene en MESES.
   - Para AV:      la duración viene en AÑOS (se convierte a meses).

   Plazos por tipo (relativos al vencimiento):
   - RC / PM:
       -29 meses → Inicio proceso
       -17 meses → Documento para lectura del par
       -15 meses → Digitación en SACES
       -12 meses → Radicado en el MEN
   - AV  (aprox):
       -33 meses → Inicio proceso
       -16 meses → Documento para lectura del par
       -15 meses → Digitación en SACES-CNA
       -12 meses → Radicación solicitud AV
*/
function calcularFechas(tipo_proceso, fecha_resolucion, duracion_unidad) {
  if (!fecha_resolucion || duracion_unidad == null) return {};

  // Duración en meses según tipo
  const duracion_meses =
    tipo_proceso === 'AV'
      ? Number(duracion_unidad) * 12   // años → meses
      : Number(duracion_unidad);       // ya viene en meses

  const vencimiento = sumarMeses(fecha_resolucion, duracion_meses);
  if (!vencimiento) return {};

  // Acreditación voluntaria (AV) usa offsets ligeramente distintos
  if (tipo_proceso === 'AV') {
    const mitadMeses = Math.round(duracion_meses / 2);
    return {
      fecha_vencimiento:      vencimiento,
      // Fechas específicas AV
      fecha_entrega_pm_cna:        siguienteDiaHabil(sumarMeses(fecha_resolucion, 6)),         // +6 meses acto admvo
      fecha_radicacion_avance_cna: siguienteDiaHabil(sumarMeses(fecha_resolucion, mitadMeses)),// mitad vigencia
      // Fechas análogas a RC pero con offsets mayores
      fecha_inicio:           siguienteDiaHabil(sumarMeses(vencimiento, -33)),
      fecha_documento_par:    siguienteDiaHabil(sumarMeses(vencimiento, -16)),
      fecha_digitacion_saces: siguienteDiaHabil(sumarMeses(vencimiento, -15)),
      fecha_radicado_men:     siguienteDiaHabil(sumarMeses(vencimiento, -12)),
    };
  }

  // Registro Calificado (RC) y Plan de Mejoramiento (PM)
  return {
    fecha_vencimiento:      vencimiento,
    fecha_inicio:           siguienteDiaHabil(sumarMeses(vencimiento, -29)),
    fecha_documento_par:    siguienteDiaHabil(sumarMeses(vencimiento, -17)),
    fecha_digitacion_saces: siguienteDiaHabil(sumarMeses(vencimiento, -15)),
    fecha_radicado_men:     siguienteDiaHabil(sumarMeses(vencimiento, -12)),
  };
}

const processController = {};

/* GET /processes — todos, opcionalmente filtrados por program_code o tipo_proceso */
processController.getAll = async (req, res) => {
  try {
    const query = {};
    if (req.query.program_code)  query.program_code  = req.query.program_code;
    if (req.query.tipo_proceso)  query.tipo_proceso  = req.query.tipo_proceso;
    const processes = await Process.find(query).sort({ createdAt: -1 });
    res.status(200).json(processes);
  } catch (error) {
    console.error('Error obteniendo procesos:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* GET /processes/:id — un proceso con sus fases y actividades */
processController.getById = async (req, res) => {
  try {
    const process = await Process.findById(req.params.id);
    if (!process) return res.status(404).json({ error: 'Proceso no encontrado' });
    const phases = await Phase.find({ proceso_id: req.params.id }).sort({ numero: 1 });
    res.status(200).json({ ...process.toObject(), fases: phases });
  } catch (error) {
    console.error('Error obteniendo proceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* POST /processes — crear proceso y sus 7 fases vacías automáticamente */
processController.create = async (req, res) => {
  try {
    const process = await Process.create(req.body);
    await Phase.insertMany(
      FASES_PREDEFINIDAS.map(f => ({
        proceso_id:  process._id,
        numero:      f.numero,
        nombre:      f.nombre,
        actividades: f.actividades.map(a => ({ ...a, completada: false })),
      }))
    );
    res.status(201).json(process);
  } catch (error) {
    console.error('Error creando proceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /processes/:id — actualizar proceso (fechas, fase_actual, etc.) */
processController.update = async (req, res) => {
  try {
    const process = await Process.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!process) return res.status(404).json({ error: 'Proceso no encontrado' });
    res.status(200).json(process);
  } catch (error) {
    console.error('Error actualizando proceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* DELETE /processes/:id — eliminar proceso y sus fases */
processController.remove = async (req, res) => {
  try {
    const process = await Process.findByIdAndDelete(req.params.id);
    if (!process) return res.status(404).json({ error: 'Proceso no encontrado' });
    await Phase.deleteMany({ proceso_id: req.params.id });
    res.status(200).json({ message: 'Proceso y sus fases eliminados correctamente' });
  } catch (error) {
    console.error('Error eliminando proceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PATCH /processes/bulk-fases — actualiza fase_actual de varios procesos de una vez
   Body: [{ program_code, tipo_proceso, fase_actual, estado? }] */
processController.bulkFases = async (req, res) => {
  try {
    const items = req.body;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Se esperaba un array' });
    const resultados = [];
    for (const item of items) {
      const { program_code, tipo_proceso, fase_actual, estado } = item;
      const set = {};
      if (fase_actual !== undefined) set.fase_actual = fase_actual;
      if (estado     !== undefined) set.estado       = estado;
      const updated = await Process.findOneAndUpdate(
        { program_code, tipo_proceso },
        { $set: set },
        { new: true }
      );
      resultados.push({ program_code, tipo_proceso, ok: !!updated, fase_actual: updated?.fase_actual });
    }
    res.status(200).json(resultados);
  } catch (error) {
    console.error('Error en bulk-fases:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = processController;
module.exports.calcularFechas = calcularFechas;
