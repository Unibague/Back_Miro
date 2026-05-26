/**
 * Código institucional opcional (`dep_code_programa`).
 * Vacío → no persistir el campo (índice unique sparse permite varios programas sin código).
 * Con valor → string recortado; unicidad la valida Mongo y comprobaciones explícitas.
 */

function trimDepCodePrograma(value) {
  if (value == null) return '';
  return String(value).trim();
}

/** Normaliza un objeto antes de `Program.create` / `new Program()`. */
function applyDepCodeProgramaToCreatePayload(doc) {
  if (!doc || !Object.prototype.hasOwnProperty.call(doc, 'dep_code_programa')) return;
  const trimmed = trimDepCodePrograma(doc.dep_code_programa);
  if (trimmed) {
    doc.dep_code_programa = trimmed;
  } else {
    delete doc.dep_code_programa;
  }
}

/**
 * Para actualizaciones: devuelve fragmentos `$set` / `$unset` o null si no viene en el body.
 * @param {*} rawValue valor del body (undefined = no tocar)
 */
function depCodeProgramaMongoUpdateFragments(rawValue) {
  if (rawValue === undefined) return null;
  const trimmed = trimDepCodePrograma(rawValue);
  if (trimmed) {
    return { set: { dep_code_programa: trimmed }, unset: null };
  }
  return { set: {}, unset: { dep_code_programa: 1 } };
}

module.exports = {
  trimDepCodePrograma,
  applyDepCodeProgramaToCreatePayload,
  depCodeProgramaMongoUpdateFragments,
};
