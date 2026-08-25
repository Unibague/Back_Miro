const Dimension = require('../models/dimensions');
const Dependency = require('../models/dependencies');
const AuditLogger = require('../services/auditLogger');
const User = require('../models/users');
const Template = require('../models/templates');
const PublishedTemplate = require('../models/publishedTemplates');
const Validator = require('../models/validators');
const HistoricoDocentes = require('../models/historicoDocentes');
const {
  buildActividadBienestarAnalytics,
  isActividadBienestarFile,
} = require('../services/consultaInformacionAnalytics');

const dimensionController = {};

const isBlankValue = (value) => {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return Number.isNaN(value);
  const raw = value && typeof value === 'object' && 'text' in value ? value.text : value;
  const normalized = String(raw ?? '').trim().toLowerCase();
  return normalized === '' || normalized === 'null' || normalized === 'nan';
};

// Cuenta cuantos registros (filas) reporto una dependencia en un envio: el
// maximo de valores no vacios entre todos sus campos, igual criterio que usa
// el resto del sistema para saber si un envio "tiene informacion" o no.
const countRecordsInLoadedEntry = (entry) => {
  const filled = Array.isArray(entry?.filled_data) ? entry.filled_data : [];
  return filled.reduce((max, field) => {
    const meaningful = Array.isArray(field?.values)
      ? field.values.filter((value) => !isBlankValue(value)).length
      : 0;
    return Math.max(max, meaningful);
  }, 0);
};

const NUMERIC_DATATYPES = new Set(['Entero', 'Decimal', 'Porcentaje']);
// Campos de identificacion/metadata (año, semestre, documento, telefono,
// codigos, etc.): sumarlos o promediarlos no significa nada, se excluyen del
// resumen numerico automatico. Coincide por substring en cualquier parte del
// nombre del campo (case/acentos insensible).
const NUMERIC_EXCLUDE_KEYWORDS = [
  'ANO', 'SEMESTRE', 'DOCUMENTO', 'CODIGO', 'COD_', 'TELEFONO', 'CELULAR',
  'FAX', 'CONTACTO', 'NIT', 'ID_', '_ID', 'CORREO', 'EMAIL', 'FECHA',
];
const ACCENTED_CHAR_MAP = { 'Á': 'A', 'É': 'E', 'Í': 'I', 'Ó': 'O', 'Ú': 'U', 'Ñ': 'N' };
const normalizeFieldNameForMatch = (name) => {
  const upper = String(name || '').toUpperCase();
  let result = '';
  for (const char of upper) result += ACCENTED_CHAR_MAP[char] || char;
  return result;
};
const isIdentityLikeNumericField = (name) => {
  const normalized = normalizeFieldNameForMatch(name);
  return NUMERIC_EXCLUDE_KEYWORDS.some((keyword) => normalized.includes(keyword));
};

const stringifyRawValue = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'text' in value) return String(value.text ?? '').trim();
  return String(value).trim();
};

// Los archivos historicos no siempre conservan exactamente las mismas
// mayusculas, tildes o espacios que la definicion actual de la plantilla.
// Esta busqueda normalizada evita que un campo valido desaparezca del
// tablero solo por esas diferencias de escritura.
const getValuesByNormalizedFieldName = (valuesByFieldName, fieldName) => {
  if (!valuesByFieldName || !fieldName) return [];
  const exact = valuesByFieldName.get(fieldName);
  if (exact) return exact;
  const wanted = normKey(fieldName);
  for (const pair of valuesByFieldName.entries()) {
    if (normKey(pair[0]) === wanted) return pair[1];
  }
  return [];
};

// Distintas plantillas (o incluso distintas filas de la misma) a veces
// guardan el mismo valor de una lista controlada con distinto nivel de
// detalle: "CC" en una y "CC - Cédula de ciudadanía" en otra. Se agrupan por
// el codigo (lo que va antes de " - "), y se muestra la version con
// descripcion cuando exista, para no duplicar el mismo valor en la lista.
const categoryGroupKey = (text) => {
  const dashIndex = text.indexOf(' - ');
  const code = dashIndex >= 0 ? text.slice(0, dashIndex) : text;
  return normalizeFieldNameForMatch(code.trim());
};
const preferMoreDescriptiveLabel = (current, candidate) =>
  candidate.length > current.length ? candidate : current;

// Normalizador "duro": mayusculas, sin acentos, sin espacios/guiones/guion
// bajo. Se usa para comparar nombres de plantillas y de campos sin
// preocuparse por como los haya escrito quien armo la plantilla.
const normKey = (value) => normalizeFieldNameForMatch(value).replace(/[^A-Z0-9]/g, '');

// "ValidatorName - NombreColumnaId" -> { validatorName, idColumnName }
const parseValidateWith = (validateWith) => {
  const text = String(validateWith || '').trim();
  if (!text) return null;
  const parts = text.split(' - ');
  const validatorName = parts[0]?.trim();
  const idColumnName = parts.slice(1).join(' - ').trim();
  if (!validatorName) return null;
  return { validatorName, idColumnName };
};

