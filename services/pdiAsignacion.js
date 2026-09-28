const PdiMacroproyecto = require('../models/pdiMacroproyecto');
const PdiProyecto = require('../models/pdiProyecto');
const PdiAccionEstrategica = require('../models/pdiAccionEstrategica');
const PdiIndicador = require('../models/pdiIndicador');

// ¿La persona tiene algo asignado en el PDI (líder de macroproyecto, o
// responsable de proyecto, acción o indicador)? Si es así, ve "Mis proyectos
// PDI" con cualquier rol y aunque su perfil de acceso no incluya el PDI: la
// asignación ya es la autorización (ver pdiAsignado en users.getUserRoles).
// Solo abre SUS proyectos; el PDI completo sigue dependiendo del rol/perfil.
// Mismos criterios que matchesUserResponsable en
// Front_Miro/app/pdi/mis-indicadores/page.tsx: por correo o por nombre
// completo, sin distinguir mayúsculas ni espacios de los extremos.

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactInsensitive = (value) => new RegExp(`^\\s*${escapeRegex(value)}\\s*$`, 'i');

const isPdiAsignado = async ({ email, fullName }) => {
  const cleanEmail = String(email || '').trim();
  const cleanName = String(fullName || '').trim();
  if (!cleanEmail && !cleanName) return false;

  const values = [cleanEmail, cleanName].filter(Boolean).map(exactInsensitive);
  const anyOf = (fields) => ({
    $or: fields.flatMap((field) => values.map((value) => ({ [field]: value }))),
  });

  const checks = [
    [PdiMacroproyecto, ['lideres.email', 'lideres.nombre', 'lider', 'lider_email']],
    [PdiProyecto, ['responsables.email', 'responsables.nombre', 'responsable', 'responsable_email']],
    [PdiAccionEstrategica, ['responsables.email', 'responsables.nombre', 'responsable', 'responsable_email']],
    [PdiIndicador, ['responsable', 'responsable_email']],
  ];

  const results = await Promise.all(checks.map(([Model, fields]) => Model.exists(anyOf(fields))));
  return results.some(Boolean);
};

module.exports = { isPdiAsignado };
