const mongoose = require('mongoose');
const Phase = require('../models/phases');
const Process = require('../models/processes');
const Caso = require('../models/casos');

const phaseController = {};

/* GET /phases?proceso_id=xxx — fases de un proceso
 * GET /phases?proceso_ids=id1,id2,... — varios procesos (todas sus fases)
 * GET /phases?proceso_fase_actual=id1:n1|id2:n2|... — solo la fase n de cada proceso (tablero por facultad) */
phaseController.getByProcess = async (req, res) => {
  try {
    const pairsRaw = req.query.proceso_fase_actual;
    if (pairsRaw) {
      const parts = String(pairsRaw)
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      const or = [];
      for (const part of parts) {
        const colon = part.lastIndexOf(':');
        if (colon <= 0) continue;
        const idStr = part.slice(0, colon);
        const num = Number(part.slice(colon + 1));
        if (!mongoose.Types.ObjectId.isValid(idStr) || !Number.isFinite(num)) continue;
        or.push({ proceso_id: idStr, numero: num });
      }
      if (or.length === 0) {
        return res.status(400).json({ error: 'proceso_fase_actual vacío o inválido' });
      }
      const phases = await Phase.find({ $or: or })
        .sort({ proceso_id: 1, numero: 1 })
        .lean();
      return res.status(200).json(phases);
    }
    const many = req.query.proceso_ids;
    if (many) {
      const ids = String(many)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (ids.length === 0) return res.status(400).json({ error: 'proceso_ids vacío' });
      const phases = await Phase.find({ proceso_id: { $in: ids } })
        .sort({ proceso_id: 1, numero: 1 })
        .lean();
      return res.status(200).json(phases);
    }
    if (!req.query.proceso_id) {
      return res.status(400).json({ error: 'proceso_id, proceso_ids o proceso_fase_actual es requerido' });
    }
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
    const { nombre, responsables, completada, no_aplica, acto_admin_modo, fecha_completado, observaciones } = req.body;
    const update = {};
    if (nombre            !== undefined) update['actividades.$.nombre']            = nombre;
    if (responsables      !== undefined) update['actividades.$.responsables']      = responsables;
    if (completada        !== undefined) update['actividades.$.completada']        = completada;
    if (no_aplica         !== undefined) update['actividades.$.no_aplica']         = no_aplica;
    if (acto_admin_modo   !== undefined) update['actividades.$.acto_admin_modo']   = acto_admin_modo;
    if (fecha_completado  !== undefined) update['actividades.$.fecha_completado']  = fecha_completado;
    if (observaciones     !== undefined) update['actividades.$.observaciones']     = observaciones;

    const phasePrev = await Phase.findOne({ _id: req.params.id, 'actividades._id': req.params.actividadId });
    if (!phasePrev) return res.status(404).json({ error: 'Fase o actividad no encontrada' });
    const actPrev = phasePrev.actividades.id(req.params.actividadId);
    const prevNoAplica = !!actPrev.no_aplica;

    const phase = await Phase.findOneAndUpdate(
      { _id: req.params.id, 'actividades._id': req.params.actividadId },
      { $set: update },
      { new: true }
    );
    if (!phase) return res.status(404).json({ error: 'Fase o actividad no encontrada' });

    /* Propagar N/A a subactividades solo si no_aplica del cuerpo cambió respecto al valor guardado.
       Si no, ignorar (p. ej. completada:true suele ir con no_aplica:false aunque ya era false). */
    if (no_aplica !== undefined && !!no_aplica !== prevNoAplica) {
      const phaseCascade = await Phase.findById(req.params.id);
      if (phaseCascade) {
        const actC = phaseCascade.actividades.id(req.params.actividadId);
        if (actC) {
          if (no_aplica === true) {
            actC.subactividades.forEach((sub) => {
              sub.no_aplica = true;
              sub.completada = false;
              sub.fecha_completado = null;
            });
          } else {
            actC.subactividades.forEach((sub) => {
              sub.no_aplica = false;
            });
          }
          await phaseCascade.save();
          return res.status(200).json(phaseCascade);
        }
      }
    }

    // Auto-crear caso al completar "Información del caso" en fase 4
    if (completada === true && phase.numero === 4) {
      const act = phase.actividades.id(req.params.actividadId);
      const normNombre = (s) =>
        String(s ?? '')
          .trim()
          .toLowerCase()
          .normalize('NFD')
          .replace(/\p{M}/gu, '');
      if (act && normNombre(act.nombre) === normNombre('Información del caso')) {
        const existing = await Caso.findOne({ proceso_id: phase.proceso_id });
        if (!existing) await Caso.create({ proceso_id: phase.proceso_id });
      }
    }

    // Al cambiar acto_admin_modo en "Acto administrativo", resetear subactividades
    if (acto_admin_modo !== undefined) {
      const phase2 = await Phase.findOne({ _id: req.params.id });
      if (phase2) {
        const act = phase2.actividades.id(req.params.actividadId);
        if (act && act.nombre.trim().toLowerCase() === 'acto administrativo') {
          act.subactividades.forEach(sub => { sub.completada = false; sub.fecha_completado = null; });
          await phase2.save();
          return res.status(200).json(phase2);
        }
      }
    }

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
    const { nombre, completada, no_aplica, fecha_completado, observaciones } = req.body;
    const phase = await Phase.findById(req.params.id);
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });

    const act = phase.actividades.id(req.params.actividadId);
    if (!act) return res.status(404).json({ error: 'Actividad no encontrada' });

    const sub = act.subactividades.id(req.params.subactividadId);
    if (!sub) return res.status(404).json({ error: 'Subactividad no encontrada' });

    if (nombre           !== undefined) sub.nombre           = nombre;
    if (completada       !== undefined) sub.completada       = completada;
    if (no_aplica        !== undefined) sub.no_aplica        = no_aplica;
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