// A partir de los validadores (tablas id -> descripcion) guardados en Mongo,
// arma un mapa validador -> (codigo -> nombre descriptivo), para poder
// mostrar "Bienestar - Salud" en vez de "1" en los resumenes.
const buildValidatorResolvers = (validatorDocs) => {
  const resolversByValidator = new Map();
  (validatorDocs || []).forEach((doc) => {
    const columns = doc.columns || [];
    if (columns.length < 2) return;
    const idColumn = columns.find((c) => c.is_validator) || columns[0];
    const descColumn = columns.find((c) => c !== idColumn && /DESCRIP|NOMBRE/i.test(c.name))
      || columns.find((c) => c !== idColumn);
    if (!idColumn || !descColumn) return;

    const lookup = new Map();
    (idColumn.values || []).forEach((rawId, idx) => {
      const key = normKey(stringifyRawValue(rawId));
      const label = stringifyRawValue(descColumn.values ? descColumn.values[idx] : '');
      if (key && label) lookup.set(key, label);
    });
    resolversByValidator.set(normKey(doc.name), lookup);
  });
  return resolversByValidator;
};

const resolveValidatorValue = (validateWith, rawText, resolversByValidator) => {
  const parsed = parseValidateWith(validateWith);
  if (!parsed || !rawText) return rawText;
  const lookup = resolversByValidator.get(normKey(parsed.validatorName));
  if (!lookup) return rawText;
  const resolved = lookup.get(normKey(rawText));
  return resolved || rawText;
};

const resolveSemanticFieldValue = (field, rawText, resolversByValidator) => {
  if (field.validate_with) return resolveValidatorValue(field.validate_with, rawText, resolversByValidator);

  // Algunos formatos antiguos no declararon el validador aunque el campo si
  // contiene un codigo de catalogo. Este caso es clave en Bienestar: 47 es
  // Bienestar Universitario y 5 es Gestion Humana.
  if (normKey(field.name).indexOf('CODIGOUNIDADORGANIZACIONAL') !== -1) {
    const lookup = resolversByValidator.get(normKey('UNIDADES_ORGANIZACIONALES'));
    return (lookup && lookup.get(normKey(rawText))) || rawText;
  }

  return rawText;
};

// A partir de las definiciones de campos de una plantilla y los valores
// realmente reportados (values por field_name, ya aplanados de todas las
// dependencias/filas), arma un resumen automatico: para campos numericos, el
// total y el promedio; para campos con lista controlada de valores (dropdown
// o True/False), el valor mas frecuente y cuantas veces se reporto.
const buildFieldSummary = (fields, valuesByFieldName, resolversByValidator) => {
  const numeric = [];
  const categorical = [];

  (fields || []).forEach((field) => {
    if (!field?.name) return;
    const rawValues = getValuesByNormalizedFieldName(valuesByFieldName, field.name);
    if (!rawValues || rawValues.length === 0) return;

    // Un campo numerico con validador (dropdown codificado como numero, ej.
    // "1 - Financiero") no es una cantidad real: sumarlo/promediarlo no dice
    // nada, se trata mejor como categorico mas abajo.
    const isRealNumericField = NUMERIC_DATATYPES.has(field.datatype)
      && !field.validate_with
      && !isIdentityLikeNumericField(field.name);

    if (isRealNumericField) {
      const numbers = rawValues
        .map((value) => parseFloat(stringifyRawValue(value)))
        .filter((value) => !Number.isNaN(value));
      if (numbers.length === 0) return;
      const total = numbers.reduce((sum, value) => sum + value, 0);
      numeric.push({
        name: field.name,
        total,
        average: total / numbers.length,
        count: numbers.length,
      });
      return;
    }

    // Ademas de listas controladas, algunos formatos historicos guardan como
    // texto sus categorias (tipo, modalidad, estado, actividad, sector...).
    // Esos campos siguen siendo utiles para rankings y donas. Descripciones
    // de actividades/eventos se incluyen para responder cuales se repiten.
    const semanticName = normKey(field.name);
    const isSemanticCategory = [
      'TIPO', 'CATEGORIA', 'CATEGOR', 'MODALIDAD', 'ESTADO', 'SECTOR',
      'POBLACION', 'BENEFICIARIO', 'ACTIVIDADEVENTO', 'DESCRIPCIONACTIVIDAD',
      'DESCRIPCIONEVENTO', 'NOMBREACTIVIDAD', 'NOMBREEVENTO', 'UNIDADORGANIZACIONAL',
    ].some((keyword) => semanticName.indexOf(keyword) !== -1);
    const isControlledVocabulary = Boolean(field.validate_with)
      || field.datatype === 'True/False'
      || isSemanticCategory;
    if (!isControlledVocabulary) return;

    const frequency = new Map();
    let totalNonBlank = 0;
    rawValues.forEach((value) => {
      const rawText = stringifyRawValue(value);
      if (!rawText) return;
      // La clave de agrupacion SIEMPRE sale del texto crudo (antes de
      // resolver el validador): asi "CC" y "CC - Cedula de ciudadania" caen
      // en la misma clave ("CC"), sin importar que una ya traiga el nombre y
      // la otra se resuelva ahora al nombre real (ej. "Bienestar - Salud").
      const key = categoryGroupKey(rawText);
      const text = resolveSemanticFieldValue(field, rawText, resolversByValidator);
      totalNonBlank += 1;
      const existing = frequency.get(key);
      if (!existing) {
        frequency.set(key, { label: text, count: 1 });
      } else {
        existing.count += 1;
        existing.label = preferMoreDescriptiveLabel(existing.label, text);
      }
    });
    if (frequency.size === 0) return;

    const distribution = Array.from(frequency.entries())
      .map(([key, entry]) => ({ value: entry.label, count: entry.count, groupKey: key }))
      .sort((a, b) => b.count - a.count);

    categorical.push({
      name: field.name,
      topValue: distribution[0].value,
      topCount: distribution[0].count,
      totalValues: totalNonBlank,
      distribution: distribution.slice(0, 5),
    });
  });

  numeric.sort((a, b) => b.total - a.total);
  const categoricalPriority = (field) => {
    const key = normKey(field.name);
    if (key.indexOf('CATEGORIA') !== -1 || key.indexOf('CATEGOR') !== -1) return 120;
    if (key.indexOf('UNIDADORGANIZACIONAL') !== -1) return 118;
    if (key.indexOf('TIPOACTIVIDAD') !== -1) return 115;
    if (key.indexOf('DESCRIPCIONACTIVIDAD') !== -1 || key.indexOf('DESCRIPCIONEVENTO') !== -1) return 110;
    if (key.indexOf('ACTIVIDADEVENTO') !== -1) return 105;
    if (key.indexOf('MODALIDAD') !== -1) return 100;
    if (key.indexOf('TIPOBENEFICIARIO') !== -1 || key.indexOf('POBLACION') !== -1) return 95;
    if (key.indexOf('TIPO') !== -1 || key.indexOf('ESTADO') !== -1 || key.indexOf('SECTOR') !== -1) return 80;
    return 0;
  };
  categorical.sort((a, b) => categoricalPriority(b) - categoricalPriority(a) || b.topCount - a.topCount);

  // Sin recortar aqui: esto se calcula por plantilla y luego se agrupa a
  // nivel de ambito (varias plantillas aportan candidatos); el recorte final
  // a "top N" se hace alla, sobre el conjunto ya agrupado.
  return { numeric, categorical };
};

