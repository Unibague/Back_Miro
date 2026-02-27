const Program          = require('../models/programs');
const Process          = require('../models/processes');
const Phase            = require('../models/phases');
const FASES_PREDEFINIDAS = require('../helpers/fasesBase');
const { calcularFechas } = require('./processes');

async function crearProcesosParaPrograma(program_code, nombre_programa, programData) {
  const tipos = [
    {
      tipo: 'RC', label: 'Registro Calificado',
      fecha_resolucion: programData.fecha_resolucion_rc,
      duracion: programData.duracion_resolucion_rc,
    },
    {
      tipo: 'AV', label: 'Acreditación Voluntaria',
      fecha_resolucion: programData.fecha_resolucion_av,
      duracion: programData.duracion_resolucion_av,
    },
    {
      tipo: 'PM', label: 'Plan de Mejoramiento',
      fecha_resolucion: programData.fecha_resolucion_pm,
      duracion: programData.duracion_resolucion_pm,
    },
  ];
  for (const { tipo, label, fecha_resolucion, duracion } of tipos) {
    const fechas = calcularFechas(tipo, fecha_resolucion, duracion);
    const proceso = await Process.create({
      name: `${label} - ${nombre_programa}`,
      program_code,
      tipo_proceso: tipo,
      ...fechas,
    });
    await Phase.insertMany(
      FASES_PREDEFINIDAS.map(f => ({
        proceso_id: proceso._id,
        numero:     f.numero,
        nombre:     f.nombre,
        actividades: f.actividades.map(a => ({ ...a, completada: false })),
      }))
    );
  }
}

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

/* POST /programs — crear un programa nuevo y sus 3 procesos (RC, AV, PM) */
programController.create = async (req, res) => {
  try {
    const program = await Program.create(req.body);
    await crearProcesosParaPrograma(program.dep_code_programa, program.nombre, req.body);
    res.status(201).json(program);
  } catch (error) {
    console.error('Error creando programa:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /programs/:id — actualizar un programa y recalcular fechas de procesos si cambia la resolución */
programController.update = async (req, res) => {
  try {
    const program = await Program.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!program) return res.status(404).json({ error: 'Programa no encontrado' });

    const camposRC = ['fecha_resolucion_rc', 'codigo_resolucion_rc', 'duracion_resolucion_rc'];
    const camposAV = ['fecha_resolucion_av', 'codigo_resolucion_av', 'duracion_resolucion_av'];
    const camposPM = ['fecha_resolucion_pm', 'codigo_resolucion_pm', 'duracion_resolucion_pm'];
    const tocaRC   = camposRC.some(c => req.body[c] !== undefined);
    const tocaAV   = camposAV.some(c => req.body[c] !== undefined);
    const tocaPM   = camposPM.some(c => req.body[c] !== undefined);

    if (tocaRC) {
      const fechas = calcularFechas('RC', program.fecha_resolucion_rc, program.duracion_resolucion_rc);
      await Process.findOneAndUpdate({ program_code: program.dep_code_programa, tipo_proceso: 'RC' }, { $set: fechas });
    }
    if (tocaAV) {
      const fechas = calcularFechas('AV', program.fecha_resolucion_av, program.duracion_resolucion_av);
      await Process.findOneAndUpdate({ program_code: program.dep_code_programa, tipo_proceso: 'AV' }, { $set: fechas });
    }
    if (tocaPM) {
      const fechas = calcularFechas('PM', program.fecha_resolucion_pm, program.duracion_resolucion_pm);
      await Process.findOneAndUpdate({ program_code: program.dep_code_programa, tipo_proceso: 'PM' }, { $set: fechas });
    }

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
