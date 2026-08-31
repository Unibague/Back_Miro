const normalizeKey = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toUpperCase()
  .replace(/[^A-Z0-9]/g, '');

const asNumber = (value) => {
  const parsed = Number(String(value ?? '').replace(/,/g, '').trim());
  return Number.isFinite(parsed) ? parsed : 0;
};

const rowsAsObjects = (sheet) => {
  if (!sheet) return [];
  const headers = (sheet.headers || []).map(normalizeKey);
  return (sheet.rows || []).map((row) => Object.fromEntries(
    headers.map((header, index) => [header, row[index] ?? ''])
  ));
};

const addCount = (map, key, amount = 1) => {
  const cleanKey = String(key ?? '').trim() || 'Sin dato';
  map.set(cleanKey, (map.get(cleanKey) || 0) + amount);
};

// Encuentra la clave normalizada de un encabezado a partir de palabras clave
// que debe contener, en vez de exigir el texto exacto: los encabezados de
// algunas plantillas (ej. Estrategias Curriculares) son preguntas largas que
// cambian de redaccion de una carga a otra.
const findHeaderKey = (headers, keywords) => {
  const normalized = (headers || []).map(normalizeKey);
  const idx = normalized.findIndex((h) => keywords.every((keyword) => h.indexOf(keyword) !== -1));
  return idx === -1 ? null : normalized[idx];
};

// Cuando una celda de Excel mezcla formatos (ej. una frase en negrita seguida
// de texto normal), la carga original la guarda como el JSON crudo de
// ExcelJS ({"richText":[...]}) en vez del texto plano. Se reconstruye el
// texto uniendo los fragmentos, para no mostrar el JSON tal cual.
const extractPlainText = (value) => {
  const text = String(value ?? '').trim();
  if (!text.startsWith('{') || text.indexOf('richText') === -1) return text;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed.richText)) {
      return parsed.richText.map((run) => run.text || '').join('').trim();
    }
  } catch (e) {
    // No era JSON valido: se deja el texto tal cual llego.
  }
  return text;
};

const sortedDistribution = (map, limit) => {
  const values = Array.from(map.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  return limit ? values.slice(0, limit) : values;
};

// "Detalle por hoja": cada plantilla curada arma un arreglo de hojas, y cada
// hoja un arreglo de desgloses generico (dona o barra) en vez de un campo
// especifico por cada tipo de grafica — asi el mismo renderizador del front
// sirve para las ~20 plantillas sin tener que inflar la interfaz por cada
// una. `donutBreakdown`/`barBreakdown` arman un desglose a partir de un Map
// ya contado (o de un array ya ordenado con `fromValues`); se filtran los
// vacios al armar la hoja.
const donutBreakdown = (label, mapOrValues, limit) => ({
  label,
  type: 'donut',
  data: mapOrValues instanceof Map ? sortedDistribution(mapOrValues, limit) : mapOrValues,
});
const barBreakdown = (label, mapOrValues, limit) => ({
  label,
  type: 'bar',
  data: mapOrValues instanceof Map ? sortedDistribution(mapOrValues, limit) : mapOrValues,
});
const buildHoja = (nombre, totalRegistros, desgloses) => ({
  nombre,
  totalRegistros,
  desgloses: desgloses.filter((d) => d.data.length > 0),
});

// Campos "Si/No" de enfoque/contribucion que traen varias plantillas
// (promueve empatia, contribuye a la permanencia, cooperacion nacional o
// internacional, etc.): cuenta cuantos registros marcaron cada enfoque. Se
// resuelve por palabras clave en el nombre normalizado de la columna (no por
// texto exacto) porque el mismo set de preguntas aparece con columnas
// tituladas distinto segun la plantilla.
const ENFOQUE_FLAGS = [
  { match: 'COOPERACIONNACIONAL', label: 'Cooperación nacional' },
  { match: 'COOPERACIONINTERNACIONAL', label: 'Cooperación internacional' },
  { match: 'COMPRENSIONDELAREALIDADSOCIAL', label: 'Comprensión realidad social' },
  { match: 'PROMUEVELAEMPATIA', label: 'Empatía' },
  { match: 'PROMUEVELAETICA', label: 'Ética' },
  { match: 'HABILIDADESBLANDAS', label: 'Habilidades blandas' },
  { match: 'BILINGUISMO', label: 'Bilingüismo' },
  { match: 'OTRASCULTURASYLENGUAS', label: 'Relacionamiento intercultural' },
  { match: 'TRABAJOAUTONOMO', label: 'Trabajo autónomo' },
  { match: 'CONTRIBUYEALAPERMANENCIA', label: 'Permanencia' },
  { match: 'CONTRIBUYEALAGRADUACION', label: 'Graduación' },
  { match: 'DESARROLLOPROFESORAL', label: 'Desarrollo profesoral' },
  { match: 'FORMACIONINTEGRAL', label: 'Formación integral' },
  { match: 'SOSTENIBILIDADAMBIENTAL', label: 'Sostenibilidad ambiental' },
];

const analyzeEnfoques = (list) => {
  if (list.length === 0) return [];
  const sampleKeys = Object.keys(list[0]);
  const resolved = ENFOQUE_FLAGS
    .map((flag) => ({ ...flag, key: sampleKeys.find((k) => k.indexOf(flag.match) !== -1) }))
    .filter((flag) => flag.key);
  const counts = new Map();
  list.forEach((row) => {
    resolved.forEach((flag) => {
      if (String(row[flag.key] ?? '').trim().toUpperCase().startsWith('S')) addCount(counts, flag.label);
    });
  });
  return sortedDistribution(counts);
};

// En esta plantilla consolidada los codigos usados por las areas productoras
// son los acordados para el informe funcional solicitado por Bienestar.
const WELLBEING_UNITS = {
  '47': 'Bienestar Universitario',
  '5': 'Gestión Humana',
  '1': 'Gestión Humana',
};

const unitLabel = (code) => {
  const raw = String(code ?? '').trim();
  if (WELLBEING_UNITS[raw]) return WELLBEING_UNITS[raw];
  const normalized = normalizeKey(raw);
  if (normalized === 'GESTIONHUMANA') return 'Gestión Humana';
  if (normalized === 'BIENESTARUNIVERSITARIO') return 'Bienestar Universitario';
  return raw || 'Unidad sin identificar';
};

const parseDate = (value) => {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  const year = parsed.getFullYear();
  return year >= 2000 && year <= 2100 ? parsed : null;
};

// Coincide por nombre de archivo sin importar mayusculas/tildes/espacios NI
// el orden/plural exacto de las palabras (quien sube el archivo lo renombra
// de un periodo a otro: "DocentesHistoricoSNIES_2014_2024" un semestre,
// "DOCENTE HISTÓRICO_SNIES_2014_2025" el siguiente). Por eso se matchea por
// palabras clave contenidas, no por un prefijo exacto.
const fileNameKey = (fileName) => normalizeKey(String(fileName || '').replace(/\.XLSX?$/i, ''));
const hasAllKeywords = (key, keywords) => keywords.every((keyword) => key.indexOf(keyword) !== -1);

const isActividadBienestarFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['ACTIVIDAD', 'BIENESTAR']);

const buildActividadBienestarAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));

  const decorateActivities = (sheet, nature, fallbackCategory) => rowsAsObjects(sheet).map((row) => ({
    ...row,
    __CODE: String(row.CODIGOACTIVIDAD || row.CODIGOEVENTO || '').trim(),
    __DESCRIPTION: String(row.DESCRIPCIONACTIVIDAD || row.DESCRIPCIONEVENTO || '').trim(),
    __CATEGORY: String(row.IDTIPOACTIVIDADBIENESTAR || row.IDTIPOACTIVIDAD || fallbackCategory).trim(),
    __UNIT: unitLabel(row.CODIGOUNIDADORGANIZACIONAL || row.DEPENDENCIA),
    __NATURE: nature,
  }));

  const mainActivities = decorateActivities(
    sheets.get('ACTIVIDADBIENESTAR') || sheets.get('ACTIVIDADESBIENESTAR'),
    'Bienestar',
    'Bienestar'
  );
  const culturalActivities = decorateActivities(sheets.get('ACTIVIDADESCULTURAL'), 'Cultural', 'Actividad cultural');
  const culturalEvents = decorateActivities(sheets.get('EVENTOCULTURAL'), 'Evento cultural', 'Evento cultural');
  const activities = mainActivities.concat(culturalActivities, culturalEvents);

  const humanResources = rowsAsObjects(
    sheets.get('ACTBIENESTARRECHUMANO') || sheets.get('RECURSOHUMANOBIENESTARCULTUR')
  );
  const beneficiaryList = rowsAsObjects(
    sheets.get('LISTABENEFICIARIOS') || sheets.get('BENEFICIARIOBIENESTARCULTURAL')
  );
  const groupedBeneficiaries = rowsAsObjects(sheets.get('ACTBIENESTARBENEFICIARIOS'));
  if (activities.length === 0) return null;

  const activityByCode = new Map();
  const activitiesByUnit = new Map();
  const activitiesByCategory = new Map();
  const activitiesByNature = new Map();
  const activitiesByMonth = new Map();

  activities.forEach((activity) => {
    const code = activity.__CODE;
    if (code) activityByCode.set(code, activity);
    addCount(activitiesByUnit, activity.__UNIT);
    addCount(activitiesByCategory, activity.__CATEGORY);
    addCount(activitiesByNature, activity.__NATURE);

    const date = parseDate(activity.FECHAINICIO);
    if (date) {
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      addCount(activitiesByMonth, month);
    }
  });

  const beneficiariesByType = new Map();
  const beneficiariesByUnit = new Map();
  beneficiaryList.forEach((row) => {
    const code = String(row.CODIGOACTIVIDAD || row.CODIGOACTIVIDADEVENTO || '').trim();
    if (!code) return;
    if (groupedBeneficiaries.length === 0) {
      addCount(beneficiariesByType, row.ACTIVIDAD || row.RORESDISPONIBLES || 'Beneficiario registrado');
      addCount(beneficiariesByUnit, unitLabel(row.DEPENDENCIA || row.CODIGOUNIDADORGANIZACIONAL));
    }
  });

  groupedBeneficiaries.forEach((row) => {
    const amount = asNumber(row.CANTIDADBENEFICIARIOS);
    addCount(beneficiariesByType, row.IDTIPOBENEFICIARIO || 'Sin tipo', amount);
    addCount(beneficiariesByUnit, unitLabel(row.CODIGOUNIDADORGANIZACIONAL), amount);
  });

  const humanResourcesByUnit = new Map();
  const humanResourcesByCategory = new Map();
  humanResources.forEach((row) => {
    const code = String(row.CODIGOACTIVIDAD || '').trim();
    const activity = activityByCode.get(code) || {};
    const humanUnit = unitLabel(row.CODIGOUNIDADORGANIZACIONAL || row.DEPENDENCIA || activity.__UNIT);
    const humanCategory = activity.__CATEGORY || 'Sin categoría';
    addCount(humanResourcesByUnit, humanUnit);
    addCount(humanResourcesByCategory, humanCategory);
  });

  const externalBeneficiaries = activities.reduce(
    (sum, row) => sum + asNumber(row.CANTIDADBENEFICIARIOEXTERNO || row.CANTIDADBENEFICIARIOSEXTERNOS),
    0
  );
  const groupedBeneficiaryTotal = groupedBeneficiaries.reduce(
    (sum, row) => sum + asNumber(row.CANTIDADBENEFICIARIOS),
    0
  );
  const totalParticipations = beneficiaryList.reduce(
    (sum, row) => sum + asNumber(row.NUMERODEVECESQUEPARTICIPOENLAACTIVIDAD || row.NRODEVECESQUEPARTICIPOENLAACTIVIDADOSERVICIO),
    0
  );

  // Detalle por hoja: cada hoja fuente que compone este archivo trae su
  // propio mini-analisis (por unidad/categoria/mes/tipo, segun aplique),
  // en vez de mezclarse todas en el resumen general de arriba.
  const analyzeOrigenBeneficiarios = (list) => {
    let internos = 0;
    let externos = 0;
    list.forEach((row) => {
      internos += asNumber(row.CANTIDADBENEFICIARIOSINTERNOSSINREGISTRO);
      externos += asNumber(row.CANTIDADBENEFICIARIOEXTERNO || row.CANTIDADBENEFICIARIOSEXTERNOS);
    });
    const result = [];
    if (internos > 0) result.push({ name: 'Internos sin registro', value: internos });
    if (externos > 0) result.push({ name: 'Externos', value: externos });
    return result;
  };

  const analyzeActivityGroup = (list) => {
    const porCategoria = new Map();
    list.forEach((activity) => addCount(porCategoria, activity.__CATEGORY));
    return [
      donutBreakdown('Origen de beneficiarios', analyzeOrigenBeneficiarios(list)),
      barBreakdown('Por categoría', porCategoria),
      barBreakdown('Enfoques y contribuciones', analyzeEnfoques(list)),
    ];
  };

  // Unidad de cada fila, calculada una sola vez: se usa tanto para agregar
  // (analyze*) como para filtrar por dependencia (hojasPorDependencia), asi
  // que ambos caminos quedan siempre de acuerdo entre si.
  const humanResourceUnit = (row) => {
    const code = String(row.CODIGOACTIVIDAD || '').trim();
    const activity = activityByCode.get(code) || {};
    return unitLabel(row.CODIGOUNIDADORGANIZACIONAL || row.DEPENDENCIA || activity.__UNIT);
  };
  const beneficiaryUnit = (row) => unitLabel(row.DEPENDENCIA || row.CODIGOUNIDADORGANIZACIONAL);
  const groupedBeneficiaryUnit = (row) => unitLabel(row.CODIGOUNIDADORGANIZACIONAL);

  const analyzeHumanResourceRows = (rows) => {
    const porCategoria = new Map();
    const porPrograma = new Map();
    const porActividad = new Map();
    rows.forEach((row) => {
      const code = String(row.CODIGOACTIVIDAD || '').trim();
      const activity = activityByCode.get(code) || {};
      addCount(porCategoria, activity.__CATEGORY || 'Sin categoría');
      const programa = String(row.PROGRAMAODEPENDENCIA || '').trim();
      if (programa) addCount(porPrograma, programa);
      const nombreActividad = String(row.NOMBREACTIVIDADEVENTO || '').trim();
      if (nombreActividad) addCount(porActividad, nombreActividad);
    });
    return [
      barBreakdown('Por categoría', porCategoria),
      barBreakdown('Top programas académicos', porPrograma, 10),
      barBreakdown('Top actividades', porActividad, 10),
    ];
  };

  const analyzeBeneficiaryListRows = (rows) => {
    const porTipo = new Map();
    const porActividad = new Map();
    const porPrograma = new Map();
    rows.forEach((row) => {
      addCount(porTipo, row.ACTIVIDAD || row.RORESDISPONIBLES || 'Beneficiario registrado');
      const actividad = String(row.NOMBREACTIVIDADEVENTO || '').trim();
      if (actividad) addCount(porActividad, actividad);
      const programa = String(row.PROGRAMAODEPENDENCIA || '').trim();
      if (programa) addCount(porPrograma, programa);
    });
    return [
      donutBreakdown('Por tipo', porTipo),
      barBreakdown('Top programas académicos', porPrograma, 10),
      barBreakdown('Top actividades', porActividad, 10),
    ];
  };

  const analyzeGroupedBeneficiaryRows = (rows) => {
    const porTipo = new Map();
    rows.forEach((row) => addCount(porTipo, row.IDTIPOBENEFICIARIO || 'Sin tipo', asNumber(row.CANTIDADBENEFICIARIOS)));
    return [donutBreakdown('Por tipo', porTipo)];
  };

  // Arma las 6 tarjetas de "Detalle por hoja" a partir de las listas que se
  // le pasen: se usa tanto para el archivo completo como, filtrando cada
  // lista por unidad, para el desglose por dependencia de mas abajo.
  const buildHojas = (main, cultural, events, human, beneficiary, grouped) => [
    buildHoja('Actividades de Bienestar', main.length, analyzeActivityGroup(main)),
    buildHoja('Actividades Culturales', cultural.length, analyzeActivityGroup(cultural)),
    buildHoja('Eventos Culturales', events.length, analyzeActivityGroup(events)),
    buildHoja('Recurso Humano', human.length, analyzeHumanResourceRows(human)),
    buildHoja('Lista de Beneficiarios', beneficiary.length, analyzeBeneficiaryListRows(beneficiary)),
    buildHoja('Beneficiarios Agrupados', grouped.length, analyzeGroupedBeneficiaryRows(grouped)),
  ];

  const hojas = buildHojas(mainActivities, culturalActivities, culturalEvents, humanResources, beneficiaryList, groupedBeneficiaries);

  // Detalle por dependencia (unidad): reutiliza los mismos mapas ya
  // calculados arriba (actividades/beneficiarios/recurso humano por unidad)
  // para armar una sola tabla filtrable, en vez de recalcular desde cero.
  const unidades = new Set([
    ...activitiesByUnit.keys(),
    ...beneficiariesByUnit.keys(),
    ...humanResourcesByUnit.keys(),
  ]);
  const porDependencia = Array.from(unidades)
    .map((unidad) => ({
      dependencia: unidad,
      actividades: activitiesByUnit.get(unidad) || 0,
      beneficiarios: beneficiariesByUnit.get(unidad) || 0,
      recursoHumano: humanResourcesByUnit.get(unidad) || 0,
    }))
    .sort((a, b) => b.actividades - a.actividades);

  // El mismo "Detalle por hoja" pero recalculado solo con las filas de cada
  // dependencia, para que el filtro de arriba tambien afecte esta seccion.
  const hojasPorDependencia = {};
  unidades.forEach((unidad) => {
    hojasPorDependencia[unidad] = buildHojas(
      mainActivities.filter((row) => row.__UNIT === unidad),
      culturalActivities.filter((row) => row.__UNIT === unidad),
      culturalEvents.filter((row) => row.__UNIT === unidad),
      humanResources.filter((row) => humanResourceUnit(row) === unidad),
      beneficiaryList.filter((row) => beneficiaryUnit(row) === unidad),
      groupedBeneficiaries.filter((row) => groupedBeneficiaryUnit(row) === unidad)
    );
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    nature: activitiesByNature.size > 1 ? 'Bienestar y cultural' : 'Bienestar',
    totalActivities: activityByCode.size,
    registeredBeneficiaries: beneficiaryList.length,
    totalParticipations,
    groupedBeneficiaries: groupedBeneficiaryTotal,
    externalBeneficiaries,
    humanResourceRecords: humanResources.length,
    activitiesByUnit: sortedDistribution(activitiesByUnit),
    activitiesByCategory: sortedDistribution(activitiesByCategory),
    activitiesByNature: sortedDistribution(activitiesByNature),
    activitiesByMonth: sortedDistribution(activitiesByMonth)
      .sort((a, b) => a.name.localeCompare(b.name)),
    beneficiariesByType: sortedDistribution(beneficiariesByType),
    beneficiariesByUnit: sortedDistribution(beneficiariesByUnit),
    humanResourcesByUnit: sortedDistribution(humanResourcesByUnit),
    humanResourcesByCategory: sortedDistribution(humanResourcesByCategory),
    hojas,
    porDependencia,
    hojasPorDependencia,
  };
};

const isRepresentacionEstudiantilFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['REPRESENTACION', 'ESTUDIANTIL']);

// Resumen a la medida del archivo de Representación Estudiantil (Comunidad
// de Estudiantes): un registro por estudiante asignado a un comité/instancia
// (como Principal o Suplente), para un periodo de electividad. Se resume en
// cuantos comites, estudiantes y programas academicos participan, y como se
// distribuyen los registros por instancia, programa y tipo de candidato.
const buildRepresentacionEstudiantilAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const rows = rowsAsObjects(sheets.get('REPRESENTACIONESTUDIANTIL'));
  if (rows.length === 0) return null;

  const instanciaCounts = new Map();
  const programaCounts = new Map();
  const candidatoCounts = new Map();
  const dependenciaCounts = new Map();
  const periodoCounts = new Map();
  const estudiantes = new Set();

  rows.forEach((row) => {
    const instancia = String(row.INSTANCIA || '').trim();
    const programa = String(row.PROGRAMAODEPENDENCIA || '').trim();
    const candidato = String(row.CANDIDATO || '').trim();
    const dependencia = String(row.DEPENDENCIA || '').trim();
    const periodo = String(row.PERIODOELECTIVIDAD || '').trim();
    const estudiante = String(row.NOMBREIDENTIFICADO || '').trim();

    if (instancia) addCount(instanciaCounts, instancia);
    if (programa) addCount(programaCounts, programa);
    if (candidato) addCount(candidatoCounts, candidato);
    if (dependencia) addCount(dependenciaCounts, dependencia);
    if (periodo) addCount(periodoCounts, periodo);
    if (estudiante) estudiantes.add(estudiante);
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    dependencia: sortedDistribution(dependenciaCounts, 1)[0]?.name || 'Sin dato',
    periodoElectividad: sortedDistribution(periodoCounts, 1)[0]?.name || 'Sin dato',
    totalRegistros: rows.length,
    totalInstancias: instanciaCounts.size,
    totalEstudiantes: estudiantes.size,
    totalProgramas: programaCounts.size,
    porCandidato: sortedDistribution(candidatoCounts),
    porInstancia: sortedDistribution(instanciaCounts),
    porPrograma: sortedDistribution(programaCounts),
    hojas: [
      buildHoja('Representación Estudiantil', rows.length, [
        donutBreakdown('Principal vs. Suplente', candidatoCounts),
        barBreakdown('Por instancia', instanciaCounts, 15),
        barBreakdown('Por programa', programaCounts, 10),
      ]),
    ],
  };
};

const isPublicacionesAutoresFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['PUBLICACION', 'AUTOR']);

// Resumen a la medida del archivo de Publicaciones y Autores (Comunidad de
// Profesores): cruza PUBLICACIONES (una fila por publicación) con
// AUTORES_PUBLICACIONES (una fila por autor de cada publicación) para
// mostrar cuantas publicaciones hay, de que tipo, y quienes las escriben
// (internos/externos, por programa).
const buildPublicacionesAutoresAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const publicaciones = rowsAsObjects(sheets.get('PUBLICACIONES'));
  const autores = rowsAsObjects(sheets.get('AUTORESPUBLICACIONES'));
  if (publicaciones.length === 0) return null;

  const tipoCounts = new Map();
  const dependenciaCounts = new Map();
  const publicacionesPorMesCounts = new Map();
  publicaciones.forEach((row) => {
    const tipo = String(row.TIPODEPUBLICACION || '').trim();
    const dependencia = String(row.DEPENDENCIA || '').trim();
    if (tipo) addCount(tipoCounts, tipo);
    if (dependencia) addCount(dependenciaCounts, dependencia);

    const date = parseDate(row.FECHADEPUBLICACION);
    if (date) {
      const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      addCount(publicacionesPorMesCounts, month);
    }
  });

  const origenCounts = new Map();
  const programaCounts = new Map();
  const autoresUnicos = new Set();
  autores.forEach((row) => {
    const origen = String(row.AUTORESEXTERNOOINTERNO || '').trim();
    const programa = String(row.PROGRAMAODEPENDENCIA || '').trim();
    const nombre = String(row.NOMBREIDENTIFICADO || '').trim();

    if (origen) addCount(origenCounts, origen);
    if (programa) addCount(programaCounts, programa);
    if (nombre && normalizeKey(nombre) !== 'NOIDENTIFICADO') autoresUnicos.add(nombre);
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalPublicaciones: publicaciones.length,
    totalRegistrosAutoria: autores.length,
    totalAutoresUnicos: autoresUnicos.size,
    porTipo: sortedDistribution(tipoCounts),
    porDependencia: sortedDistribution(dependenciaCounts),
    porOrigenAutor: sortedDistribution(origenCounts),
    porPrograma: sortedDistribution(programaCounts, 10),
    publicacionesPorMes: sortedDistribution(publicacionesPorMesCounts)
      .sort((a, b) => a.name.localeCompare(b.name)),
    hojas: [
      buildHoja('Publicaciones', publicaciones.length, [
        donutBreakdown('Por tipo', tipoCounts),
        barBreakdown('Por dependencia', dependenciaCounts, 10),
      ]),
      buildHoja('Autores de publicaciones', autores.length, [
        donutBreakdown('Origen del autor', origenCounts),
        barBreakdown('Por programa', programaCounts, 10),
      ]),
    ],
  };
};

const isDocentesHistoricoSniesFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['DOCENTE', 'HISTORICO', 'SNIES']);

