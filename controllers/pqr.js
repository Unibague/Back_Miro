const PQR = require('../models/pqr');

const pqrController = {};

/* GET /pqr?cerrado=false&programa_id=xxx */
pqrController.getAll = async (req, res) => {
  try {
    const filter = {};
    if (req.query.cerrado !== undefined) filter.cerrado = req.query.cerrado === 'true';
    if (req.query.programa_id) filter.programa_id = req.query.programa_id;
    const pqrs = await PQR.find(filter).sort({ createdAt: -1 });
    res.status(200).json(pqrs);
  } catch { res.status(500).json({ error: 'Error interno' }); }
};

/* POST /pqr */
pqrController.create = async (req, res) => {
  try {
    const { nombre_solicitud, programa_id, cedula_encargado } = req.body;
    if (!nombre_solicitud) return res.status(400).json({ error: 'nombre_solicitud es requerido' });
    const ced = typeof cedula_encargado === "string" ? cedula_encargado.trim() || null : cedula_encargado || null;
    const pqr = await PQR.create({
      nombre_solicitud,
      programa_id: programa_id || null,
      cedula_encargado: ced,
    });
    res.status(201).json(pqr);
  } catch { res.status(500).json({ error: 'Error interno' }); }
};

/* PUT /pqr/:id */
pqrController.update = async (req, res) => {
  try {
    const pqr = await PQR.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!pqr) return res.status(404).json({ error: 'PQR no encontrado' });
    res.status(200).json(pqr);
  } catch { res.status(500).json({ error: 'Error interno' }); }
};

/* PUT /pqr/:id/cerrar */
pqrController.cerrar = async (req, res) => {
  try {
    const pqr = await PQR.findByIdAndUpdate(req.params.id, { cerrado: true }, { new: true });
    if (!pqr) return res.status(404).json({ error: 'PQR no encontrado' });
    res.status(200).json(pqr);
  } catch { res.status(500).json({ error: 'Error interno' }); }
};

/* DELETE /pqr/:id */
pqrController.remove = async (req, res) => {
  try {
    await PQR.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: 'PQR eliminado' });
  } catch { res.status(500).json({ error: 'Error interno' }); }
};

module.exports = pqrController;