/* PUT /phases/:id/actividades/:actividadId/subactividades/reorder — reordenar subactividades
   body: { orden: ["id1", "id2", ...] } */
phaseController.reorderSubactividades = async (req, res) => {
  try {
    const { orden } = req.body;
    if (!Array.isArray(orden)) return res.status(400).json({ error: 'orden debe ser un array de IDs' });
    const phase = await Phase.findById(req.params.id);
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });
    const act = phase.actividades.id(req.params.actividadId);
    if (!act) return res.status(404).json({ error: 'Actividad no encontrada' });

    const subMap = new Map(act.subactividades.map(s => [String(s._id), s]));
    const reordenadas = orden.map(id => subMap.get(id)).filter(Boolean);
    act.subactividades.forEach(s => { if (!orden.includes(String(s._id))) reordenadas.push(s); });
    act.subactividades = reordenadas;
    await phase.save();
    res.status(200).json(phase);
  } catch (error) {
    console.error('Error reordenando subactividades:', error);
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

/* PUT /phases/:id/complete-all — marcar todas las actividades como completadas (sin avanzar fase; usar finish-phase) */
phaseController.completeAll = async (req, res) => {
  try {
    const phase = await Phase.findById(req.params.id);
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });

    phase.actividades.forEach(a => {
      a.completada = true;
      a.no_aplica = false;
    });
    await phase.save();

    const proceso = await Process.findById(phase.proceso_id);
    res.status(200).json({ fase: phase, proceso });
  } catch (error) {
    console.error('Error completando todas las actividades:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /phases/:id/revert-all — solo retrocede el número de fase del proceso (no desmarca actividades) */
phaseController.revertAll = async (req, res) => {
  try {
    const phase = await Phase.findById(req.params.id);
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });

    const proceso = await Process.findById(phase.proceso_id);
    if (proceso && phase.numero === proceso.fase_actual && phase.numero > 0) {
      proceso.fase_actual = phase.numero - 1;
      await proceso.save();
    }

    const phaseFresh = await Phase.findById(req.params.id);
    res.status(200).json({ fase: phaseFresh, proceso });
  } catch (error) {
    console.error('Error revirtiendo fase:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /phases/:id/mark-all-completed — marcar todas las actividades como hechas, sin avanzar de fase */
phaseController.markAllCompleted = async (req, res) => {
  try {
    const phase = await Phase.findById(req.params.id);
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });

    const hoy = new Date().toISOString().split('T')[0];
    phase.actividades.forEach(a => {
      a.completada = true;
      a.no_aplica  = false;
      if (!a.fecha_completado) a.fecha_completado = hoy;
      a.subactividades.forEach(s => {
        if (!s.no_aplica) {
          s.completada = true;
          if (!s.fecha_completado) s.fecha_completado = hoy;
        }
      });
    });
    await phase.save();
    res.status(200).json({ fase: phase });
  } catch (error) {
    console.error('Error marcando todas las actividades:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /phases/:id/finish-phase — avanzar a la siguiente fase (sin exigir actividades completas)
   RC/AV solo tienen fases 0-5; AE igual. PM tiene solo la fase 1 (plan de mejoramiento). */
phaseController.finishPhase = async (req, res) => {
  try {
    const phase = await Phase.findById(req.params.id);
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });

    const proceso = await Process.findById(phase.proceso_id);
    // RC/AV/AE: avanzar hasta fase 5 como máximo. PM: avanza internamente entre sus fases.
    const maxFaseNormal = 5;
    if (proceso && phase.numero === proceso.fase_actual && phase.numero < maxFaseNormal) {
      proceso.fase_actual = phase.numero + 1;
      await proceso.save();
    }

    res.status(200).json({ fase: phase, proceso });
  } catch (error) {
    console.error('Error finalizando fase:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

/* PUT /phases/:id/mark-all-no-aplica — marcar todas las actividades de una fase como No aplica */
phaseController.markAllNoAplicaFase6 = async (req, res) => {
  try {
    const phase = await Phase.findById(req.params.id);
    if (!phase) return res.status(404).json({ error: 'Fase no encontrada' });

    phase.actividades.forEach(a => {
      a.no_aplica = true;
      a.completada = false;
      a.fecha_completado = null;
      a.subactividades.forEach(s => {
        s.no_aplica = true;
        s.completada = false;
        s.fecha_completado = null;
      });
    });
    await phase.save();
    res.status(200).json({ fase: phase });
  } catch (error) {
    console.error('Error marcando fase como N/A:', error);
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