// Resumen a la medida del archivo Docentes Historico SNIES (Comunidad de
// Profesores): historico anual de contratacion docente (SNIES_Contrato) mas
// su nivel de formacion (SNIES_Estudio). Se resume la evolucion de docentes
// distintos por año, y una fotografia del periodo mas reciente (dedicacion,
// escalafon, dependencia y nivel de formacion), en vez de sumar los 11 años
// de historia como si fueran del mismo periodo.
const buildDocentesHistoricoSniesAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const contrato = rowsAsObjects(sheets.get('SNIESCONTRATO'));
  const estudio = rowsAsObjects(sheets.get('SNIESESTUDIO'));
  if (contrato.length === 0) return null;

  const docentesPorAnoSets = new Map();
  const allDocumentos = new Set();
  let latestPeriodKey = '';
  let latestAno = '';
  let latestSemestre = '';

  contrato.forEach((row) => {
    const documento = String(row.DOCUMENTO || '').trim();
    const ano = String(row.ANO || '').trim();
    const semestre = String(row.SEMESTRE || '').trim();
    if (documento) allDocumentos.add(documento);
    if (ano && documento) {
      if (!docentesPorAnoSets.has(ano)) docentesPorAnoSets.set(ano, new Set());
      docentesPorAnoSets.get(ano).add(documento);
    }
    const periodKey = `${ano}-${semestre}`;
    if (periodKey > latestPeriodKey) {
      latestPeriodKey = periodKey;
      latestAno = ano;
      latestSemestre = semestre;
    }
  });

  const docentesPorAno = Array.from(docentesPorAnoSets.entries())
    .map(([ano, set]) => ({ name: ano, value: set.size }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const latestContratoRows = contrato.filter(
    (row) => String(row.ANO || '').trim() === latestAno && String(row.SEMESTRE || '').trim() === latestSemestre
  );
  const dedicacionCounts = new Map();
  const escalafonCounts = new Map();
  const dependenciaCounts = new Map();
  latestContratoRows.forEach((row) => {
    addCount(dedicacionCounts, row.DEDICACION || 'Sin dato');
    addCount(escalafonCounts, row.ESCALAFON || 'Sin escalafón');
    // Algunos periodos (ej. 2025-2) llegan con "Dependencia" vacio aunque
    // "Programa o dependencia" si este diligenciado; se usa como respaldo
    // para no perder el dato de a que programa/dependencia pertenece.
    addCount(dependenciaCounts, row.DEPENDENCIA || row.PROGRAMAODEPENDENCIA || 'Sin dependencia');
  });

  const latestEstudioRows = estudio.filter(
    (row) => String(row.ANO || '').trim() === latestAno && String(row.SEMESTRE || '').trim() === latestSemestre
  );
  const nivelFormacionCounts = new Map();
  latestEstudioRows.forEach((row) => {
    addCount(nivelFormacionCounts, row.MAXNIVELFORMACION || 'Sin dato');
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    anoInicio: docentesPorAno[0]?.name || '',
    anoFin: docentesPorAno[docentesPorAno.length - 1]?.name || '',
    periodoActual: latestSemestre ? `${latestAno} - Semestre ${latestSemestre}` : latestAno,
    totalDocentesHistorico: allDocumentos.size,
    docentesPeriodoActual: latestContratoRows.length,
    docentesPorAno,
    dedicacionPeriodoActual: sortedDistribution(dedicacionCounts),
    escalafonPeriodoActual: sortedDistribution(escalafonCounts),
    dependenciaPeriodoActual: sortedDistribution(dependenciaCounts, 10),
    nivelFormacionPeriodoActual: sortedDistribution(nivelFormacionCounts),
    hojas: [
      buildHoja(`Contrato (${latestSemestre ? `${latestAno}-${latestSemestre}` : latestAno})`, latestContratoRows.length, [
        donutBreakdown('Dedicación', dedicacionCounts),
        donutBreakdown('Escalafón', escalafonCounts),
        barBreakdown('Por dependencia', dependenciaCounts, 10),
      ]),
      buildHoja(`Estudio / formación (${latestSemestre ? `${latestAno}-${latestSemestre}` : latestAno})`, latestEstudioRows.length, [
        donutBreakdown('Máximo nivel de formación', nivelFormacionCounts),
      ]),
    ],
  };
};

const isRutasAprendizajeFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['RUTA', 'APRENDIZAJE']);

// Resumen a la medida de Rutas de Aprendizaje (Estructura y Procesos
// Académicos): un registro por estudiante matriculado en una ruta. Se
// resume en cuantas rutas, estudiantes y programas participan, cuantas
// insignias se han entregado, y como se distribuyen los matriculados por
// ruta y por programa.
const buildRutasAprendizajeAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const rows = rowsAsObjects(sheets.get('RUTASDEAPRENDIZAJE'));
  if (rows.length === 0) return null;

  const rutaCounts = new Map();
  const programaCounts = new Map();
  const estudiantes = new Set();
  let totalInsignias = 0;

  rows.forEach((row) => {
    const ruta = String(row.NOMBREDELARUTADEAPRENDIZAJE || '').trim();
    const programa = String(row.PROGRAMAODEPENDENCIA || '').trim();
    const estudiante = String(row.NOMBREIDENTIFICADO || '').trim();
    const entregada = String(row.INSIGNIAENTREGADA || '').trim().toUpperCase().startsWith('S');

    if (ruta) {
      const entry = rutaCounts.get(ruta) || { ruta, matriculados: 0, insignias: 0 };
      entry.matriculados += 1;
      if (entregada) entry.insignias += 1;
      rutaCounts.set(ruta, entry);
    }
    if (programa) addCount(programaCounts, programa);
    if (estudiante) estudiantes.add(estudiante);
    if (entregada) totalInsignias += 1;
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalMatriculados: rows.length,
    totalEstudiantesUnicos: estudiantes.size,
    totalRutas: rutaCounts.size,
    totalInsigniasEntregadas: totalInsignias,
    rutas: Array.from(rutaCounts.values()).sort((a, b) => b.matriculados - a.matriculados),
    porPrograma: sortedDistribution(programaCounts, 10),
    hojas: [
      buildHoja('Rutas de Aprendizaje', rows.length, [
        barBreakdown(
          'Top rutas (matriculados)',
          Array.from(rutaCounts.values())
            .sort((a, b) => b.matriculados - a.matriculados)
            .slice(0, 10)
            .map((r) => ({ name: r.ruta, value: r.matriculados }))
        ),
        barBreakdown('Por programa', programaCounts, 10),
      ]),
    ],
  };
};

const isPracticasAcademicasFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['PRACTICA', 'ACADEMIC']);

// Resumen a la medida de Prácticas Académicas (Estructura y Procesos
// Académicos): un registro por estudiante en práctica (ESTADISTICA_PRACTICAS),
// mas el catalogo de empresas registradas (EMPRESAS_PRACTICAS) para mostrar
// en que sectores estan esas empresas. NOTA: no se cruzan ambas hojas por
// empresa porque EMPRESAS_PRACTICAS no guarda el NIT en un campo propio (su
// "ID_EMPRESA" es en realidad el TIPO de documento), asi que no hay forma de
// unirla con el ID numerico de empresa que si trae ESTADISTICA_PRACTICAS.
const buildPracticasAcademicasAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const estadistica = rowsAsObjects(sheets.get('ESTADISTICAPRACTICAS'));
  const empresas = rowsAsObjects(sheets.get('EMPRESASPRACTICAS'));
  if (estadistica.length === 0) return null;

  const empresaCounts = new Map();
  const modalidadCounts = new Map();
  const programaCounts = new Map();
  let logroSum = 0;
  let logroCount = 0;

  estadistica.forEach((row) => {
    const empresa = String(row.IDEMPRESA || '').trim();
    const modalidad = String(row.TIPOMODALIDAD || '').trim();
    const programa = String(row.PROGRAMAODEPENDENCIA || '').trim();
    const logro = asNumber(row.LOGRO);

    if (empresa) addCount(empresaCounts, empresa);
    if (modalidad) addCount(modalidadCounts, modalidad);
    if (programa) addCount(programaCounts, programa);
    if (String(row.LOGRO || '').trim() && logro > 0) {
      logroSum += logro;
      logroCount += 1;
    }
  });

  const sectorCounts = new Map();
  empresas.forEach((row) => {
    const sector = String(row.SECTOREMPRESA || '').trim();
    if (sector) addCount(sectorCounts, sector);
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalEstudiantes: estadistica.length,
    totalEmpresas: empresaCounts.size,
    promedioLogro: logroCount > 0 ? logroSum / logroCount : null,
    porModalidad: sortedDistribution(modalidadCounts),
    porPrograma: sortedDistribution(programaCounts, 10),
    porEmpresa: sortedDistribution(empresaCounts, 10),
    porSectorEmpresasRegistradas: sortedDistribution(sectorCounts),
    hojas: [
      buildHoja('Estadística de prácticas', estadistica.length, [
        donutBreakdown('Por modalidad', modalidadCounts),
        barBreakdown('Por programa', programaCounts, 10),
        barBreakdown('Por empresa', empresaCounts, 10),
      ]),
      buildHoja('Empresas registradas', empresas.length, [
        donutBreakdown('Por sector', sectorCounts),
      ]),
    ],
  };
};

const isEstrategiasCurricularesFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['ESTRATEGIA', 'CURRICULAR']);

