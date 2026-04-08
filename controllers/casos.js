const Caso = require('../models/casos');

const casosController = {};

casosController.getByProcess = async (req, res) => {
  try {
    const caso = await Caso.findOne({ proceso_id: req.query.proceso_id });
    if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });
    res.status(200).json(caso);
  } catch { res.status(500).json({ error: 'Error interno' }); }
};

casosController.create = async (req, res) => {
  try {
    const existing = await Caso.findOne({ proceso_id: req.body.proceso_id });
    if (existing) return res.status(200).json(existing);
    const caso = await Caso.create(req.body);
    res.status(201).json(caso);
  } catch { res.status(500).json({ error: 'Error interno' }); }
};

casosController.update = async (req, res) => {
  try {
    const caso = await Caso.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!caso) return res.status(404).json({ error: 'Caso no encontrado' });
    res.status(200).json(caso);
  } catch { res.status(500).json({ error: 'Error interno' }); }
};

casosController.remove = async (req, res) => {
  try {
    await Caso.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: 'Caso eliminado' });
  } catch { res.status(500).json({ error: 'Error interno' }); }
};

module.exports = casosController;
