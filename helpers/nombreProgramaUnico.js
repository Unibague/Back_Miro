/**
 * Unicidad de nombre de programa (comparación sin distinguir mayúsculas, espacios normalizados).
 */

function normalizarNombrePrograma(nombre) {
  return String(nombre ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * @param {import('mongoose').Model} Program
 * @param {string} nombre
 * @param {string|null|undefined} excludeId — _id a ignorar (actualización)
 * @returns {Promise<{ _id: import('mongoose').Types.ObjectId, nombre?: string }|null>}
 */
async function findProgramaMismoNombre(Program, nombre, excludeId = null) {
  const target = normalizarNombrePrograma(nombre).toLowerCase();
  if (!target) return null;

  const query = excludeId ? { _id: { $ne: excludeId } } : {};
  const rows = await Program.find(query).select('nombre').lean();

  return (
    rows.find((p) => normalizarNombrePrograma(p.nombre).toLowerCase() === target)
    ?? null
  );
}

/**
 * @param {import('mongoose').Model} Program
 * @param {string} nombre
 * @param {string|null|undefined} excludeId
 */
async function assertNombreProgramaDisponible(Program, nombre, excludeId = null) {
  const dup = await findProgramaMismoNombre(Program, nombre, excludeId);
  if (!dup) return;

  const label = normalizarNombrePrograma(nombre);
  const err = new Error(`Ya existe un programa con el nombre «${label}».`);
  err.statusCode = 409;
  throw err;
}

module.exports = {
  normalizarNombrePrograma,
  findProgramaMismoNombre,
  assertNombreProgramaDisponible,
};
