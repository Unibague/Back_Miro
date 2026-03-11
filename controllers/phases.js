const Phase = require('../models/phases');
const Process = require('../models/processes');
const { crearPMAutomaticoParaAV } = require('../helpers/pmAutoCreate');

const phaseController = {};

/* GET /phases?proceso_id=xxx — fases de un proceso */
phaseController.getByProcess = async (req, res) => {
  try {
    if (!req.query.proceso_id) return res.status(400).json({ error: 'proceso_id es requerido' });
    const phases = await Phase.find({ proceso_id: req.query.proceso_id }).sort({ numero: 1 });
    res.status(200).json(phases);
  } catch (error) {
    console.error('Error obteniendo fases:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* GET /phases/:id — una fase con sus actividades */
phaseController.getById = async (req, res) => {
  try {
    const phase = await Phase.findById(req.params.id);
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });
    res.status(200).json(phase);
  } catch (error) {
    console.error('Error obteniendo fase:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /phases/:id — actualizar nombre de la fase */
phaseController.update = async (req, res) => {
  try {
    const { nombre } = req.body;
    const phase = await Phase.findByIdAndUpdate(req.params.id, { nombre }, { new: true });
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });
    res.status(200).json(phase);
  } catch (error) {
    console.error('Error actualizando fase:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* POST /phases/:id/actividades — agregar actividad a una fase.
   body: { nombre, responsables?, position? } — position = índice 0-based (opcional; si no se envía, se agrega al final). */
phaseController.addActividad = async (req, res) => {
  try {
    const { nombre, responsables, position } = req.body;
    if (!nombre) return res.status(400).json({ error: 'El nombre de la actividad es requerido' });
    const phase = await Phase.findById(req.params.id);
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });
    const pos = typeof position === 'number' && position >= 0 && position <= phase.actividades.length
      ? position
      : phase.actividades.length;
    const newAct = { nombre, responsables: responsables ?? '', completada: false };
    const phaseUpdated = await Phase.findByIdAndUpdate(
      req.params.id,
      { $push: { actividades: { $each: [newAct], $position: pos } } },
      { new: true }
    );
    res.status(201).json(phaseUpdated);
  } catch (error) {
    console.error('Error agregando actividad:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /phases/:id/actividades/:actividadId — editar una actividad */
phaseController.updateActividad = async (req, res) => {
  try {
    const { nombre, responsables, completada, fecha_completado, observaciones } = req.body;
    const update = {};
    if (nombre            !== undefined) update['actividades.$.nombre']            = nombre;
    if (responsables      !== undefined) update['actividades.$.responsables']      = responsables;
    if (completada        !== undefined) update['actividades.$.completada']        = completada;
    if (fecha_completado  !== undefined) update['actividades.$.fecha_completado']  = fecha_completado;
    if (observaciones     !== undefined) update['actividades.$.observaciones']     = observaciones;
    const phase = await Phase.findOneAndUpdate(
      { _id: req.params.id, 'actividades._id': req.params.actividadId },
      { $set: update },
      { new: true }
    );
    if (!phase) return res.status(404).json({ error: 'Fase o actividad no encontrada' });
    res.status(200).json(phase);
  } catch (error) {
    console.error('Error actualizando actividad:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* POST /phases/:id/actividades/:actividadId/subactividades — agregar subactividad */
phaseController.addSubactividad = async (req, res) => {
  try {
    const { nombre } = req.body;
    if (!nombre) return res.status(400).json({ error: 'El nombre es requerido' });
    const phase = await Phase.findOneAndUpdate(
      { _id: req.params.id, 'actividades._id': req.params.actividadId },
      { $push: { 'actividades.$.subactividades': { nombre, completada: false, observaciones: '' } } },
      { new: true }
    );
    if (!phase) return res.status(404).json({ error: 'Fase o actividad no encontrada' });
    res.status(201).json(phase);
  } catch (error) {
    console.error('Error agregando subactividad:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /phases/:id/actividades/:actividadId/subactividades/:subactividadId — editar subactividad */
phaseController.updateSubactividad = async (req, res) => {
  try {
    const { nombre, completada, fecha_completado, observaciones } = req.body;
    const phase = await Phase.findById(req.params.id);
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });

    const act = phase.actividades.id(req.params.actividadId);
    if (!act) return res.status(404).json({ error: 'Actividad no encontrada' });

    const sub = act.subactividades.id(req.params.subactividadId);
    if (!sub) return res.status(404).json({ error: 'Subactividad no encontrada' });

    if (nombre           !== undefined) sub.nombre           = nombre;
    if (completada       !== undefined) sub.completada       = completada;
    if (fecha_completado !== undefined) sub.fecha_completado = fecha_completado;
    if (observaciones    !== undefined) sub.observaciones    = observaciones;

    await phase.save();
    res.status(200).json(phase);
  } catch (error) {
    console.error('Error actualizando subactividad:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* DELETE /phases/:id/actividades/:actividadId/subactividades/:subactividadId — eliminar subactividad */
phaseController.removeSubactividad = async (req, res) => {
  try {
    const phase = await Phase.findOneAndUpdate(
      { _id: req.params.id, 'actividades._id': req.params.actividadId },
      { $pull: { 'actividades.$.subactividades': { _id: req.params.subactividadId } } },
      { new: true }
    );
    if (!phase) return res.status(404).json({ error: 'Fase o actividad no encontrada' });
    res.status(200).json(phase);
  } catch (error) {
    console.error('Error eliminando subactividad:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /phases/:id/reorder — reordenar actividades por array de IDs
   body: { orden: ["id1", "id2", ...] } */
phaseController.reorderActividades = async (req, res) => {
  try {
    const { orden } = req.body;
    if (!Array.isArray(orden)) return res.status(400).json({ error: 'orden debe ser un array de IDs' });
    const phase = await Phase.findById(req.params.id);
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });

    const actMap = new Map(phase.actividades.map(a => [String(a._id), a]));
    const reordenadas = orden.map(id => actMap.get(id)).filter(Boolean);
    // Añadir las que no estén en el orden (por seguridad) al final
    phase.actividades.forEach(a => { if (!orden.includes(String(a._id))) reordenadas.push(a); });
    phase.actividades = reordenadas;
    await phase.save();
    res.status(200).json(phase);
  } catch (error) {
    console.error('Error reordenando actividades:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /phases/:id/complete-all — marcar todas las actividades como completadas y avanzar fase */
phaseController.completeAll = async (req, res) => {
  try {
    const phase = await Phase.findById(req.params.id);
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });

    // Marcar todas las actividades como completadas
    phase.actividades.forEach(a => { a.completada = true; });
    await phase.save();

    // Avanzar la fase del proceso si hay siguiente
    const proceso = await Process.findById(phase.proceso_id);
    if (proceso && phase.numero === proceso.fase_actual && phase.numero < 6) {
      proceso.fase_actual = phase.numero + 1;
      await proceso.save();

      // Auto-crear PM para AV al llegar a Fase 6
      if (proceso.fase_actual === 6 && proceso.tipo_proceso === 'AV') {
        await crearPMAutomaticoParaAV(proceso);
      }
    }

    res.status(200).json({ fase: phase, proceso });
  } catch (error) {
    console.error('Error completando todas las actividades:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* DELETE /phases/:id/actividades/:actividadId — eliminar una actividad */
phaseController.removeActividad = async (req, res) => {
  try {
    const phase = await Phase.findByIdAndUpdate(
      req.params.id,
      { $pull: { actividades: { _id: req.params.actividadId } } },
      { new: true }
    );
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });
    res.status(200).json(phase);
  } catch (error) {
    console.error('Error eliminando actividad:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = phaseController;
