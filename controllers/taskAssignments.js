const Task = require('../models/taskAssignments');

const taskController = {};

/* GET /task-assignments — todas o filtradas por dep_code o email_responsable */
taskController.getAll = async (req, res) => {
  try {
    const query = {};
    if (req.query.dep_code) query.dep_code = req.query.dep_code;
    if (req.query.email_responsable) query.email_responsable = req.query.email_responsable;
    const tasks = await Task.find(query).sort({ createdAt: -1 });
    res.status(200).json(tasks);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

/* POST /task-assignments — crear tarea */
taskController.create = async (req, res) => {
  try {
    const { titulo, descripcion, dep_code, nombre_dependencia, email_responsable, fecha_limite, creado_por } = req.body;
    if (!titulo || !dep_code) return res.status(400).json({ error: 'titulo y dep_code son requeridos' });
    const task = await Task.create({ titulo, descripcion, dep_code, nombre_dependencia, email_responsable, fecha_limite, creado_por });
    res.status(201).json(task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

/* PUT /task-assignments/:id — actualizar (admin edita, responsable marca completada) */
taskController.update = async (req, res) => {
  try {
    const { titulo, descripcion, fecha_limite, completada, observacion_respuesta, email_responsable, nombre_dependencia } = req.body;
    const update = {};
    if (titulo               !== undefined) update.titulo               = titulo;
    if (descripcion          !== undefined) update.descripcion          = descripcion;
    if (fecha_limite         !== undefined) update.fecha_limite         = fecha_limite;
    if (email_responsable    !== undefined) update.email_responsable    = email_responsable;
    if (nombre_dependencia   !== undefined) update.nombre_dependencia   = nombre_dependencia;
    if (observacion_respuesta !== undefined) update.observacion_respuesta = observacion_respuesta;
    if (completada !== undefined) {
      update.completada = completada;
      update.fecha_completada = completada ? new Date().toISOString().split('T')[0] : null;
    }
    const task = await Task.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.status(200).json(task);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

/* DELETE /task-assignments/:id */
taskController.remove = async (req, res) => {
  try {
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' });
    res.status(200).json({ deleted: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

module.exports = taskController;