// Resumen "curado" a la medida, SOLO para el ambito Bienestar Institucional
// (a pedido explicito, no es el resumen generico de arriba): cuenta
// actividades/eventos/estrategias unicas (codigo + descripcion), personas
// beneficiadas/impactadas y participantes, y arma el desglose de actividades
// por dependencia. La plantilla de "Recurso Humano" queda excluida a
// proposito (no aporta informacion relevante para este resumen).
const BIENESTAR_DIMENSION_KEY = normKey('Bienestar Institucional');
const BIENESTAR_ACTIVITY_TEMPLATE_KEYS = new Set([
  'ACTIVIDADESBIENESTAR', 'ACTIVIDADESCULTURAL', 'EVENTOCULTURAL',
  'ACTIVIDADDEBIENESTAR', 'ACTIVIDADCULTURAL', 'OTRASESTRATEGIAS',
].map(normKey));
const BIENESTAR_PARTICIPANT_TEMPLATE_KEYS = new Set([
  'BENEFICIARIOBIENESTARCULTURAL', 'PARTICIPANTEOTRASESTRATEGIAS',
].map(normKey));
const BIENESTAR_HUMAN_RESOURCE_TEMPLATE_KEYS = new Set([
  'RECURSOHUMANOBIENESTARCULTURAL',
].map(normKey));

// Resumenes "curados" adicionales (mismo criterio que Bienestar): a la
// medida de una plantilla puntual, con las cifras que de verdad importan
// para ese proceso en vez del resumen automatico generico.
const RUTAS_APRENDIZAJE_TEMPLATE_KEY = normKey('RUTAS_DE_APRENDIZAJE');
const ESTADISTICA_PRACTICAS_TEMPLATE_KEY = normKey('ESTADISTICA_PRACTICAS');

const findFieldByPredicate = (fields, predicate) => (fields || []).find(
  (field) => field?.name && predicate(normKey(field.name), field)
);

const getFieldValuesForEntry = (entry, fieldDef) => {
  if (!fieldDef) return [];
  const filled = entry.filled_data || [];
  const fieldKey = normKey(fieldDef.name);
  const match = filled.find((f) => f && normKey(f.field_name) === fieldKey);
  return match && Array.isArray(match.values) ? match.values : [];
};

