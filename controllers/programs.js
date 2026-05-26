const mongoose         = require('mongoose');
const Program          = require('../models/programs');
const Process          = require('../models/processes');
const Phase            = require('../models/phases');
const FASES_BASE_RC    = require('../helpers/fasesBaseRC');
const FASES_BASE_AV    = require('../helpers/fasesBaseAV');
const { calcularFechas } = require('./processes');
const {
  applyDepCodeProgramaToCreatePayload,
  depCodeProgramaMongoUpdateFragments,
} = require('../helpers/depCodePrograma');
const { assertNombreProgramaDisponible } = require('../helpers/nombreProgramaUnico');

async function crearProcesosParaPrograma(program_code, nombre_programa, programData) {
  // Solo se crean automáticamente RC y AV; el Plan de Mejoramiento (PM)
  // se activará manualmente desde uno de ellos.
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
  ];
  for (const { tipo, label, fecha_resolucion, duracion } of tipos) {
    const offsets = (() => {
      if (tipo === 'AV') {
        return {
          meses_inicio_antes_venc:    33,
          meses_doc_par_antes_venc:   16,
          meses_digitacion_antes_venc:15,
          meses_radicado_antes_venc:  12,
        };
      }
      return {
        meses_inicio_antes_venc:    29,
        meses_doc_par_antes_venc:   17,
        meses_digitacion_antes_venc:15,
        meses_radicado_antes_venc:  12,
      };
    })();
    const fechas = calcularFechas(tipo, fecha_resolucion, duracion, offsets);
    const proceso = await Process.create({
      name: `${label} - ${nombre_programa}`,
      program_code,
      tipo_proceso: tipo,
      ...offsets,
      ...fechas,
    });
    const fases = tipo === 'RC' ? FASES_BASE_RC : FASES_BASE_AV;
    await Phase.insertMany(
      fases.map(f => ({
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
    const rawId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(rawId)) {
      return res.status(400).json({ error: 'ID de programa no válido' });
    }
    const program = await Program.findById(rawId).lean();
    if (!program) return res.status(404).json({ error: 'Programa no encontrado' });
    res.status(200).json(program);
  } catch (error) {
    if (error.name === 'CastError') {
      return res.status(400).json({ error: 'ID de programa no válido' });
    }
    console.error('Error obteniendo programa:', error.message || error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* POST /programs — crear un programa nuevo (sin procesos automáticos; los procesos se crean vía "Agregar proceso") */
programController.create = async (req, res) => {
  try {
    const body = { ...req.body };
    applyDepCodeProgramaToCreatePayload(body);
    await assertNombreProgramaDisponible(Program, body.nombre);
    const program = await Program.create(body);
    res.status(201).json(program);
  } catch (error) {
    console.error('Error creando programa:', error);
    if (error?.statusCode === 409) {
      return res.status(409).json({ error: error.message });
    }
    if (error?.code === 11000) {
      return res.status(409).json({ error: 'Ese código de programa ya existe. Usa otro código.' });
    }
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /programs/:id — actualizar un programa y recalcular fechas de procesos si cambia la resolución */
programController.update = async (req, res) => {
  try {
    const rawId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(rawId)) {
      return res.status(400).json({ error: 'ID de programa no válido' });
    }

    const currentProgram = await Program.findById(rawId).lean();
    if (!currentProgram) return res.status(404).json({ error: 'Programa no encontrado' });

    const patch = { ...req.body };
    if (patch.nombre !== undefined) {
      await assertNombreProgramaDisponible(Program, patch.nombre, rawId);
    }
    const depCodeFrag = depCodeProgramaMongoUpdateFragments(patch.dep_code_programa);
    if (depCodeFrag) {
      delete patch.dep_code_programa;
      if (depCodeFrag.set.dep_code_programa) {
        const dupe = await Program.findOne({
          dep_code_programa: depCodeFrag.set.dep_code_programa,
          _id: { $ne: rawId },
        }).select('_id').lean();
        if (dupe) {
          return res.status(409).json({ error: 'Ese código de programa ya está en uso.' });
        }
        patch.dep_code_programa = depCodeFrag.set.dep_code_programa;
      }
    }

    const mongoUpdate = { $set: patch };
    if (depCodeFrag?.unset) mongoUpdate.$unset = depCodeFrag.unset;

    const estadoMenResultante = patch.estado !== undefined ? patch.estado : currentProgram.estado;
    if (patch.activo_universidad === true && estadoMenResultante === 'Inactivo') {
      return res.status(400).json({
        error: 'No puedes activar el programa en universidad si está Inactivo ante MEN.',
      });
    }
    if (patch.estado === 'Inactivo') {
      mongoUpdate.$set.activo_universidad = false;
    }

    const program = await Program.findByIdAndUpdate(
      rawId,
      mongoUpdate,
      { new: true, runValidators: true }
    );
    if (!program) return res.status(404).json({ error: 'Programa no encontrado' });

    const programaIdStr = String(program._id);

    const camposRC = ['fecha_resolucion_rc', 'codigo_resolucion_rc', 'duracion_resolucion_rc'];
    const camposAV = ['fecha_resolucion_av', 'codigo_resolucion_av', 'duracion_resolucion_av'];
    const tocaRC   = camposRC.some(c => patch[c] !== undefined);
    const tocaAV   = camposAV.some(c => patch[c] !== undefined);

    // Helper: eliminar el PM hijo ligado a un proceso padre y sus fases
    const eliminarPMDeProceso = async (parentProc) => {
      if (!parentProc) return;
      const pm = await Process.findOne({
        program_code: programaIdStr,
        tipo_proceso: 'PM',
        parent_process_id: parentProc._id,
      });
      if (pm) {
        await Phase.deleteMany({ proceso_id: pm._id });
        await Process.findByIdAndDelete(pm._id);
      }
    };

    if (tocaRC) {
      const procRC = await Process.findOne({ program_code: programaIdStr, tipo_proceso: 'RC' });
      const offsetsRC = procRC ? {
        meses_inicio_antes_venc:    procRC.meses_inicio_antes_venc,
        meses_doc_par_antes_venc:   procRC.meses_doc_par_antes_venc,
        meses_digitacion_antes_venc:procRC.meses_digitacion_antes_venc,
        meses_radicado_antes_venc:  procRC.meses_radicado_antes_venc,
      } : undefined;
      const fechas = calcularFechas('RC', program.fecha_resolucion_rc, program.duracion_resolucion_rc, offsetsRC);
      await Process.findOneAndUpdate(
        { program_code: programaIdStr, tipo_proceso: 'RC' },
        { $set: fechas }
      );
      // Al cambiar la resolución del RC, el PM ligado queda obsoleto → eliminarlo
      await eliminarPMDeProceso(procRC);
    }
    if (tocaAV) {
      const procAV = await Process.findOne({ program_code: programaIdStr, tipo_proceso: 'AV' });
      const offsetsAV = procAV ? {
        meses_inicio_antes_venc:    procAV.meses_inicio_antes_venc,
        meses_doc_par_antes_venc:   procAV.meses_doc_par_antes_venc,
        meses_digitacion_antes_venc:procAV.meses_digitacion_antes_venc,
        meses_radicado_antes_venc:  procAV.meses_radicado_antes_venc,
      } : undefined;
      const fechas = calcularFechas('AV', program.fecha_resolucion_av, program.duracion_resolucion_av, offsetsAV);
      await Process.findOneAndUpdate(
        { program_code: programaIdStr, tipo_proceso: 'AV' },
        { $set: fechas }
      );
      // Al cambiar la resolución del AV, el PM ligado queda obsoleto → eliminarlo
      await eliminarPMDeProceso(procAV);
    }

    res.status(200).json(program);
  } catch (error) {
    console.error('Error actualizando programa:', error);
    if (error?.statusCode === 409) {
      return res.status(409).json({ error: error.message });
    }
    if (error?.code === 11000) {
      return res.status(409).json({ error: 'Ese código de programa ya está en uso.' });
    }
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
