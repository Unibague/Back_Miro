const Program = require('../models/programs');

const programController = {};

/* GET /programs — todos los programas, opcionalmente filtrados por facultad */
programController.getAll = async (req, res) => {
  try {
    const { facultad } = req.query;
    const query = facultad ? { dep_code_facultad: facultad } : {};
    const programs = await Program.find(query).sort({ nombre: 1 });
    res.status(200).json(programs);
  } catch (error) {
    console.error('Error obteniendo programas:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* GET /programs/:id — un programa por su _id */
programController.getById = async (req, res) => {
  try {
    const program = await Program.findById(req.params.id);
    if (!program) return res.status(404).json({ error: 'Programa no encontrado' });
    res.status(200).json(program);
  } catch (error) {
    console.error('Error obteniendo programa:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* POST /programs — crear un programa nuevo */
programController.create = async (req, res) => {
  try {
    const program = await Program.create(req.body);
    res.status(201).json(program);
  } catch (error) {
    console.error('Error creando programa:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /programs/:id — actualizar un programa */
programController.update = async (req, res) => {
  try {
    const program = await Program.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!program) return res.status(404).json({ error: 'Programa no encontrado' });
    res.status(200).json(program);
  } catch (error) {
    console.error('Error actualizando programa:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* DELETE /programs/:id — eliminar un programa */
programController.remove = async (req, res) => {
  try {
    const program = await Program.findByIdAndDelete(req.params.id);
    if (!program) return res.status(404).json({ error: 'Programa no encontrado' });
    res.status(200).json({ message: 'Programa eliminado correctamente' });
  } catch (error) {
    console.error('Error eliminando programa:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = programController;