// Resumen a la medida de Estrategias Curriculares (Estructura y Procesos
// Académicos): un registro por estrategia. Los encabezados de esta plantilla
// son preguntas largas ("¿La estrategia tiene alguno de los siguientes
// enfoques?"), por eso se ubican por palabras clave (findHeaderKey) en vez de
// por el texto exacto.
const buildEstrategiasCurricularesAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const sheet = sheets.get('ESTRATEGIASCURRICULARES');
  const rows = rowsAsObjects(sheet);
  if (rows.length === 0) return null;

  const programaKey = findHeaderKey(sheet.headers, ['PROGRAMA']) || findHeaderKey(sheet.headers, ['DEPENDENCIA']);
  const tipoKey = findHeaderKey(sheet.headers, ['TIPO', 'ESTRATEGIA', 'CURRICULAR']);
  const nacionalKey = findHeaderKey(sheet.headers, ['NACIONAL', 'INTERNACIONAL']);
  const enfoqueMetodologiaKey = findHeaderKey(sheet.headers, ['ENFOQUE', 'METODOLOG']);
  const funcionKey = findHeaderKey(sheet.headers, ['FUNCION', 'SUSTANTIVA']);
  const dimensionKey = findHeaderKey(sheet.headers, ['DIMENSION', 'FORMACION']);

  const programaCounts = new Map();
  const tipoCounts = new Map();
  const nacionalCounts = new Map();
  const enfoqueMetodologiaCounts = new Map();
  const funcionCounts = new Map();
  const dimensionCounts = new Map();

  rows.forEach((row) => {
    if (programaKey) addCount(programaCounts, row[programaKey]);
    if (tipoKey) addCount(tipoCounts, row[tipoKey]);
    if (nacionalKey) addCount(nacionalCounts, row[nacionalKey]);
    if (enfoqueMetodologiaKey) addCount(enfoqueMetodologiaCounts, row[enfoqueMetodologiaKey]);
    if (funcionKey) addCount(funcionCounts, row[funcionKey]);
    if (dimensionKey) addCount(dimensionCounts, row[dimensionKey]);
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalEstrategias: rows.length,
    totalProgramas: programaCounts.size,
    porTipo: sortedDistribution(tipoCounts),
    porNacionalInternacional: sortedDistribution(nacionalCounts),
    porEnfoqueMetodologia: sortedDistribution(enfoqueMetodologiaCounts),
    porFuncionSustantiva: sortedDistribution(funcionCounts),
    porDimensionFormacion: sortedDistribution(dimensionCounts),
    porPrograma: sortedDistribution(programaCounts, 10),
    hojas: [
      buildHoja('Estrategias Curriculares', rows.length, [
        donutBreakdown('Por tipo', tipoCounts),
        donutBreakdown('Nacional / internacional', nacionalCounts),
        barBreakdown('Función sustantiva', funcionCounts),
        barBreakdown('Dimensión de formación', dimensionCounts),
        barBreakdown('Enfoques y contribuciones', analyzeEnfoques(rows)),
        barBreakdown('Por programa', programaCounts, 10),
      ]),
    ],
  };
};

const isCapacitacionFuncionariosFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['CAPACITACION', 'FUNCIONARIO']);

// Resumen a la medida de Capacitación y Formación de Funcionarios (Gestión
// Institucional): un registro por capacitación tomada por un funcionario.
const buildCapacitacionFuncionariosAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const sheet = [...sheets.values()].find((s) => normalizeKey(s.name).indexOf('CAPACITACIONFORMACION') === 0);
  const rows = rowsAsObjects(sheet);
  if (rows.length === 0) return null;

  const beneficiarios = new Set();
  const tipoCapacitacionCounts = new Map();
  const tipoCursoCounts = new Map();
  const programaCounts = new Map();
  const cursoCounts = new Map();
  let totalHoras = 0;

  rows.forEach((row) => {
    const beneficiario = String(row.NOMBREBENEFICIARIO || '').trim();
    const programa = String(row.PROGRAMADEPENDENCIA || '').trim();
    const tipoCapacitacion = String(row.IDTIPOCAPACITACION || '').trim();
    const tipoCurso = String(row.IDTIPOCURSO || '').trim();
    const curso = String(row.NOMBRECURSO || '').trim();

    if (beneficiario && normalizeKey(beneficiario) !== 'NOIDENTIFICADO') beneficiarios.add(beneficiario);
    if (programa) addCount(programaCounts, programa);
    if (tipoCapacitacion) addCount(tipoCapacitacionCounts, tipoCapacitacion);
    if (tipoCurso) addCount(tipoCursoCounts, tipoCurso);
    if (curso) addCount(cursoCounts, curso);
    totalHoras += asNumber(row.NUMHORASCURSADAS);
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalCapacitaciones: rows.length,
    totalBeneficiariosUnicos: beneficiarios.size,
    totalHorasCursadas: totalHoras,
    porTipoCapacitacion: sortedDistribution(tipoCapacitacionCounts),
    porTipoCurso: sortedDistribution(tipoCursoCounts),
    porPrograma: sortedDistribution(programaCounts, 10),
    topCursos: sortedDistribution(cursoCounts, 10),
    hojas: [
      buildHoja('Capacitación y Formación de Funcionarios', rows.length, [
        donutBreakdown('Por tipo de capacitación', tipoCapacitacionCounts),
        donutBreakdown('Por tipo de curso', tipoCursoCounts),
        barBreakdown('Por programa/dependencia', programaCounts, 10),
        barBreakdown('Top cursos', cursoCounts, 10),
      ]),
    ],
  };
};

const isConveniosCooperacionFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['CONVENIO', 'COOPERACION']);

// Resumen a la medida de Convenios de Cooperación (Gestión Institucional):
// un registro por convenio.
const buildConveniosCooperacionAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const sheet = [...sheets.values()].find((s) => normalizeKey(s.name).indexOf('CONVENIOSDECOOPERACION') === 0);
  const rows = rowsAsObjects(sheet);
  if (rows.length === 0) return null;

  const tipoConvenioCounts = new Map();
  const tipologiaCounts = new Map();
  const origenCounts = new Map();
  const academicoCounts = new Map();
  const alcanceCounts = new Map();
  const areaResponsableCounts = new Map();
  const institucionesAsociadas = new Set();
  let totalActivos = 0;
  let totalUsuarios = 0;

  rows.forEach((row) => {
    const tipoConvenio = String(row.IDTIPOCONVENIO || '').trim();
    const tipologia = String(row.TIPOLOGIACONVENIO || '').trim();
    const origen = String(row.ORIGENCONVENIO || '').trim();
    const academico = String(row.ACADEMICONOACADEMICO || '').trim();
    const alcance = String(row.ALCANCE || '').trim();
    const area = String(row.AREARESPONSABLE || '').trim();
    const institucion = String(row.INSTITUCIONASOCIADACOOPERANTE || '').trim();

    if (tipoConvenio) addCount(tipoConvenioCounts, tipoConvenio);
    if (tipologia) addCount(tipologiaCounts, tipologia);
    if (origen) addCount(origenCounts, origen);
    if (academico) addCount(academicoCounts, academico);
    if (alcance) addCount(alcanceCounts, alcance);
    if (area) addCount(areaResponsableCounts, area);
    if (institucion) institucionesAsociadas.add(institucion);
    if (normalizeKey(row.ACTIVONOACTIVO).indexOf('ACTIVO') === 0) totalActivos += 1;
    totalUsuarios += asNumber(row.NDEUSUARIOS);
  });

  const actividadCounts = new Map();
  const ACTIVIDAD_CONVENIO_FLAGS = [
    { key: 'ACTIVIDADFORMACION', label: 'Formación' },
    { key: 'ACTIVIDADINVESTIGACION', label: 'Investigación' },
    { key: 'ACTIVIDADEXTENSION', label: 'Extensión' },
    { key: 'ACTIVIDADADMINISTRATIVA', label: 'Administrativa' },
  ];
  rows.forEach((row) => {
    ACTIVIDAD_CONVENIO_FLAGS.forEach((flag) => {
      if (String(row[flag.key] ?? '').trim().toUpperCase().startsWith('S')) addCount(actividadCounts, flag.label);
    });
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalConvenios: rows.length,
    totalActivos,
    totalUsuarios,
    totalInstitucionesAsociadas: institucionesAsociadas.size,
    porTipoConvenio: sortedDistribution(tipoConvenioCounts),
    porTipologia: sortedDistribution(tipologiaCounts, 10),
    porOrigen: sortedDistribution(origenCounts),
    porAcademicoNoAcademico: sortedDistribution(academicoCounts),
    porAlcance: sortedDistribution(alcanceCounts),
    porAreaResponsable: sortedDistribution(areaResponsableCounts, 10),
    hojas: [
      buildHoja('Convenios de Cooperación', rows.length, [
        donutBreakdown('Por tipo de convenio', tipoConvenioCounts),
        donutBreakdown('Académico / no académico', academicoCounts),
        barBreakdown('Por tipología', tipologiaCounts, 10),
        barBreakdown('Por área responsable', areaResponsableCounts, 10),
        barBreakdown('Actividades que cubre', actividadCounts),
      ]),
    ],
  };
};

const isEstimulosFuncionariosFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['ESTIMULO', 'FUNCIONARIO']);

