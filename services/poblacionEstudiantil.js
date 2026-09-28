// Población estudiantil por periodo (ámbito Comunidad de Estudiantes), tomada
// de los informes de Admisiones y Registro. Son cifras oficiales ya
// consolidadas, que se muestran en el Tablero por fuera de las plantillas.
// Para agregar o corregir un periodo, editar este objeto: la clave es el
// nombre del periodo en Miró (colección "periods": "2025B", "2026A"...).

const FUENTE = 'Admisiones y Registro — actualización a agosto 2026. No incluye estudiantes en extensión con Honda.';

const POBLACION_ESTUDIANTIL_POR_PERIODO = {
  '2025B': {
    semestre: '2025-B',
    inscritos: 450,
    admitidos: 419,
    nuevos: 316,
    antiguos: 3882,
    total: 4198,
    porFacultad: [
      { name: 'Ingeniería', value: 1436 },
      { name: 'Humanidades', value: 996 },
      { name: 'Ciencias Económicas y Administrativas', value: 967 },
      { name: 'Derecho', value: 714 },
      { name: 'Ciencias Naturales y Matemáticas', value: 85 },
    ],
    fuente: FUENTE,
  },
  '2026A': {
    semestre: '2026-A',
    inscritos: 1071,
    admitidos: 1012,
    nuevos: 728,
    antiguos: 3635,
    total: 4363,
    // Nombres de las facultades de la nueva estructura, como aparecen
    // (recortados) en el informe: completar si se conoce el nombre oficial.
    porFacultad: [
      { name: 'Facultad de Derecho, Administración…', value: 1753 },
      { name: 'Facultad de Ciencias…', value: 1639 },
      { name: 'Facultad de Humanidades…', value: 971 },
    ],
    fuente: FUENTE,
  },
};

const normalizePeriodName = (name) => String(name ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const getPoblacionEstudiantil = (periodName) => {
  const key = normalizePeriodName(periodName);
  const entry = Object.entries(POBLACION_ESTUDIANTIL_POR_PERIODO)
    .find(([name]) => normalizePeriodName(name) === key);
  return entry ? entry[1] : null;
};

module.exports = { getPoblacionEstudiantil };
