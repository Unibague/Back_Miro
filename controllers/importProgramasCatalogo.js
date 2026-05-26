/**
 * Catálogo de programas (processes-MEN)
 *
 * GET  /programs/import/plantilla  → plantilla Excel
 * POST /programs/import/catalogo → alta masiva de programas (sin procesos ni historial)
 *
 * Código facultad en Excel (1, 2, 3): se mapea al orden alfabético de dependencias
 * cuyo nombre empieza por "FACULTAD DE". Si el valor ya coincide con un dep_code real, se usa tal cual.
 */

const ExcelJS = require('exceljs');
const multer = require('multer');
const Program = require('../models/programs');
const Process = require('../models/processes');
const Dependency = require('../models/dependencies');
const { applyDepCodeProgramaToCreatePayload } = require('../helpers/depCodePrograma');
const {
  normalizarNombrePrograma,
  findProgramaMismoNombre,
} = require('../helpers/nombreProgramaUnico');
const {
  buildMapeoExcelFacultadesMen,
  resolverDepCodeFacultadDesdeExcel,
  etiquetasMapeoParaRespuesta,
} = require('../helpers/facultadMenExcelMap');

const upload = multer({ storage: multer.memoryStorage() });
module.exports.uploadMiddleware = upload.single('archivo');

/** Encabezados alineados con Plantilla_info_programas_con_IDs.xlsx (hoja «Info base»). */
const PLANTILLA_HEADERS = [
  'ID_PROGRAMA',
  'Nombre del programa',
  'Código facultades (3 facultades nuevas)',
  'Código SNIES (no obligatorio)',
  'Modalidad',
  'Nivel académico',
  'Nivel de formación',
  'N.º créditos',
  'Periodos de duración',
  'N.º semestres',
  'Periodicidad de admision',
  'Numero de estudiantes en el primer periodo',
  'Estado',
  'Campo amplio',
  'Campo específico',
  'Campo detallado',
  'Área de conocimiento',
  'Núcleo Básico del Conocimiento - NBC',
];

/** @type {Record<string, string[]>} */
const HEADER_ALIASES = {
  id_programa: ['id_programa', 'id programa'],
  nombre: ['nombre del programa', 'nombre', 'programa'],
  dep_code_programa: ['codigo institucional', 'código institucional', 'codigo programa', 'código programa', 'cod institucional'],
  codigo_facultad: [
    'codigo facultades (3 facultades nuevas)',
    'codigo facultad',
    'código facultad',
    'código facultades (3 facultades nuevas)',
    'cod facultad',
    'facultad',
  ],
  codigo_snies: ['codigo snies (no obligatorio)', 'código snies (no obligatorio)', 'codigo snies', 'código snies', 'snies'],
  modalidad: ['modalidad'],
  nivel_academico: ['nivel academico', 'nivel académico'],
  nivel_formacion: ['nivel de formacion', 'nivel de formación', 'nivel formacion'],
  num_creditos: ['n.º creditos', 'nº creditos', 'n° creditos', 'n creditos', 'num creditos', 'creditos', 'créditos'],
  periodos_duracion: [
    'periodos de duracion',
    'periodos duracion',
    'periodos de duración',
    'n periodos de duracion',
    'n° periodos de duracion',
    'nº periodos de duracion',
    'numero de periodos',
    'número de periodos',
    'n periodos',
  ],
  num_semestres: ['n.º semestres', 'nº semestres', 'n° semestres', 'n semestres', 'num semestres', 'semestres'],
  admision_estudiantes: [
    'periodicidad de admision',
    'periodicidad de admisión',
    'periodicidad admision',
    'periodicidad admisión',
    'admision de estudiantes',
    'admisión de estudiantes',
    'admision',
  ],
  num_estudiantes_saces: [
    'numero de estudiantes en el primer periodo',
    'número de estudiantes en el primer periodo',
    'n° estudiantes saces',
    'n estudiantes saces',
    'estudiantes saces',
    'num estudiantes saces',
  ],
  estado: ['estado'],
  cine_amplio: ['cine campo amplio', 'campo amplio', 'cine amplio'],
  cine_especifico: ['cine campo especifico', 'cine campo específico', 'campo especifico', 'campo específico'],
  cine_detallado: ['cine campo detallado', 'campo detallado'],
  nbc_area: ['nbc area de conocimiento', 'nbc área de conocimiento', 'area de conocimiento', 'área de conocimiento'],
  nbc: ['nucleo basico del conocimiento - nbc', 'núcleo básico del conocimiento - nbc', 'nbc'],
};

