const Phase = require('../models/phases');
const Process = require('../models/processes');

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

/* POST /phases/:id/actividades — agregar actividad a una fase */
phaseController.addActividad = async (req, res) => {
  try {
    const { nombre, responsables } = req.body;
    if (!nombre) return res.status(400).json({ error: 'El nombre de la actividad es requerido' });
    const phase = await Phase.findByIdAndUpdate(
      req.params.id,
      { $push: { actividades: { nombre, responsables: responsables ?? '', completada: false } } },
      { new: true }
    );
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });
    res.status(201).json(phase);
  } catch (error) {
    console.error('Error agregando actividad:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /phases/:id/actividades/:actividadId — editar una actividad */
phaseController.updateActividad = async (req, res) => {
  try {
    const { nombre, responsables, completada } = req.body;
    const update = {};
    if (nombre       !== undefined) update['actividades.$.nombre']       = nombre;
    if (responsables !== undefined) update['actividades.$.responsables'] = responsables;
    if (completada   !== undefined) update['actividades.$.completada']   = completada;
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
