/** Mapeo actividad/subactividad → campo de fecha del caso (misma lógica que el front). */

const norm = (s) =>
  String(s ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');

const F4_ACT = {
  [norm('Montaje en plataforma')]: 'fecha_solicitud_radicado',
  [norm('Montaje en plataforma nuevo SACES')]: 'fecha_solicitud_radicado',
};
const F4_MONTAJE_INCLUYE = norm('montaje en plataforma');

const F5_ACT = {
  [norm('Acto administrativo')]: 'fecha_resolucion',
};

const F5_SUB = {
  [norm('Notificación del acto administrativo satisfactorio por parte del MEN')]: 'fecha_resolucion',
  [norm('Notificación del acto administrativo no satisfactorio por parte del MEN')]: 'fecha_resolucion',
  [norm('Notificación de solicitud de completitud por parte del MEN')]: 'fecha_notificacion_completitud',
  [norm('Elaboración de respuesta de la completitud')]: 'fecha_respuesta_completitud',
  [norm('Radicación del recurso de reposición en plataforma del MEN')]: 'fecha_resolucion_apelacion',
  [norm('Notificación de respuesta del MEN')]: 'fecha_respuesta_men',
};

function getCasoFechaKeyForActividad(faseNumero, nombre) {
  if (faseNumero === 4) {
    const n = norm(nombre);
    if (F4_ACT[n]) return F4_ACT[n];
    if (n.includes(F4_MONTAJE_INCLUYE)) return 'fecha_solicitud_radicado';
    return null;
  }
  if (faseNumero === 5) return F5_ACT[norm(nombre)] ?? null;
  return null;
}

function getCasoFechaKeyForSubactividad(faseNumero, nombre) {
  if (faseNumero !== 5) return null;
  return F5_SUB[norm(nombre)] ?? null;
}

function findActividadByCasoKey(fases, key) {
  for (const f of fases) {
    for (const a of f.actividades || []) {
      if (getCasoFechaKeyForActividad(f.fase_numero ?? f.numero, a.nombre) === key) {
        return { fase: f, act: a };
      }
    }
  }
  return null;
}

function findSubactividadByCasoKey(fases, key) {
  for (const f of fases) {
    for (const a of f.actividades || []) {
      for (const s of a.subactividades || []) {
        if (getCasoFechaKeyForSubactividad(f.fase_numero ?? f.numero, s.nombre) === key) {
          return { fase: f, act: a, sub: s };
        }
      }
    }
  }
  return null;
}

function dedupeDocs(list) {
  const seen = new Set();
  const out = [];
  for (const d of list) {
    const id = d._id ? String(d._id) : `${d.view_link}|${d.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(d);
  }
  return out;
}

module.exports = {
  getCasoFechaKeyForActividad,
  getCasoFechaKeyForSubactividad,
  findActividadByCasoKey,
  findSubactividadByCasoKey,
  dedupeDocs,
};