const buildBienestarCurado = (templateIds, templateInfoById, publishedTemplates, dependencyNameByCode) => {
  const activityTemplateIds = [];
  const participantTemplateIds = [];
  const humanResourceTemplateIds = [];
  templateIds.forEach((tId) => {
    const info = templateInfoById.get(tId);
    if (!info) return;
    const key = normKey(info.name);
    if (BIENESTAR_ACTIVITY_TEMPLATE_KEYS.has(key)) activityTemplateIds.push(tId);
    else if (BIENESTAR_PARTICIPANT_TEMPLATE_KEYS.has(key)) participantTemplateIds.push(tId);
    else if (BIENESTAR_HUMAN_RESOURCE_TEMPLATE_KEYS.has(key)) humanResourceTemplateIds.push(tId);
    // Cualquier otra plantilla del ambito se conserva para el resumen generico.
  });

  const entriesByTemplateId = (ids) => {
    const idSet = new Set(ids);
    const byId = new Map();
    publishedTemplates.forEach((published) => {
      const tId = String((published.template && published.template._id) || '');
      if (!idSet.has(tId)) return;
      const entries = (published.loaded_data || []).filter((entry) => countRecordsInLoadedEntry(entry) > 0);
      byId.set(tId, (byId.get(tId) || []).concat(entries));
    });
    return byId;
  };

  const activitiesByCodigo = new Map(); // codigo -> descripcion
  const dependencyActivityCodes = new Map(); // depCode -> Set(codigo)
  let totalBeneficiarios = 0;
  let totalPersonasImpactadas = 0;

  const activityEntriesByTemplateId = entriesByTemplateId(activityTemplateIds);
  activityTemplateIds.forEach((tId) => {
    const info = templateInfoById.get(tId) || { fields: [] };
    const codigoField = findFieldByPredicate(info.fields, (k) => (
      k.indexOf('CODIGOACTIVIDAD') === 0 || k.indexOf('CODIGOEVENTO') === 0 || k === 'IDESTRATEGIA'
    ));
    const descField = findFieldByPredicate(info.fields, (k) => k.indexOf('DESCRIPCION') === 0);
    const beneficiarioFields = (info.fields || []).filter(
      (f) => NUMERIC_DATATYPES.has(f.datatype) && normKey(f.name).indexOf('BENEFICIARIO') !== -1
    );
    const impactadaFields = (info.fields || []).filter(
      (f) => NUMERIC_DATATYPES.has(f.datatype) && normKey(f.name).indexOf('IMPACTAD') !== -1
    );

    const entries = activityEntriesByTemplateId.get(tId) || [];
    entries.forEach((entry) => {
      const depCode = entry.dependency;
      const codigoValues = getFieldValuesForEntry(entry, codigoField);
      const descValues = getFieldValuesForEntry(entry, descField);
      const rowCount = countRecordsInLoadedEntry(entry);

      for (let r = 0; r < rowCount; r += 1) {
        const codigoRaw = stringifyRawValue(codigoValues[r]);
        if (!codigoRaw) continue;
        const descRaw = stringifyRawValue(descValues[r]);
        const existingDesc = activitiesByCodigo.get(codigoRaw);
        if (!existingDesc && descRaw) activitiesByCodigo.set(codigoRaw, descRaw);
        else if (!activitiesByCodigo.has(codigoRaw)) activitiesByCodigo.set(codigoRaw, descRaw);

        if (depCode) {
          if (!dependencyActivityCodes.has(depCode)) dependencyActivityCodes.set(depCode, new Set());
          dependencyActivityCodes.get(depCode).add(codigoRaw);
        }
      }

      beneficiarioFields.forEach((bf) => {
        getFieldValuesForEntry(entry, bf).forEach((v) => {
          const n = parseFloat(stringifyRawValue(v));
          if (!Number.isNaN(n)) totalBeneficiarios += n;
        });
      });
      impactadaFields.forEach((imf) => {
        getFieldValuesForEntry(entry, imf).forEach((v) => {
          const n = parseFloat(stringifyRawValue(v));
          if (!Number.isNaN(n)) totalPersonasImpactadas += n;
        });
      });
    });
  });

  let totalParticipantes = 0;
  const participantEntriesByTemplateId = entriesByTemplateId(participantTemplateIds);
  participantTemplateIds.forEach((tId) => {
    (participantEntriesByTemplateId.get(tId) || []).forEach((entry) => {
      totalParticipantes += countRecordsInLoadedEntry(entry);
    });
  });

  let totalRecursoHumano = 0;
  const humanResourceEntriesByTemplateId = entriesByTemplateId(humanResourceTemplateIds);
  humanResourceTemplateIds.forEach((tId) => {
    (humanResourceEntriesByTemplateId.get(tId) || []).forEach((entry) => {
      totalRecursoHumano += countRecordsInLoadedEntry(entry);
    });
  });

  const actividades = Array.from(activitiesByCodigo.entries())
    .map(([codigo, descripcion]) => ({ codigo, descripcion: descripcion || '(sin descripción)' }))
    .sort((a, b) => a.codigo.localeCompare(b.codigo));

  const porDependencia = Array.from(dependencyActivityCodes.entries())
    .filter(([depCode]) => dependencyNameByCode.has(depCode))
    .map(([depCode, codigos]) => ({
      dependencia: dependencyNameByCode.get(depCode),
      totalActividades: codigos.size,
    }))
    .sort((a, b) => b.totalActividades - a.totalActividades);

  return {
    totalActividades: activitiesByCodigo.size,
    totalParticipantes,
    totalRecursoHumano,
    totalBeneficiarios: Math.round(totalBeneficiarios),
    totalPersonasImpactadas: Math.round(totalPersonasImpactadas),
    actividades,
    porDependencia,
    consumedTemplateIds: activityTemplateIds.concat(participantTemplateIds, humanResourceTemplateIds),
  };
};

// Resumen "curado" para la plantilla RUTAS_DE_APRENDIZAJE (Estructura y
// Procesos Académicos): cuantos estudiantes matriculados y cuantas insignias
// entregadas tiene cada ruta. La cantidad de cursos aprobados se deja fuera
// a proposito (a pedido explicito, no aporta valor para este resumen).
const buildRutasAprendizajeCurado = (templateIds, templateInfoById, publishedTemplates, resolversByValidator) => {
  const rutaTemplateId = templateIds.find((tId) => {
    const info = templateInfoById.get(tId);
    return info && normKey(info.name) === RUTAS_APRENDIZAJE_TEMPLATE_KEY;
  });
  if (!rutaTemplateId) return null;

  const info = templateInfoById.get(rutaTemplateId) || { fields: [] };
  const rutaField = findFieldByPredicate(
    info.fields,
    (k) => k.indexOf('RUTA') !== -1 && k.indexOf('APRENDIZAJE') !== -1
  );
  const insigniaField = findFieldByPredicate(
    info.fields,
    (k) => k.indexOf('INSIGNIA') !== -1 && k.indexOf('ENTREGAD') !== -1
  );
  if (!rutaField) return null;

  const entries = [];
  publishedTemplates.forEach((published) => {
    const tId = String((published.template && published.template._id) || '');
    if (tId !== rutaTemplateId) return;
    (published.loaded_data || []).forEach((entry) => {
      if (countRecordsInLoadedEntry(entry) > 0) entries.push(entry);
    });
  });

  const porRuta = new Map(); // nombre ruta -> { ruta, matriculados, insignias }
  let totalInsignias = 0;

  entries.forEach((entry) => {
    const rutaValues = getFieldValuesForEntry(entry, rutaField);
    const insigniaValues = insigniaField ? getFieldValuesForEntry(entry, insigniaField) : [];
    const rowCount = countRecordsInLoadedEntry(entry);

    for (let r = 0; r < rowCount; r += 1) {
      const rutaNombre = stringifyRawValue(rutaValues[r]);
      if (!rutaNombre) continue;

      const insigniaRaw = insigniaField
        ? resolveValidatorValue(insigniaField.validate_with, stringifyRawValue(insigniaValues[r]), resolversByValidator)
        : '';
      const entregada = normalizeFieldNameForMatch(insigniaRaw) === 'SI';
      if (entregada) totalInsignias += 1;

      const existing = porRuta.get(rutaNombre) || { ruta: rutaNombre, matriculados: 0, insignias: 0 };
      existing.matriculados += 1;
      if (entregada) existing.insignias += 1;
      porRuta.set(rutaNombre, existing);
    }
  });

  const rutas = Array.from(porRuta.values()).sort((a, b) => b.matriculados - a.matriculados);
  const totalMatriculados = rutas.reduce((sum, r) => sum + r.matriculados, 0);

  return {
    totalMatriculados,
    totalRutas: rutas.length,
    totalInsigniasEntregadas: totalInsignias,
    rutas,
    consumedTemplateIds: [rutaTemplateId],
  };
};