function normHeader(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ');
}

function str(cell) {
  if (!cell || cell.value == null) return '';
  if (typeof cell.value === 'number' && Number.isFinite(cell.value)) {
    return Number.isInteger(cell.value) ? String(cell.value) : String(cell.value);
  }
  if (typeof cell.value === 'object' && cell.value.text) return String(cell.value.text).trim();
  if (cell.value instanceof Date) return cell.value.toISOString().slice(0, 10);
  return String(cell.value).trim();
}

/** Primer número en texto («10», «10 semestres», «10,5»). */
function extraerPrimerNumero(raw) {
  const s = String(raw ?? '').trim().replace(',', '.');
  if (!s) return null;
  const direct = parseFloat(s);
  if (Number.isFinite(direct) && /^-?\d+(\.\d+)?$/.test(s)) return direct;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0]);
  return Number.isFinite(n) ? n : null;
}

function num(cell) {
  return extraerPrimerNumero(str(cell));
}

/** NA, N/A, guiones, etc. → vacío (no guardar en enum ni como texto «Na»). */
const VALOR_VACIO_EXCEL = /^(na|n\/a|n\.a\.|n\.a|nd|n\/d|-|—|sin dato|s\/d|no aplica|noaplica|xxx+|xxxx+)$/i;

function esValorVacioExcel(v) {
  const t = String(v ?? '').trim();
  return !t || VALOR_VACIO_EXCEL.test(t);
}

function textoOpcional(v) {
  if (esValorVacioExcel(v)) return null;
  const t = String(v).trim();
  return t || null;
}

function tituloCase(s) {
  if (esValorVacioExcel(s)) return null;
  const t = s.trim();
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function normalizarModalidad(v) {
  if (esValorVacioExcel(v)) return null;
  const n = v.trim().toLowerCase();
  if (n.startsWith('pres')) return 'Presencial';
  if (n.startsWith('virt')) return 'Virtual';
  if (n.startsWith('híb') || n.startsWith('hib')) return 'Híbrido';
  return null;
}

function normalizarNivelAcademico(v) {
  if (esValorVacioExcel(v)) return null;
  const n = v.trim().toLowerCase();
  if (n.includes('posgr')) return 'Posgrado';
  if (n.includes('pregr')) return 'Pregrado';
  return null;
}

const NIVELES_FORMACION = new Set([
  'Profesional', 'Tecnológico', 'Técnico', 'Especialización', 'Maestría', 'Doctorado',
]);

function normalizarNivelFormacion(v) {
  if (esValorVacioExcel(v)) return null;
  const t = v.trim();
  for (const opt of NIVELES_FORMACION) {
    if (opt.toLowerCase() === t.toLowerCase()) return opt;
  }
  return null;
}

function normalizarEstado(v) {
  if (esValorVacioExcel(v)) return 'Activo';
  const n = v.trim().toLowerCase();
  if (n.startsWith('inact')) return 'Inactivo';
  return 'Activo';
}

function mapHeadersFromRow(row) {
  /** @type {Record<string, number>} */
  const col = {};
  row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    const h = normHeader(str(cell));
    if (!h) return;
    let matched = false;
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.some((a) => h === normHeader(a)) || h === normHeader(key)) {
        col[key] = colNumber;
        matched = true;
      }
    }
    if (!matched) {
      if (/periodos/.test(h) && /duraci/.test(h) && col.periodos_duracion == null) {
        col.periodos_duracion = colNumber;
      }
      if (/semestre/.test(h) && col.num_semestres == null) {
        col.num_semestres = colNumber;
      }
      if (/periodicidad/.test(h) && /admisi/.test(h) && col.admision_estudiantes == null) {
        col.admision_estudiantes = colNumber;
      }
    }
  });
  return col;
}

/** Hoja de catálogo: «Info base» del archivo institucional. */
function pickHojaCatalogo(wb) {
  const exact = wb.getWorksheet('Info base');
  if (exact) return exact;
  return (
    wb.worksheets.find((s) => normHeader(s.name) === 'info base')
    ?? wb.worksheets.find((s) => normHeader(s.name).includes('info base'))
    ?? null
  );
}