// Resumen a la medida de Estímulos a Funcionarios (Gestión Institucional):
// un registro por estímulo otorgado. VALOR_ESTIMULO no se suma porque es
// texto libre en unidades distintas (dias, horas semanales, etc.), no un
// numero en una unidad consistente.
const buildEstimulosFuncionariosAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const sheet = [...sheets.values()].find((s) => normalizeKey(s.name).indexOf('ESTIMULOSFUNCIONARIOS') === 0);
  const rows = rowsAsObjects(sheet);
  if (rows.length === 0) return null;

  const funcionarios = new Set();
  const tipoEstimuloCounts = new Map();
  const dependenciaCounts = new Map();
  const programaCounts = new Map();

  rows.forEach((row) => {
    const funcionario = String(row.NOMBREIDENTIFICADO || '').trim();
    const tipo = String(row.TIPOESTIMULO || '').trim();
    const dependencia = String(row.DEPENDENCIAQUEREPORTA || '').trim();
    const programa = String(row.PROGRAMADEPENDENCIABENEFICIARIO || '').trim();

    if (funcionario && normalizeKey(funcionario) !== 'NOIDENTIFICADO') funcionarios.add(funcionario);
    if (tipo) addCount(tipoEstimuloCounts, tipo);
    if (dependencia) addCount(dependenciaCounts, dependencia);
    if (programa) addCount(programaCounts, programa);
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalEstimulos: rows.length,
    totalFuncionariosUnicos: funcionarios.size,
    porTipoEstimulo: sortedDistribution(tipoEstimuloCounts),
    porDependenciaQueReporta: sortedDistribution(dependenciaCounts),
    porPrograma: sortedDistribution(programaCounts, 10),
    hojas: [
      buildHoja('Estímulos a Funcionarios', rows.length, [
        donutBreakdown('Por tipo de estímulo', tipoEstimuloCounts),
        barBreakdown('Dependencia que reporta', dependenciaCounts, 10),
        barBreakdown('Por programa/dependencia beneficiaria', programaCounts, 10),
      ]),
    ],
  };
};

const isOtrasEstrategiasFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['OTRA', 'ESTRATEGIA']);

// Resumen a la medida de Otras Estrategias (Gestión Institucional): cruza
// OTRAS_ESTRATEGIAS (una fila por estrategia) con
// PARTICIPANTE_OTRAS_ESTRATEGIAS (una fila por participante) por
// ID_ESTRATEGIA, igual criterio que Bienestar: si un codigo de participante
// no tiene estrategia definida en el mismo archivo, se deja explicito el
// codigo en vez de repetir un texto generico.
const buildOtrasEstrategiasAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const estrategiaRows = rowsAsObjects(sheets.get('OTRASESTRATEGIAS'));
  const participanteRows = rowsAsObjects(sheets.get('PARTICIPANTEOTRASESTRATEGIAS'));
  if (estrategiaRows.length === 0) return null;

  const estrategiaByCode = new Map();
  const categoriaCounts = new Map();
  const tipologiaCounts = new Map();
  const comunidadCounts = new Map();
  const poblacionCounts = new Map();
  let cooperacionNacional = 0;
  let cooperacionInternacional = 0;

  estrategiaRows.forEach((row) => {
    const codigo = String(row.IDESTRATEGIA || '').trim();
    const descripcion = extractPlainText(row.DESCRIPCION);
    const categoria = String(row.CATEGORIA || '').trim();
    const tipologia = String(row.TIPOLOGIA || '').trim();
    if (codigo) estrategiaByCode.set(codigo, { descripcion, categoria, tipologia });
    if (categoria) addCount(categoriaCounts, categoria);
    if (tipologia) addCount(tipologiaCounts, tipologia);

    const comunidad = String(row.COMUNIDADOSECTOREXTERNOVINCULADO || '').trim();
    if (comunidad) addCount(comunidadCounts, comunidad);
    const poblacion = String(row.POBLACIONIMPACTADA || '').trim();
    if (poblacion) addCount(poblacionCounts, poblacion);

    if (String(row.ESUNAACTIVIDADDECOOPERACIONNACIONAL || '').trim().toUpperCase().startsWith('S')) cooperacionNacional += 1;
    if (String(row.ESUNAACTIVIDADDECOOPERACIONINTERNACIONAL || '').trim().toUpperCase().startsWith('S')) cooperacionInternacional += 1;
  });

  const participantesPorEstrategia = new Map();
  const participantesUnicos = new Set();
  participanteRows.forEach((row) => {
    const codigo = String(row.IDESTRATEGIA || '').trim();
    const nombre = String(row.NOMBREIDENTIFICADO || '').trim();
    if (codigo) addCount(participantesPorEstrategia, codigo);
    if (nombre && normalizeKey(nombre) !== 'NOIDENTIFICADO') participantesUnicos.add(nombre);
  });

  const topEstrategiasPorParticipantes = sortedDistribution(participantesPorEstrategia, 10).map((entry) => {
    const info = estrategiaByCode.get(entry.name) || {};
    return {
      name: info.descripcion || `Estrategia sin descripción (código ${entry.name})`,
      value: entry.value,
    };
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalEstrategias: estrategiaRows.length,
    totalRegistrosParticipacion: participanteRows.length,
    totalParticipantesUnicos: participantesUnicos.size,
    cooperacionNacional,
    cooperacionInternacional,
    porCategoria: sortedDistribution(categoriaCounts),
    porTipologia: sortedDistribution(tipologiaCounts),
    porComunidadSectorExterno: sortedDistribution(comunidadCounts, 10),
    porPoblacionImpactada: sortedDistribution(poblacionCounts),
    topEstrategiasPorParticipantes,
    hojas: [
      buildHoja('Otras Estrategias', estrategiaRows.length, [
        donutBreakdown('Por categoría', categoriaCounts),
        barBreakdown('Por tipología', tipologiaCounts, 10),
        barBreakdown('Población impactada', poblacionCounts),
        barBreakdown('Enfoques y contribuciones', analyzeEnfoques(estrategiaRows)),
      ]),
      buildHoja('Participantes de otras estrategias', participanteRows.length, [
        barBreakdown('Top estrategias por participantes', topEstrategiasPorParticipantes),
      ]),
    ],
  };
};

const isPazYRegionFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['PAZ', 'REGION']);

// Resumen a la medida de Paz y Región (Interacción con el Entorno): un
// registro por estudiante vinculado a un proyecto en un municipio/entidad.
const buildPazYRegionAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const rows = rowsAsObjects(sheets.get('PAZYREGION'));
  if (rows.length === 0) return null;

  const estudiantes = new Set();
  const proyectos = new Set();
  const entidades = new Set();
  const municipios = new Map();
  const asesores = new Set();
  const departamentoCounts = new Map();
  const zonaCounts = new Map();
  const odsCounts = new Map();
  const lineaCounts = new Map();
  const tipoEntidadCounts = new Map();
  const programaCounts = new Map();
  let cooperacionInternacional = 0;

  rows.forEach((row) => {
    const estudiante = String(row.NOMBREIDENTIFICADOESTUDIANTE || '').trim();
    const proyecto = String(row.CODPROYECTO || '').trim();
    const entidad = String(row.CODENTIDAD || '').trim();
    const municipio = String(row.IDMUNICIPIO || '').trim();
    const asesor = String(row.NOMBREIDENTIFICADOASESOR || '').trim();
    const programa = String(row.PROGRAMAESTUDIANTE || '').trim();

    if (estudiante && normalizeKey(estudiante) !== 'NOIDENTIFICADO') estudiantes.add(estudiante);
    if (proyecto) proyectos.add(proyecto);
    if (entidad) entidades.add(entidad);
    if (municipio) addCount(municipios, municipio);
    if (asesor && normalizeKey(asesor) !== 'NOIDENTIFICADO') asesores.add(asesor);
    if (programa) addCount(programaCounts, programa);

    addCount(departamentoCounts, row.IDDEPARTAMENTO || 'Sin dato');
    addCount(zonaCounts, row.ZONA || 'Sin dato');
    addCount(odsCounts, row.ODSPROYECTO || 'Sin dato');
    addCount(lineaCounts, row.LINEADELPROYECTO || 'Sin dato');
    addCount(tipoEntidadCounts, row.TIPODEENTIDAD || 'Sin dato');

    if (String(row.ESUNAACTIVIDADDECOOPERACIONINTERNACIONAL || '').trim().toUpperCase().startsWith('S')) {
      cooperacionInternacional += 1;
    }
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalRegistros: rows.length,
    totalEstudiantesUnicos: estudiantes.size,
    totalProyectos: proyectos.size,
    totalEntidadesVinculadas: entidades.size,
    totalAsesores: asesores.size,
    cooperacionInternacional,
    porDepartamento: sortedDistribution(departamentoCounts, 10),
    porZona: sortedDistribution(zonaCounts),
    porOds: sortedDistribution(odsCounts),
    porLineaProyecto: sortedDistribution(lineaCounts),
    porTipoEntidad: sortedDistribution(tipoEntidadCounts, 10),
    porPrograma: sortedDistribution(programaCounts, 10),
    topMunicipios: sortedDistribution(municipios, 10),
    hojas: [
      buildHoja('Paz y Región', rows.length, [
        donutBreakdown('Por zona', zonaCounts),
        barBreakdown('Top municipios', municipios, 10),
        barBreakdown('Por ODS', odsCounts, 10),
        barBreakdown('Por línea de proyecto', lineaCounts, 10),
        barBreakdown('Por tipo de entidad', tipoEntidadCounts, 10),
        barBreakdown('Enfoques y contribuciones', analyzeEnfoques(rows)),
      ]),
    ],
  };
};

const isGruposInvestigacionFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['GRUPO', 'INVESTIGACION']);

// Resumen a la medida de Grupos de Investigación (Investigación e
// Indagación): un registro por grupo.
const buildGruposInvestigacionAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const sheet = [...sheets.values()].find((s) => normalizeKey(s.name).indexOf('GRUPOSDEINVESTIGACION') === 0);
  const rows = rowsAsObjects(sheet);
  if (rows.length === 0) return null;

  const clasificacionCounts = new Map();
  const programaCounts = new Map();
  rows.forEach((row) => {
    addCount(clasificacionCounts, row.CLASIFICACIONDELGRUPOENMINCIENCIAS || 'Sin clasificar');
    const programa = String(row.PROGRAMAODEPENDENCIA || '').trim();
    if (programa) addCount(programaCounts, programa);
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalGrupos: rows.length,
    porClasificacion: sortedDistribution(clasificacionCounts),
    porPrograma: sortedDistribution(programaCounts, 10),
    hojas: [
      buildHoja('Grupos de Investigación', rows.length, [
        donutBreakdown('Por clasificación Minciencias', clasificacionCounts),
        barBreakdown('Por programa/dependencia', programaCounts, 10),
      ]),
    ],
  };
};

const isLineasInvestigacionFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['LINEA', 'INVESTIGACION']);

// Resumen a la medida de Líneas de Investigación (Investigación e
// Indagación): un registro por línea, agrupada bajo un grupo de investigación.
const buildLineasInvestigacionAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const sheet = [...sheets.values()].find((s) => normalizeKey(s.name).indexOf('LINEASDEINVESTIGACION') === 0);
  const rows = rowsAsObjects(sheet);
  if (rows.length === 0) return null;

  const grupos = new Set();
  const porGrupoCounts = new Map();
  rows.forEach((row) => {
    const grupo = String(row.CODGRUPODEINVESTIGACION || '').trim();
    if (grupo) {
      grupos.add(grupo);
      addCount(porGrupoCounts, grupo);
    }
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalLineas: rows.length,
    totalGrupos: grupos.size,
    porGrupo: sortedDistribution(porGrupoCounts, 12),
    hojas: [
      buildHoja('Líneas de Investigación', rows.length, [
        barBreakdown('Líneas por grupo', porGrupoCounts, 12),
      ]),
    ],
  };
};

const isRedesInvestigacionFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['RED', 'INVESTIGACION']);

// Resumen a la medida de Redes de Investigación (Investigación e
// Indagación): un registro por investigador vinculado a una red.
const buildRedesInvestigacionAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const sheet = [...sheets.values()].find((s) => normalizeKey(s.name).indexOf('REDESDEINVESTIGACION') === 0);
  const rows = rowsAsObjects(sheet);
  if (rows.length === 0) return null;

  const investigadores = new Set();
  const redes = new Set();
  const redCounts = new Map();
  const programaCounts = new Map();
  const institucionCounts = new Map();

  rows.forEach((row) => {
    const investigador = String(row.NOMBREIDENTIFICADO || '').trim();
    const red = String(row.CODIGORED || '').trim();
    const programa = String(row.PROGRAMAODEPENDENCIA || '').trim();
    const institucion = String(row.INSTITUCION || '').trim();

    if (investigador && normalizeKey(investigador) !== 'NOIDENTIFICADO') investigadores.add(investigador);
    if (red) redes.add(red);
    if (programa) addCount(programaCounts, programa);
    if (institucion) addCount(institucionCounts, institucion);
    addCount(redCounts, row.NOMBRERED || 'Sin dato');
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalRegistros: rows.length,
    totalInvestigadoresUnicos: investigadores.size,
    totalRedes: redes.size,
    porRed: sortedDistribution(redCounts),
    porPrograma: sortedDistribution(programaCounts, 10),
    topInstituciones: sortedDistribution(institucionCounts, 10),
    hojas: [
      buildHoja('Redes de Investigación', rows.length, [
        donutBreakdown('Por red', redCounts),
        barBreakdown('Por programa/dependencia', programaCounts, 10),
        barBreakdown('Top instituciones', institucionCounts, 10),
      ]),
    ],
  };
};

const isSemillerosParticipantesFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['SEMILLERO']);

// Resumen a la medida de Semilleros y sus Participantes (Investigación e
// Indagación): cruza SEMILLEROS (un registro por semillero) con
// PARTICIPANTES_SEMILLEROS (un registro por estudiante participante) por
// CODIGO_SEMILLERO.
const buildSemillerosParticipantesAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const semilleroRows = rowsAsObjects(sheets.get('SEMILLEROS'));
  const participanteRows = rowsAsObjects(sheets.get('PARTICIPANTESSEMILLEROS'));
  if (semilleroRows.length === 0) return null;

  const nombreBySemillero = new Map();
  const gruposConSemilleros = new Set();
  semilleroRows.forEach((row) => {
    const codigo = String(row.CODIGOSEMILLERO || '').trim();
    const nombre = String(row.NOMBRESEMILLERO || '').trim();
    const grupo = String(row.CODGRUPODEINVESTIGACION || '').trim();
    if (codigo) nombreBySemillero.set(codigo, nombre || codigo);
    if (grupo) gruposConSemilleros.add(grupo);
  });

  const participantesPorSemillero = new Map();
  const participantesUnicos = new Set();
  const programaCounts = new Map();
  participanteRows.forEach((row) => {
    const codigo = String(row.CODIGOSEMILLERO || '').trim();
    const nombre = String(row.NOMBREIDENTIFICADO || '').trim();
    const programa = String(row.PROGRAMAODEPENDENCIA || '').trim();
    if (codigo) addCount(participantesPorSemillero, codigo);
    if (nombre && normalizeKey(nombre) !== 'NOIDENTIFICADO') participantesUnicos.add(nombre);
    if (programa) addCount(programaCounts, programa);
  });

  const topSemilleros = sortedDistribution(participantesPorSemillero, 10).map((entry) => ({
    name: nombreBySemillero.get(entry.name) || `Semillero sin nombre (código ${entry.name})`,
    value: entry.value,
  }));

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalSemilleros: semilleroRows.length,
    totalGruposConSemilleros: gruposConSemilleros.size,
    totalParticipantes: participanteRows.length,
    totalParticipantesUnicos: participantesUnicos.size,
    porPrograma: sortedDistribution(programaCounts, 10),
    topSemilleros,
    hojas: [
      buildHoja('Semilleros', semilleroRows.length, [
        barBreakdown('Top semilleros por participantes', topSemilleros),
      ]),
      buildHoja('Participantes de semilleros', participanteRows.length, [
        barBreakdown('Por programa/dependencia', programaCounts, 10),
      ]),
    ],
  };
};

const isTrabajoGradoFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['TRABAJO', 'GRADO']);