// Resumen "curado" para Prácticas Académicas (Estructura y Procesos
// Académicos): un registro por estudiante en práctica (ESTADISTICA_PRACTICAS),
// con cuantos estudiantes hay por empresa y por modalidad. NOTA: no se cruza
// con EMPRESAS_PRACTICAS para mostrar nombre/sector porque esa plantilla no
// guarda el NIT de la empresa en un campo propio (su "ID_EMPRESA" es en
// realidad el TIPO de documento, ej. "NIT"), asi que no hay forma de unirla
// con el ID numerico de empresa que si trae ESTADISTICA_PRACTICAS.
const buildPracticasCurado = (templateIds, templateInfoById, publishedTemplates, resolversByValidator) => {
  const estadisticaTemplateId = templateIds.find((tId) => {
    const info = templateInfoById.get(tId);
    return info && normKey(info.name) === ESTADISTICA_PRACTICAS_TEMPLATE_KEY;
  });
  if (!estadisticaTemplateId) return null;

  const estadisticaInfo = templateInfoById.get(estadisticaTemplateId) || { fields: [] };
  const empresaRefField = findFieldByPredicate(estadisticaInfo.fields, (k) => k.indexOf('IDEMPRESA') !== -1);
  const modalidadField = findFieldByPredicate(estadisticaInfo.fields, (k) => k.indexOf('MODALIDAD') !== -1);

  let totalEstudiantes = 0;
  const porEmpresa = new Map();
  const porModalidad = new Map();

  publishedTemplates.forEach((published) => {
    const tId = String((published.template && published.template._id) || '');
    if (tId !== estadisticaTemplateId) return;
    (published.loaded_data || []).forEach((entry) => {
      const rowCount = countRecordsInLoadedEntry(entry);
      if (rowCount === 0) return;
      const empresaValues = empresaRefField ? getFieldValuesForEntry(entry, empresaRefField) : [];
      const modalidadValues = modalidadField ? getFieldValuesForEntry(entry, modalidadField) : [];

      for (let r = 0; r < rowCount; r += 1) {
        totalEstudiantes += 1;

        const empresaIdRaw = empresaRefField ? stringifyRawValue(empresaValues[r]) : '';
        const empresaLabel = empresaIdRaw || 'Sin empresa';
        porEmpresa.set(empresaLabel, (porEmpresa.get(empresaLabel) || 0) + 1);

        if (modalidadField) {
          const modalidadRaw = stringifyRawValue(modalidadValues[r]);
          const modalidad = resolveValidatorValue(modalidadField.validate_with, modalidadRaw, resolversByValidator) || 'Sin modalidad';
          porModalidad.set(modalidad, (porModalidad.get(modalidad) || 0) + 1);
        }
      }
    });
  });

  return {
    totalEstudiantes,
    totalEmpresas: porEmpresa.size,
    porEmpresa: Array.from(porEmpresa.entries())
      .map(([empresa, estudiantes]) => ({ empresa, estudiantes }))
      .sort((a, b) => b.estudiantes - a.estudiantes)
      .slice(0, 10),
    porModalidad: Array.from(porModalidad.entries())
      .map(([modalidad, estudiantes]) => ({ modalidad, estudiantes }))
      .sort((a, b) => b.estudiantes - a.estudiantes),
    consumedTemplateIds: [estadisticaTemplateId],
  };
};