/** Fila 2 de la plantilla institucional (valores de ejemplo xxxx / xxx). */
function esFilaLeyenda(row, colMap) {
  const nombre = cellVal(row, colMap, 'nombre').toLowerCase();
  const id = (cellVal(row, colMap, 'id_programa') || cellVal(row, colMap, 'dep_code_programa')).toLowerCase();
  const fac = cellVal(row, colMap, 'codigo_facultad').toLowerCase();
  if (nombre.includes('xxxx') || id.includes('xxxx') || fac === 'xxx' || fac.includes('xxx')) return true;
  return false;
}

const PERIODICIDADES = /^(anual|semestral|trimestral|bimensual|mensual)$/i;

function leerPeriodosDuracion(row, colMap) {
  const idx = colMap.periodos_duracion;
  if (!idx) {
    const semIdx = colMap.num_semestres;
    if (!semIdx) return null;
    const rawSem = str(row.getCell(semIdx));
    if (PERIODICIDADES.test(rawSem) || /semestr|anual|trimestr/i.test(rawSem)) return null;
    return num(row.getCell(semIdx));
  }
  const raw = str(row.getCell(idx));
  if (!raw) return null;
  if (PERIODICIDADES.test(raw) || /semestr|anual|trimestr|bimens|mensual/i.test(raw)) {
    const semIdx = colMap.num_semestres;
    if (semIdx) return num(row.getCell(semIdx));
    return null;
  }
  return extraerPrimerNumero(raw);
}

/** Col. «Periodos de duración» a veces trae periodicidad (Semestral); la admisión va en su columna. */
function leerAdmisionEstudiantes(row, colMap) {
  const adm = cellVal(row, colMap, 'admision_estudiantes');
  if (adm) return adm;
  const idx = colMap.periodos_duracion;
  if (!idx) return null;
  const raw = str(row.getCell(idx));
  if (!raw) return null;
  if (Number.isFinite(parseFloat(raw))) return null;
  if (PERIODICIDADES.test(raw) || /semestr|anual|trimestr|bimens|mensual/i.test(raw)) return raw;
  return null;
}

function codigoInstitucionalDesdeFila(row, colMap) {
  return (
    cellVal(row, colMap, 'dep_code_programa')
    || cellVal(row, colMap, 'id_programa')
    || ''
  );
}

function cellVal(row, colMap, key) {
  const idx = colMap[key];
  if (!idx) return '';
  return str(row.getCell(idx));
}

function cellNum(row, colMap, key) {
  const idx = colMap[key];
  if (!idx) return null;
  return num(row.getCell(idx));
}

async function facultadesMenOrdenadas() {
  const all = await Dependency.find({}).select('dep_code name').lean();
  return all
    .filter((d) => (d.name ?? '').trim().toUpperCase().startsWith('FACULTAD DE '))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'es'));
}

async function buildFacultadCtx() {
  const facs = await facultadesMenOrdenadas();
  return {
    facs,
    mapeo: buildMapeoExcelFacultadesMen(facs),
    etiquetas: etiquetasMapeoParaRespuesta(facs),
  };
}

/**
 * Al importar catálogo, sembrar una ALERTA RC «Nuevo» sin fechas para abrir el flujo
 * desde la tabla de alertas. Solo aplica a programas sin RC activo, sin historial RC y
 * sin alerta RC previa.
 */
async function asegurarAlertaNuevoPrograma(program) {
  const program_code = String(program._id);
  if ((program.total_rc ?? 0) > 0) return { creada: false, motivo: 'ya_tiene_historial_rc' };

  const [rcActivo, alertaRc] = await Promise.all([
    Process.findOne({ program_code, tipo_proceso: 'RC' }).select('_id').lean(),
    Process.findOne({ program_code, tipo_proceso: 'ALERTA', alert_para_tipo: 'RC' }).select('_id').lean(),
  ]);
  if (rcActivo) return { creada: false, motivo: 'ya_tiene_rc_activo' };
  if (alertaRc) return { creada: false, motivo: 'ya_tiene_alerta_rc' };

  const alerta = await Process.create({
    name: `Alerta (RC) - ${program.nombre || program_code}`,
    program_code,
    tipo_proceso: 'ALERTA',
    alert_para_tipo: 'RC',
    subtipo: 'Nuevo',
    fase_actual: 0,
    cerrado_process_history_id: null,
    snapshot_codigo_resolucion: null,
    snapshot_fecha_resolucion: null,
    snapshot_duracion_anos: null,
    fecha_vencimiento: null,
    fecha_inicio: null,
    fecha_documento_par: null,
    fecha_digitacion_saces: null,
    fecha_radicado_men: null,
    obs_vencimiento: '',
    obs_inicio: '',
    obs_documento_par: '',
    obs_digitacion_saces: '',
    obs_radicado_men: '',
  });
  return { creada: true, alerta_id: String(alerta._id) };
}

