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

const sortedDistribution = (map, limit) => {
  const values = Array.from(map.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
  return limit ? values.slice(0, limit) : values;
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

const isActividadBienestarFile = (fileName) => {
  const key = normalizeKey(String(fileName || '').replace(/\.XLSX?$/i, ''));
  return key === 'ACTIVIDADDEBIENESTAR' || /^ACTIVIDADESBIENESTAR\d{4}[AB]?$/.test(key);
};

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
  };
};

module.exports = {
  buildActividadBienestarAnalytics,
  isActividadBienestarFile,
};