// Resumen a la medida de Trabajos de Grado (Investigación e Indagación): un
// registro por estudiante en un trabajo de grado (un trabajo en equipo
// aparece una vez por integrante, por eso se cuentan trabajos distintos por
// nombre de tesis ademas de los registros totales).
const buildTrabajoGradoAnalytics = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const sheets = new Map(document.sheets.map((sheet) => [normalizeKey(sheet.name), sheet]));
  const sheet = [...sheets.values()].find((s) => normalizeKey(s.name).indexOf('TRABAJODEGRADO') === 0);
  const rows = rowsAsObjects(sheet);
  if (rows.length === 0) return null;

  const trabajos = new Set();
  const directores = new Set();
  const modalidadCounts = new Map();
  const estadoCounts = new Map();
  const mencionCounts = new Map();
  const grupoCounts = new Map();
  const programaCounts = new Map();

  rows.forEach((row) => {
    const tesis = String(row.NOMBREDELATESIS || '').trim();
    const director = String(row.NOMBREIDENTIFICADO || '').trim();
    const programa = String(row.PROGRAMAODEPENDENCIA || '').trim();

    if (tesis) trabajos.add(tesis);
    if (director && normalizeKey(director) !== 'NOIDENTIFICADO') directores.add(director);
    if (programa) addCount(programaCounts, programa);

    addCount(modalidadCounts, row.MODALIDAD || 'Sin dato');
    addCount(estadoCounts, row.ESTADO || 'Sin dato');
    addCount(mencionCounts, row.MENCIONMERITORIA || 'Sin dato');
    addCount(grupoCounts, row.CODGRUPODEINVESTIGACION || 'Sin grupo');
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalRegistros: rows.length,
    totalTrabajos: trabajos.size,
    totalDirectoresUnicos: directores.size,
    porModalidad: sortedDistribution(modalidadCounts),
    porEstado: sortedDistribution(estadoCounts),
    porMencion: sortedDistribution(mencionCounts),
    porGrupo: sortedDistribution(grupoCounts, 10),
    porPrograma: sortedDistribution(programaCounts, 10),
    hojas: [
      buildHoja('Trabajo de Grado', rows.length, [
        donutBreakdown('Por modalidad', modalidadCounts),
        donutBreakdown('Por estado', estadoCounts),
        barBreakdown('Por grupo de investigación', grupoCounts, 10),
        barBreakdown('Por programa', programaCounts, 10),
      ]),
    ],
  };
};

// Las 4 plantillas de Movilidad (entrante/saliente x estudiantes/funcionarios)
// comparten exactamente el mismo esquema de campos (solo cambia si el campo
// de pais/institucion es "destino" o "procedencia"), asi que se resuelven con
// una unica logica interna, expuesta con un nombre build/is por variante para
// mantener el mismo patron que el resto del archivo.
// En movilidad ENTRANTE la persona es de otra institucion, no del directorio
// interno: "Nombre identificado" y "Programa o dependencia" (que resuelven
// contra ese directorio) quedan en "NO IDENTIFICADO" para todas las filas.
// El nombre real si viene en PRIMER_NOMBRE/SEGUNDO_NOMBRE/APELLIDOS, y el
// programa local relacionado en PROGRAMA_ACADEMICO_RELACIONADO — se usan
// como respaldo cuando el campo resuelto no identifico a nadie.
const isUnresolved = (value) => {
  const text = String(value ?? '').trim();
  return !text || normalizeKey(text) === 'NOIDENTIFICADO';
};

const buildFullNameFromParts = (row) => [row.PRIMERNOMBRE, row.SEGUNDONOMBRE, row.PRIMERAPELLIDO, row.SEGUNDOAPELLIDO]
  .map((part) => String(part ?? '').trim())
  .filter(Boolean)
  .join(' ');

const buildMovilidadAnalyticsCore = (document) => {
  if (!document || !Array.isArray(document.sheets)) return null;
  const candidateSheets = document.sheets.filter((sheet) => normalizeKey(sheet.name) !== 'LISTAS');
  const sheet = candidateSheets.sort((a, b) => (b.rows || []).length - (a.rows || []).length)[0];
  const rows = rowsAsObjects(sheet);
  if (rows.length === 0) return null;

  const personas = new Set();
  const nacionalInternacionalCounts = new Map();
  const tipoMovilidadCounts = new Map();
  const modalidadCounts = new Map();
  const paisCounts = new Map();
  const programaCounts = new Map();
  const institucionCounts = new Map();
  let totalDias = 0;

  rows.forEach((row) => {
    const nombreIdentificado = String(row.NOMBREIDENTIFICADO || '').trim();
    const persona = isUnresolved(nombreIdentificado) ? buildFullNameFromParts(row) : nombreIdentificado;

    const programaLocal = String(row.PROGRAMAODEPENDENCIA || '').trim();
    const programa = isUnresolved(programaLocal) ? String(row.PROGRAMAACADEMICORELACIONADO || '').trim() : programaLocal;

    // "Destino" para movilidad saliente, "procedencia" para entrante.
    const pais = String(row.IDPAISDESTINO || row.IDPAISPROCEDENCIA || '').trim();
    const institucion = String(row.INSTITUCIONDESTINO || row.INSTITUCIONPROCEDENCIA || '').trim();

    if (persona) personas.add(persona);
    if (programa) addCount(programaCounts, programa);
    if (pais) addCount(paisCounts, pais);
    if (institucion) addCount(institucionCounts, institucion);

    addCount(nacionalInternacionalCounts, row.NACIONALINTERNACIONAL || 'Sin dato');
    addCount(tipoMovilidadCounts, row.TIPOMOVILIDAD || 'Sin dato');
    addCount(modalidadCounts, row.MODALIDAD || 'Sin dato');
    totalDias += asNumber(row.NUMDIASMOVILIDAD);
  });

  return {
    fileId: String(document._id),
    fileName: document.file_name,
    totalRegistros: rows.length,
    totalPersonasUnicas: personas.size,
    totalDiasMovilidad: totalDias,
    porNacionalInternacional: sortedDistribution(nacionalInternacionalCounts),
    porTipoMovilidad: sortedDistribution(tipoMovilidadCounts, 10),
    porModalidad: sortedDistribution(modalidadCounts),
    porPais: sortedDistribution(paisCounts, 10),
    porPrograma: sortedDistribution(programaCounts, 10),
    topInstituciones: sortedDistribution(institucionCounts, 10),
    hojas: [
      buildHoja(sheet.name, rows.length, [
        donutBreakdown('Nacional / internacional', nacionalInternacionalCounts),
        donutBreakdown('Por modalidad', modalidadCounts),
        barBreakdown('Por tipo de movilidad', tipoMovilidadCounts, 10),
        barBreakdown('Por país', paisCounts, 10),
        barBreakdown('Top instituciones', institucionCounts, 10),
        barBreakdown('Enfoques y contribuciones', analyzeEnfoques(rows)),
      ]),
    ],
  };
};

const isMovilidadEntranteEstudiantesFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['MOVILIDAD', 'ENTRANTE', 'ESTUDIANT']);
const buildMovilidadEntranteEstudiantesAnalytics = buildMovilidadAnalyticsCore;

const isMovilidadEntranteFuncionariosFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['MOVILIDAD', 'ENTRANTE', 'FUNCIONARIO']);
const buildMovilidadEntranteFuncionariosAnalytics = buildMovilidadAnalyticsCore;

const isMovilidadSalienteEstudiantesFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['MOVILIDAD', 'SALIENTE', 'ESTUDIANT']);
const buildMovilidadSalienteEstudiantesAnalytics = buildMovilidadAnalyticsCore;

const isMovilidadSalienteFuncionariosFile = (fileName) => hasAllKeywords(fileNameKey(fileName), ['MOVILIDAD', 'SALIENTE', 'FUNCIONARIO']);
const buildMovilidadSalienteFuncionariosAnalytics = buildMovilidadAnalyticsCore;

module.exports = {
  buildActividadBienestarAnalytics,
  isActividadBienestarFile,
  buildRepresentacionEstudiantilAnalytics,
  isRepresentacionEstudiantilFile,
  buildPublicacionesAutoresAnalytics,
  isPublicacionesAutoresFile,
  buildDocentesHistoricoSniesAnalytics,
  isDocentesHistoricoSniesFile,
  buildRutasAprendizajeAnalytics,
  isRutasAprendizajeFile,
  buildPracticasAcademicasAnalytics,
  isPracticasAcademicasFile,
  buildEstrategiasCurricularesAnalytics,
  isEstrategiasCurricularesFile,
  buildCapacitacionFuncionariosAnalytics,
  isCapacitacionFuncionariosFile,
  buildConveniosCooperacionAnalytics,
  isConveniosCooperacionFile,
  buildEstimulosFuncionariosAnalytics,
  isEstimulosFuncionariosFile,
  buildOtrasEstrategiasAnalytics,
  isOtrasEstrategiasFile,
  buildPazYRegionAnalytics,
  isPazYRegionFile,
  buildGruposInvestigacionAnalytics,
  isGruposInvestigacionFile,
  buildLineasInvestigacionAnalytics,
  isLineasInvestigacionFile,
  buildRedesInvestigacionAnalytics,
  isRedesInvestigacionFile,
  buildSemillerosParticipantesAnalytics,
  isSemillerosParticipantesFile,
  buildTrabajoGradoAnalytics,
  isTrabajoGradoFile,
  buildMovilidadEntranteEstudiantesAnalytics,
  isMovilidadEntranteEstudiantesFile,
  buildMovilidadEntranteFuncionariosAnalytics,
  isMovilidadEntranteFuncionariosFile,
  buildMovilidadSalienteEstudiantesAnalytics,
  isMovilidadSalienteEstudiantesFile,
  buildMovilidadSalienteFuncionariosAnalytics,
  isMovilidadSalienteFuncionariosFile,
};
