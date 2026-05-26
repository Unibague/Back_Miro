/**
 * Códigos 1, 2, 3 de Plantilla_info_programas_con_IDs.xlsx → dep_code en Mongo (dependencies).
 */

function normNombreFacultad(s) {
  return String(s ?? '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ');
}

/** Mapeo institucional acordado (columna «Código facultades» del Excel). */
const EXCEL_CODIGO_A_DEP_CODE = {
  '1': '118',
  '2': '128',
  '3': '134',
};

const EXCEL_CODIGO_NOMBRE_REF = {
  '1': 'Facultad de Derecho, Administracion y Economia',
  '2': 'Facultad de Ciencias, Ingenieria e Innovacion',
  '3': 'Facultad de Humanidades, Artes, Filosofia y Educacion',
};

/** Respaldo si el dep_code cambiara pero el nombre en BD sigue siendo «FACULTAD DE …». */
const EXCEL_CODIGO_A_FRAGMENTOS = {
  '1': ['DERECHO', 'ADMINISTRACION Y ECONOMIA'],
  '2': ['CIENCIAS', 'INGENIERIA E INNOVACION'],
  '3': ['HUMANIDADES', 'ARTES', 'FILOSOFIA Y EDUCACION'],
};

/**
 * @param {Array<{ dep_code: string, name?: string }>} facs
 * @returns {Array<{ codigo_excel: string, dep_code: string, name: string }>}
 */
function buildMapeoExcelFacultadesMen(facs) {
  return ['1', '2', '3'].map((codigo) => {
    const dep_code = EXCEL_CODIGO_A_DEP_CODE[codigo];
    const fac = facs.find((f) => f.dep_code === dep_code);
    return {
      codigo_excel: codigo,
      dep_code,
      name: fac?.name ?? EXCEL_CODIGO_NOMBRE_REF[codigo],
      en_bd: !!fac,
    };
  });
}

/**
 * @param {string} codigoExcel — "1", "2", "3", "118", "128", "134", …
 * @param {Array<{ dep_code: string, name?: string }>} facs
 */
function buscarFacultadPorCodigoExcel(codigoExcel, facs) {
  const v = String(codigoExcel ?? '').trim();
  if (!v) return null;

  const depPorExcel = EXCEL_CODIGO_A_DEP_CODE[v];
  if (depPorExcel) {
    return facs.find((f) => f.dep_code === depPorExcel) ?? {
      dep_code: depPorExcel,
      name: EXCEL_CODIGO_NOMBRE_REF[v],
    };
  }

  const directa = facs.find((f) => f.dep_code === v);
  if (directa) return directa;

  const fragmentos = EXCEL_CODIGO_A_FRAGMENTOS[v];
  if (!fragmentos) return null;

  for (const f of facs) {
    const n = normNombreFacultad(f.name);
    if (!n.startsWith('FACULTAD DE ')) continue;
    if (fragmentos.some((fr) => n.includes(fr))) return f;
  }
  return null;
}

/**
 * @param {string} raw — valor columna Excel (1, 2, 3 o dep_code)
 * @param {Array<{ dep_code: string, name?: string }>} facs
 */
const FACULTAD_NA_ALIASES = /^(na|n\/a|n\.a\.|n\.a|nd|n\/d|-|—|sin dato|s\/d|no aplica|noaplica)$/i;

function resolverDepCodeFacultadDesdeExcel(raw, facs) {
  const v = String(raw ?? '').trim();

  if (FACULTAD_NA_ALIASES.test(v)) {
    const dep = EXCEL_CODIGO_A_DEP_CODE['1'];
    return {
      dep_code: dep,
      advertencia: `Facultad «${v}» en Excel: se usó 1 → dep_code ${dep}. Revise la fila en el archivo.`,
    };
  }

  if (!v) {
    const dep = EXCEL_CODIGO_A_DEP_CODE['1'];
    return {
      dep_code: dep,
      advertencia: 'Sin código facultad en Excel: se usó 1 → dep_code 118.',
    };
  }

  const depMapeado = EXCEL_CODIGO_A_DEP_CODE[v];
  if (depMapeado) {
    const fac = facs.find((f) => f.dep_code === depMapeado);
    return {
      dep_code: depMapeado,
      advertencia: fac
        ? null
        : `dep_code ${depMapeado} (Excel ${v}) no aparece en dependencies con prefijo «FACULTAD DE »; se guardará igual.`,
    };
  }

  const hit = buscarFacultadPorCodigoExcel(v, facs);
  if (hit) return { dep_code: hit.dep_code, advertencia: null };

  throw new Error(
    `Código facultad «${v}» no reconocido. Use 1→118, 2→128, 3→134 o dep_code 118/128/134.`,
  );
}

function etiquetasMapeoParaRespuesta(facs) {
  return buildMapeoExcelFacultadesMen(facs).map((m) => {
    const ok = m.en_bd ? '' : ' (no listada en BD con filtro FACULTAD DE)';
    return `${m.codigo_excel} → dep_code ${m.dep_code} — ${m.name}${ok}`;
  });
}

module.exports = {
  EXCEL_CODIGO_A_DEP_CODE,
  EXCEL_CODIGO_A_FRAGMENTOS,
  buildMapeoExcelFacultadesMen,
  buscarFacultadPorCodigoExcel,
  resolverDepCodeFacultadDesdeExcel,
  etiquetasMapeoParaRespuesta,
};
