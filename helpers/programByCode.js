const mongoose = require('mongoose');

/**
 * Localiza el programa asociado al valor guardado en proceso/alerta/reminder/historial como `program_code`.
 * - Forma canónica actual: `program_code` === `_id` del programa (ObjectId en string).
 * - Compatibilidad: si no es ObjectId válido o no hay match por id, intenta por `dep_code_programa` (datos viejos).
 */
async function findProgramByProcessCode(Program, code) {
  if (code == null) return null;
  const c = String(code).trim();
  if (!c) return null;

  if (mongoose.Types.ObjectId.isValid(c)) {
    const byId = await Program.findById(c);
    if (byId) return byId;
  }

  return Program.findOne({ dep_code_programa: c });
}

module.exports = { findProgramByProcessCode };