// Estadisticas por AMBITO para el Tablero: agrupa el contenido real
// reportado (no conteos de plantillas/informes/dependencias) en un resumen
// por ambito — campos numericos (total/promedio) y categoricos (distribucion
// de valores, para graficar como dona) tomados de TODAS las plantillas de
// ese ambito, mas su volumen de registros y evolucion mensual.
dimensionController.getTableroStats = async function getTableroStats(req, res) {
  var periodId = req.query.periodId || null;

  try {
    var historicQuery = {
      active: true,
      category: 'plantillas',
      file_type: { $ne: 'pdf' },
    };
    if (periodId) historicQuery.period = periodId;

    var results = await Promise.all([
      Dimension.find().select('_id name').lean(),
      Template.find().select('_id name dimensions fields').lean(),
      Validator.find().select('name columns').lean(),
      Dependency.find().select('dep_code name').lean(),
      HistoricoDocentes.find(historicQuery)
        .select('_id file_name dimension period sheets createdAt')
        .sort({ createdAt: -1 })
        .lean(),
    ]);
    var dimensions = results[0];
    var templates = results[1];
    var resolversByValidator = buildValidatorResolvers(results[2]);
    var dependencyNameByCode = new Map(
      results[3].map(function (dep) { return [dep.dep_code, dep.name]; })
    );
    var actividadBienestarByDimension = new Map();
    results[4].forEach(function (document) {
      var dimensionId = document.dimension ? String(document.dimension) : '';
      if (!dimensionId || actividadBienestarByDimension.has(dimensionId)) return;
      if (!isActividadBienestarFile(document.file_name)) return;
      var analytics = buildActividadBienestarAnalytics(document);
      if (analytics) actividadBienestarByDimension.set(dimensionId, analytics);
    });

    var templateIdsByDimension = new Map();
    var dimIdsByTemplateId = new Map();
    // templateId -> { name, fields }
    var templateInfoById = new Map();

    for (var t = 0; t < templates.length; t++) {
      var template = templates[t];
      var templateIdStr = String(template._id);
      templateInfoById.set(templateIdStr, {
        name: template.name || 'Sin nombre',
        fields: template.fields || [],
      });

      var dimIdsForTemplate = (template.dimensions || []).map(function (id) { return String(id); });
      dimIdsByTemplateId.set(templateIdStr, dimIdsForTemplate);
      for (var d = 0; d < dimIdsForTemplate.length; d++) {
        var key = dimIdsForTemplate[d];
        if (!templateIdsByDimension.has(key)) templateIdsByDimension.set(key, []);
        templateIdsByDimension.get(key).push(templateIdStr);
      }
    }

    var publishedQuery = periodId ? { period: periodId } : {};
    var publishedTemplates = await PublishedTemplate.find(publishedQuery)
      .select('template._id loaded_data')
      .lean();

    var recordsByTemplateId = new Map();
    // "YYYY-MM" -> total de registros reportados ese mes (todas las plantillas, global).
    var recordsByMonth = new Map();
    // dimId -> Map<"YYYY-MM", total de registros ese mes, solo ese ambito>
    var recordsByMonthByDim = new Map();
    // templateId -> Map<"YYYY-MM", total de registros ese mes>
    var recordsByMonthByTemplate = new Map();
    // templateId -> Map<fieldName, valores reportados (todas las filas/dependencias)>
    var fieldValuesByTemplateId = new Map();

    for (var pt = 0; pt < publishedTemplates.length; pt++) {
      var published = publishedTemplates[pt];
      var templateId = String((published.template && published.template._id) || '');
      if (!templateId) continue;

      var totalRecords = 0;
      var loadedEntries = published.loaded_data || [];
      var dimIdsForThisTemplate = dimIdsByTemplateId.get(templateId) || [];

      if (!fieldValuesByTemplateId.has(templateId)) fieldValuesByTemplateId.set(templateId, new Map());
      var valuesByFieldName = fieldValuesByTemplateId.get(templateId);

      for (var le = 0; le < loadedEntries.length; le++) {
        var entry = loadedEntries[le];
        var recordCount = countRecordsInLoadedEntry(entry);
        if (recordCount > 0) {
          totalRecords += recordCount;

          var loadedDate = entry.loaded_date ? new Date(entry.loaded_date) : null;
          if (loadedDate && !Number.isNaN(loadedDate.getTime())) {
            var monthKey = loadedDate.getFullYear() + '-' + String(loadedDate.getMonth() + 1).padStart(2, '0');
            recordsByMonth.set(monthKey, (recordsByMonth.get(monthKey) || 0) + recordCount);

            if (!recordsByMonthByTemplate.has(templateId)) recordsByMonthByTemplate.set(templateId, new Map());
            var templateMonthMap = recordsByMonthByTemplate.get(templateId);
            templateMonthMap.set(monthKey, (templateMonthMap.get(monthKey) || 0) + recordCount);

            for (var dm = 0; dm < dimIdsForThisTemplate.length; dm++) {
              var dimKeyForMonth = dimIdsForThisTemplate[dm];
              if (!recordsByMonthByDim.has(dimKeyForMonth)) recordsByMonthByDim.set(dimKeyForMonth, new Map());
              var dimMonthMap = recordsByMonthByDim.get(dimKeyForMonth);
              dimMonthMap.set(monthKey, (dimMonthMap.get(monthKey) || 0) + recordCount);
            }
          }

          var entryFilledData = entry.filled_data || [];
          for (var ff = 0; ff < entryFilledData.length; ff++) {
            var fieldEntry = entryFilledData[ff];
            if (!fieldEntry || !fieldEntry.field_name) continue;
            var existingValues = valuesByFieldName.get(fieldEntry.field_name) || [];
            var rowValues = Array.isArray(fieldEntry.values) ? fieldEntry.values : [];
            for (var rv = 0; rv < rowValues.length; rv++) existingValues.push(rowValues[rv]);
            valuesByFieldName.set(fieldEntry.field_name, existingValues);
          }
        }
      }

      recordsByTemplateId.set(templateId, (recordsByTemplateId.get(templateId) || 0) + totalRecords);
    }

    var stats = dimensions.map(function (dimension) {
      var dimId = String(dimension._id);
      var templateIds = templateIdsByDimension.get(dimId) || [];

      // Resumenes a la medida (ver funciones arriba): cada uno cubre una
      // plantilla puntual con las cifras que de verdad importan para ese
      // proceso. El desglose generico se conserva para TODAS las plantillas:
      // el usuario puede ver tanto el panorama curado como el detalle de cada
      // archivo sin que Actividad de bienestar/cultural desaparezcan.
      var curado = normKey(dimension.name) === BIENESTAR_DIMENSION_KEY
        ? buildBienestarCurado(templateIds, templateInfoById, publishedTemplates, dependencyNameByCode)
        : null;
      var rutasAprendizaje = buildRutasAprendizajeCurado(templateIds, templateInfoById, publishedTemplates, resolversByValidator);
      var practicas = buildPracticasCurado(templateIds, templateInfoById, publishedTemplates, resolversByValidator);

      // Desglose GENERICO por plantilla (el resto de plantillas del ambito,
      // sin fusionar entre ellas): cada plantilla se presenta como su propia
      // tarjeta con sus totales/promedios numericos y su distribucion de
      // valores categoricos, en vez de mezclarse todas en un solo resumen de
      // ambito.
      var totalRegistrosReportados = 0;
      var plantillas = [];

      for (var i = 0; i < templateIds.length; i++) {
        var tId = templateIds[i];
        var templateRecords = recordsByTemplateId.get(tId) || 0;
        totalRegistrosReportados += templateRecords;
        if (templateRecords === 0) continue;

        var info = templateInfoById.get(tId) || { name: 'Sin nombre', fields: [] };
        var valuesByFieldName = fieldValuesByTemplateId.get(tId) || new Map();
        var resumen = buildFieldSummary(info.fields, valuesByFieldName, resolversByValidator);

        var templateTimelineMap = recordsByMonthByTemplate.get(tId) || new Map();
        var templateTimeline = Array.from(templateTimelineMap.entries())
          .map(function (pair) { return { month: pair[0], totalRegistros: pair[1] }; })
          .sort(function (a, b) { return a.month.localeCompare(b.month); });

        plantillas.push({
          templateId: tId,
          name: info.name,
          totalRegistros: templateRecords,
          numeric: resumen.numeric.slice(0, 4),
          categorical: resumen.categorical.slice(0, 6),
          timeline: templateTimeline,
        });
      }

      plantillas.sort(function (a, b) { return b.totalRegistros - a.totalRegistros; });

      var dimMonthMap = recordsByMonthByDim.get(dimId) || new Map();
      var timeline = Array.from(dimMonthMap.entries())
        .map(function (pair) { return { month: pair[0], totalRegistros: pair[1] }; })
        .sort(function (a, b) { return a.month.localeCompare(b.month); });

      return {
        _id: dimension._id,
        name: dimension.name,
        totalRegistrosReportados: totalRegistrosReportados,
        plantillas: plantillas,
        timeline: timeline,
        curado: curado,
        rutasAprendizaje: rutasAprendizaje,
        practicas: practicas,
        actividadBienestar: actividadBienestarByDimension.get(dimId) || null,
      };
    });

    var globalTimeline = Array.from(recordsByMonth.entries())
      .map(function (pair) { return { month: pair[0], totalRegistros: pair[1] }; })
      .sort(function (a, b) { return a.month.localeCompare(b.month); });

    res.status(200).json({ stats: stats, timeline: globalTimeline });
  } catch (error) {
    console.error('Error building tablero stats:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

dimensionController.getDimensions = async (req, res) => {
  const dimensions = await Dimension.find();
  res.status(200).json(dimensions);
}

dimensionController.getDimensionsPagination = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || '';
  const email = req.query.email;
  const skip = (page - 1) * limit;

  try {
    let query = {};

    // Si hay email, filtrar por dimensiones donde el usuario es visualizer
    if (email) {

      // Buscar el usuario
      const user = await User.findOne({ email, isActive: true });
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Si es administrador, mostrar todas las dimensiones
      if (user.activeRole === 'Administrador') {
        // No agregar filtro, mostrar todas
      } else {
        // Buscar las dependencias donde el usuario es visualizer
        const leaderDependencies = await Dependency.find({
          visualizers: { $in: [email] }
        });

        if (leaderDependencies.length === 0) {
          return res.status(200).json({
            dimensions: [],
            total: 0,
            page,
            pages: 0
          });
        }

        const dependencyIds = leaderDependencies.map(dep => dep._id);

        // Filtrar dimensiones por dependencias del usuario
        query.responsible = { $in: dependencyIds };
      }
    }

    // Agregar filtro de búsqueda si existe
    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }

    const dimensions = await Dimension
      .find(query)
      .populate('responsible')
      .populate('producers')
      .skip(skip)
      .limit(limit);
    const total = await Dimension.countDocuments(query);

    res.status(200).json({
      dimensions,
      total,
      page,
      pages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error fetching dimensions:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

dimensionController.getDimensionsByResponsible = async (req, res) => {
  const email = req.query.email;
  try {
    const User = require('../models/users');

    // Buscar el usuario
    const user = await User.findOne({ email, isActive: true });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Buscar las dependencias donde el usuario es visualizer
    const leaderDependencies = await Dependency.find({
      visualizers: { $in: [email] }
    });

    if (leaderDependencies.length === 0) {
      return res.status(200).json([]);
    }

    const dependencyIds = leaderDependencies.map(dep => dep._id);

    // Buscar dimensiones donde las dependencias del líder son responsables
    const dimensions = await Dimension.find({
      responsible: { $in: dependencyIds }
    }).populate('responsible');

    res.status(200).json(dimensions);
  } catch (error) {
    console.error('Error fetching dimensions by responsible:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

dimensionController.createDimension = async (req, res) => {
  try {
    const name = req.body.name;
    const nameLowerCase = req.body.name.toLowerCase();
    const existingDimension = await Dimension.findOne({ name: { $regex: new RegExp(`^${nameLowerCase}$`, 'i') } });

    if (existingDimension) {
      return res.status(400).json({ error: "La dimensión con ese nombre ya existe" });
    }

    const dimension = new Dimension({
      ...req.body,
      name: name
    });

    await dimension.save();

    // Registrar en auditoría (non-blocking)
    try {
      const userEmail = req.body.userEmail || req.query.email || req.headers['user-email'];
      console.log('🔍 Attempting audit log for dimension creation, userEmail:', userEmail);
      if (userEmail) {
        const user = await User.findOne({ email: userEmail });
        console.log('🔍 User found for audit:', user ? 'YES' : 'NO');
        if (user) {
          const dependency = await Dependency.findById(dimension.responsible);
          console.log('🔍 Dependency found:', dependency?.name);
          await AuditLogger.logCreate(req, user, 'dimension', {
            dimensionId: dimension._id.toString(),
            dimensionName: dimension.name,
            responsibleDependency: dependency?.name || 'dependencia desconocida'
          });
          console.log('✅ Audit log created successfully for dimension');
        }
      } else {
        console.log('⚠️ No userEmail found for audit logging');
      }
    } catch (auditError) {
      console.error('❌ Audit logging failed:', auditError);
    }

    res.status(200).json({ status: "Dimension created" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

dimensionController.updateDimension = async (req, res) => {
  const { id } = req.params;
  const dimensionData = req.body;

  try {
    // Encuentra la dimensión por su ID
    let dimension = await Dimension.findById(id);
    if (!dimension) {
      return res.status(404).json({ error: "Dimension not found" });
    }

    // Asigna las nuevas propiedades al documento
    Object.assign(dimension, dimensionData);

    // Guarda el documento actualizado
    await dimension.save();

    res.status(200).json({ dimension });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

dimensionController.deleteDimension = async (req, res) => {
  const { id } = req.params;

  try {
    const dimension = await Dimension.findById(id).populate('responsible');
    if (!dimension) {
      return res.status(404).json({ error: "Dimension not found" });
    }

    const dimensionName = dimension.name;
    const dependencyName = dimension.responsible?.name || 'dependencia desconocida';

    await Dimension.findByIdAndDelete(id);

    // Registrar en auditoría (non-blocking)
    try {
      const userEmail = req.body.userEmail || req.query.email || req.headers['user-email'];
      console.log('🔍 Attempting audit log for dimension deletion, userEmail:', userEmail);
      if (userEmail) {
        const user = await User.findOne({ email: userEmail });
        console.log('🔍 User found for audit:', user ? 'YES' : 'NO');
        if (user) {
          await AuditLogger.logDelete(req, user, 'dimension', {
            dimensionId: id,
            dimensionName: dimensionName,
            responsibleDependency: dependencyName
          });
          console.log('✅ Audit log created successfully for dimension deletion');
        }
      } else {
        console.log('⚠️ No userEmail found for audit logging');
      }
    } catch (auditError) {
      console.error('❌ Audit logging failed:', auditError);
    }

    res.status(200).json({ status: "Dimension deleted" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

dimensionController.getProducers = async (req, res) => {
  const { id } = req.params;

  try {
    const dimension = await Dimension.findById(id).populate('producers');
    if (!dimension) {
      return res.status(404).json({ error: "Dimension not found" });
    }

    res.status(200).json(dimension.producers || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

dimensionController.getDimensionsByUser = async (req, res) => {
  const { email } = req.params;

  try {
    const user = await User.findOne({ email, isActive: true });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    let dimensions;

    // Administrador y Usuario (rol base, sin ambito propio que consultar)
    // ven siempre todos los ambitos.
    if (user.activeRole === 'Administrador' || user.activeRole === 'Usuario') {
      dimensions = await Dimension.find({}, '_id name');
    } else {
      const userDependencies = await Dependency.find({
        visualizers: { $in: [email] }
      });

      if (userDependencies.length === 0) {
        // Sin ambito asignado como visualizador: en vez de dejarlo sin nada
        // que consultar, se le muestran todos los ambitos (misma logica que
        // Administrador). Si el usuario SI tiene al menos un ambito asignado,
        // se mantiene la restriccion de abajo.
        dimensions = await Dimension.find({}, '_id name');
      } else {
        const dependencyIds = userDependencies.map(dep => dep._id);
        dimensions = await Dimension.find(
          { responsible: { $in: dependencyIds } },
          '_id name'
        );
        // Si tiene dependencia(s) asignadas pero ninguna es responsable de un
        // ambito, tambien se cae al listado completo (mismo criterio: mejor
        // mostrar todo que dejarlo sin nada que consultar).
        if (dimensions.length === 0) {
          dimensions = await Dimension.find({}, '_id name');
        }
      }
    }

    res.status(200).json(dimensions);
  } catch (error) {
    console.error('Error fetching dimensions by user:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

dimensionController.getDimensionById = async (req, res) => {
  const { id } = req.params;

  try {
    const dimension = await Dimension.findById(id);
    if (!dimension) {
      return res.status(404).json({ error: "Dimension not found" });
    }
    res.status(200).json(dimension);
  } catch (error) {
    console.error('Error fetching dimension by id:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

module.exports = dimensionController;