module.exports.descargarPlantilla = async (_req, res) => {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Info base');
    ws.addRow(PLANTILLA_HEADERS);
    ws.getRow(1).font = { bold: true };
    ws.columns = PLANTILLA_HEADERS.map((h) => ({ width: Math.min(48, Math.max(14, h.length + 2)) }));

    const wsInfo = wb.addWorksheet('REFERENCIA');
    wsInfo.addRow(['Código Excel', 'dep_code en Miró', 'Nombre facultad']);
    wsInfo.getRow(1).font = { bold: true };
    const facs = await facultadesMenOrdenadas();
    const mapeo = buildMapeoExcelFacultadesMen(facs);
    mapeo.forEach((m) => wsInfo.addRow([m.codigo_excel, m.dep_code, m.name]));
    if (mapeo.length === 0) {
      wsInfo.addRow(['—', '—', 'No hay dependencias «FACULTAD DE» en la BD']);
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla_catalogo_programas.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('plantilla catalogo programas:', e);
    res.status(500).json({ error: 'No se pudo generar la plantilla.' });
  }
};

module.exports.importarCatalogo = async (req, res) => {
  if (!req.file?.buffer) {
    return res.status(400).json({ message: 'Falta el archivo Excel.', creados: [], errores: [{ fila: 0, error: 'Sin archivo' }] });
  }

  const creados = [];
  const actualizados = [];
  const errores = [];
  const omitidos = [];

  try {
    const facCtx = await buildFacultadCtx();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer);
    const ws = pickHojaCatalogo(wb);
    if (!ws || ws.rowCount < 2) {
      return res.status(400).json({
        message: 'No se encontró la hoja «Info base» o no tiene filas de datos.',
        creados: [],
        errores: [{ fila: 0, error: 'Use la hoja Info base del archivo institucional' }],
        omitidos: [],
        facultades_mapeo: facCtx.etiquetas,
      });
    }

    const colMap = mapHeadersFromRow(ws.getRow(1));
    if (!colMap.nombre) {
      return res.status(400).json({
        message: 'Falta la columna «Nombre del programa».',
        creados: [],
        errores: [{ fila: 1, error: 'Encabezado obligatorio no encontrado' }],
        omitidos: [],
        facultades_mapeo: facCtx.etiquetas,
      });
    }

    const nombresEnArchivo = new Set();

    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      if (esFilaLeyenda(row, colMap)) continue;

      const nombre = cellVal(row, colMap, 'nombre');
      if (!nombre) continue;

      try {
        const { dep_code, advertencia } = resolverDepCodeFacultadDesdeExcel(
          cellVal(row, colMap, 'codigo_facultad'),
          facCtx.facs,
        );

        const depProgRaw = codigoInstitucionalDesdeFila(row, colMap);
        const doc = {
          nombre: nombre.trim(),
          dep_code_facultad: dep_code,
          codigo_snies: textoOpcional(cellVal(row, colMap, 'codigo_snies')),
          modalidad: normalizarModalidad(cellVal(row, colMap, 'modalidad')),
          nivel_academico: normalizarNivelAcademico(cellVal(row, colMap, 'nivel_academico')),
          nivel_formacion: normalizarNivelFormacion(cellVal(row, colMap, 'nivel_formacion')),
          num_creditos: cellNum(row, colMap, 'num_creditos'),
          periodos_duracion: leerPeriodosDuracion(row, colMap),
          num_semestres: cellNum(row, colMap, 'num_semestres'),
          admision_estudiantes: textoOpcional(leerAdmisionEstudiantes(row, colMap)),
          num_estudiantes_saces: cellNum(row, colMap, 'num_estudiantes_saces'),
          estado: normalizarEstado(cellVal(row, colMap, 'estado')),
          cine_f: {
            campo_amplio: textoOpcional(cellVal(row, colMap, 'cine_amplio')),
            campo_especifico: textoOpcional(cellVal(row, colMap, 'cine_especifico')),
            campo_detallado: textoOpcional(cellVal(row, colMap, 'cine_detallado')),
          },
          nbc: {
            area_conocimiento: textoOpcional(cellVal(row, colMap, 'nbc_area')),
            nbc: textoOpcional(cellVal(row, colMap, 'nbc')),
          },
        };
        if (depProgRaw) doc.dep_code_programa = depProgRaw;
        applyDepCodeProgramaToCreatePayload(doc);

        const nombreNorm = normalizarNombrePrograma(doc.nombre).toLowerCase();
        if (nombresEnArchivo.has(nombreNorm)) {
          errores.push({ fila: r, error: `Nombre duplicado en el Excel: «${doc.nombre}».` });
          continue;
        }
        nombresEnArchivo.add(nombreNorm);

        const existenteNombre = await findProgramaMismoNombre(Program, doc.nombre);
        if (existenteNombre) {
          if (doc.dep_code_programa) {
            const otroCodigo = await Program.findOne({
              dep_code_programa: doc.dep_code_programa,
              _id: { $ne: existenteNombre._id },
            }).select('nombre').lean();
            if (otroCodigo) {
              omitidos.push({
                fila: r,
                dep_code_programa: doc.dep_code_programa,
                nombre: doc.nombre,
                razon: `Código ${doc.dep_code_programa} ya usado por «${otroCodigo.nombre}»`,
              });
              continue;
            }
          }
          const { nombre: _n, ...patch } = doc;
          const upd = await Program.findByIdAndUpdate(
            existenteNombre._id,
            { $set: patch },
            { new: true },
          );
          const alertaNuevo = await asegurarAlertaNuevoPrograma(upd);
          actualizados.push({
            fila: r,
            _id: String(upd._id),
            nombre: upd.nombre,
            dep_code_programa: upd.dep_code_programa ?? null,
            periodos_duracion: upd.periodos_duracion ?? null,
            alerta_nuevo_creada: alertaNuevo.creada === true,
            advertencia: advertencia ?? undefined,
          });
          continue;
        }

        if (doc.dep_code_programa) {
          const existe = await Program.findOne({ dep_code_programa: doc.dep_code_programa }).select('_id nombre').lean();
          if (existe) {
            omitidos.push({
              fila: r,
              dep_code_programa: doc.dep_code_programa,
              nombre: doc.nombre,
              razon: `Ya existe programa con ese código (${existe.nombre})`,
            });
            continue;
          }
        }

        const program = await Program.create(doc);
        const alertaNuevo = await asegurarAlertaNuevoPrograma(program);
        creados.push({
          fila: r,
          _id: String(program._id),
          nombre: program.nombre,
          dep_code_facultad: program.dep_code_facultad,
          dep_code_programa: program.dep_code_programa ?? null,
          periodos_duracion: program.periodos_duracion ?? null,
          alerta_nuevo_creada: alertaNuevo.creada === true,
          id_programa_excel: depProgRaw || undefined,
          advertencia: advertencia ?? undefined,
        });
      } catch (rowErr) {
        const msg = rowErr?.message || String(rowErr);
        if (rowErr?.code === 11000) {
          errores.push({ fila: r, error: 'Código de programa duplicado en BD.' });
        } else if (rowErr?.statusCode === 409) {
          errores.push({ fila: r, error: msg });
        } else {
          errores.push({ fila: r, error: msg });
        }
      }
    }

    const alertasNuevoCreadas = [...creados, ...actualizados].filter((x) => x.alerta_nuevo_creada === true).length;
    const message = `Importación finalizada: ${creados.length} creado(s), ${actualizados.length} actualizado(s), ${omitidos.length} omitido(s), ${errores.length} error(es), ${alertasNuevoCreadas} alerta(s) Nuevo.`;
    res.status(200).json({
      message,
      creados,
      actualizados,
      omitidos,
      errores,
      columnas_detectadas: colMap,
      facultades_mapeo: facCtx.etiquetas,
    });
  } catch (e) {
    console.error('import catalogo programas:', e);
    res.status(500).json({
      message: e?.message || 'Error al importar.',
      creados,
      omitidos,
      errores: [...errores, { fila: 0, error: e?.message || String(e) }],
      facultades_mapeo: [],
      actualizados: [],
    });
  }
};
