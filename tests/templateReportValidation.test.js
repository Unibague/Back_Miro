const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const path = require('node:path');
const { validateDatasetRules, isStrictDate } = require('../helpers/fieldConstraints');
const { sanitizeTemplateDropdownPayload } = require('../helpers/workbookDropdownSanitizer');
const { getEffectiveRequired } = require('../helpers/requiredFields');

// Ejecutar el controlador real aislando los servicios externos y sus cron jobs.
const filename = path.resolve(__dirname, '../controllers/validators.js');
const localRequire = createRequire(filename);
const moduleContext = { exports: {} };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  module: moduleContext,
  console: { log() {}, warn() {}, error() {} },
  require: (name) => /^(\.\.\/(models|routes|services)\/|mongoose$)/.test(name) ? {} : localRequire(name),
}, { filename });
const controller = moduleContext.exports;
const validate = (field, values) => controller.validateColumn({
  datatype: 'Texto Largo', required: true, ...field, values,
});

test('reportes rechazan fechas con letras e imposibles aunque el campo esté mal tipado', async () => {
  for (const name of ['FECHA_INICIO', 'FECHA_FINAL']) {
    const result = await validate({ name }, ['22 de octubre de 2026', '31/02/2026', '22/10/2026', '22/10/26', '2026-10-22T00:00:00.000Z']);
    assert.equal(result.status, false);
    assert.deepEqual(Array.from(result.errors, e => e.register), [1, 2]);
  }
  assert.equal(isStrictDate('2026-10-22Tbasura'), false);
  assert.equal(isStrictDate('29/02/26'), false);
});

test('DESCRIPCION_ACTIVIDAD acepta letras y números aun con metadatos alfabéticos antiguos', async () => {
  const result = await validate({ name: 'DESCRIPCION_ACTIVIDAD', content_type: 'alphabetic', comment: 'Obligatorio, alfabético (100).' }, ['Actividad deportiva 2026']);
  assert.equal(result.status, true);
});

test('CODIGO_CONVENIO admite códigos alfanuméricos conservando ceros, longitud y obligatoriedad', async () => {
  const field = { name: 'CODIGO_CONVENIO', datatype: 'Texto Largo', content_type: 'alphabetic', comment: 'Obligatario si la movilidad se realiza en virtud de algún convenio, alfabético (30). Código o número del convenio' };
  assert.equal((await validate(field, ['032-2023', 'CV-001/2026', '0032', 'Convenio 12', 'ABC'])).status, true);
  const invalid = await validate(field, ['x'.repeat(31), '']);
  assert.deepEqual(Array.from(invalid.errors, error => error.register), [1, 2]);
  assert.match(invalid.errors[0].message, /30 caracteres/);
  assert.equal((await validate({ ...field, required_override: true }, [''])).status, true);
  const sanitized = await sanitizeTemplateDropdownPayload({ fields: [field], workbook_sheets: [{ name: 'Movilidad', fields: [field] }] });
  for (const normalized of [sanitized.fields[0], sanitized.workbook_sheets[0].fields[0]]) {
    assert.equal(normalized.content_type, 'alphanumeric');
    assert.equal(normalized.max_length, 30);
    assert.match(normalized.comment, /alfanumérico \(30\)/);
    assert.match(normalized.comment, /si la movilidad/);
  }
  assert.equal((await validate({ name: 'OTRO_NOMBRE', content_type: 'alphabetic' }, ['Entidad 2026'])).status, false);
});

test('todos los textos alfabéticos admiten los nombres y la puntuación de la captura', async () => {
  const names = [
    'INTERASEO S.A.S. E.S.P.',
    'ASOCIACIÓN DE EGRESADOS DE LA UNIVERSIDAD DE LOS ANDES, UNIANDINOS',
    'CONSERVATORIO DE IBAGUE INSTITUCION EDUCATIVA TECNICA MUSICAL "AMINA MELENDRO DE PULECIO"',
    'CLÍNICA ASOTRAUMA S.A.S.',
    'ASOCIACIÓN TURÍSTICA DE RESILIENTES POR LA PAZ – LA GEMA ESCONDIDA',
    'FRULAT GROUP S.A.S',
    'CENTRO DE DESARROLLO INTEGRAL NUEVAMENTE S.A.S.',
    'Fundación D’Angelo & Asociados (sede: “José”) / N/A',
    'Jose\u0301 – Fundacio\u0301n',
  ];
  for (const name of ['INSTITUCION_ASOCIADA', 'NOMBRE_ENTIDAD', 'OTRO_CAMPO_DE_TEXTO']) {
    const field = { name, comment: 'Obligatorio, alfabético (300).' };
    assert.equal((await validate(field, names)).status, true);
    const invalid = await validate(field, ['Institución 2026', '', 'x'.repeat(301)]);
    assert.deepEqual(Array.from(invalid.errors, error => error.register), [1, 2, 3]);
  }
  assert.equal((await validate({ name: 'OTRO_CAMPO', content_type: 'alphanumeric' }, ['Plan 2026: área_A/B + I+D (50%).'])).status, true);
  assert.equal((await validate({ name: 'CODIGO_NUMERICO', content_type: 'numeric' }, ['170.0', '170-A'])).status, false);
  assert.equal((await validate({ name: 'OTRAS_ACTIVIDADES_COOPERACION' }, ['S/N', 'S.'])).status, false);
  assert.equal((await validate({ name: 'CATALOGO', dropdown_options: ['Opción válida'] }, ['Opción inventada.'])).status, false);
});

test('las ocho descripciones de la captura aceptan puntuación sin perder longitud u obligatoriedad', async () => {
  const field = { name: 'DESCRIPCION_ACTIVIDAD', content_type: 'alphabetic', comment: 'Obligatorio, alfabético (300).' };
  const descriptions = [
    'Ruleta de autoconocimiento e identificación de mi rol como mujer desde mi accionar academico_Conmemoración día de la mujer',
    'Taller prueba académica - reingreso',
    'Taller: Espacios de conversación 2026A',
    'Taller: Gestión del estrés "Mente en calma, mente en acción"',
    'Taller: Talleres de Integración y Adaptación Universitaria',
    'Taller: Aprende a tu manera, descubre tu estilo de aprendizaje',
    'Taller: Desarrollo de habilidades blandas',
    'Programa de acompañamiento académico individual, éxito académico',
  ];
  assert.equal((await validate(field, descriptions)).status, true);
  const invalid = await validate(field, ['', 'x'.repeat(301)]);
  assert.deepEqual(Array.from(invalid.errors, e => e.register), [1, 2]);
  assert.match(invalid.errors[1].message, /300 caracteres/);
  // Los textos alfanuméricos también admiten separadores habituales.
  assert.equal((await validate({ name: 'CODIGO', content_type: 'alphanumeric' }, ['ABC_123'])).status, true);
});

test('las listas validan códigos y etiquetas sin aplicar la longitud del código a la etiqueta', async () => {
  for (const name of ['ID_TIPO_ACTIVIDAD_BIENESTAR', 'ID_FUENTE_NACIONAL']) {
    const result = await validate({ name, comment: 'Numérico (2)', dropdown_options: ['10 - Actividad nacional', '20 - Otra actividad'] }, ['10 - Actividad nacional', 20, '99 - Inventada', 1, '10 - Inventada']);
    assert.equal(result.status, false);
    assert.deepEqual(Array.from(result.errors, e => e.register), [3, 4, 5]);
  }
});

test('ID_FUENTE_NACIONAL admite la etiqueta completa del informe con o sin guion', async () => {
  for (const dropdown_options of [['1 - Recursos IES', '2 - Recursos públicos'], ['1 Recursos IES', '2 Recursos públicos']]) {
    const result = await validate({ name: 'ID_FUENTE_NACIONAL', comment: 'Obligatorio, numérico (2).', dropdown_options },
      ['1 Recursos IES', '1 - Recursos IES', '1', '2 Recursos públicos', '1 Recursos inventados', '3 Recursos IES']);
    assert.deepEqual(Array.from(result.errors, error => error.register), [5, 6]);
    assert.ok(result.errors.every(error => !/caracteres|dígitos/.test(error.message)));
  }
});

test('también se respetan las listas de validadores conectados por período', async () => {
  let requestedPeriod;
  controller.findValidatorByName = async (name, period) => {
    requestedPeriod = period;
    return { name, columns: [
      { name: 'CODIGO', is_validator: true, values: [10, 20] },
      { name: 'DESCRIPCION', values: ['Nacional', 'Internacional'] },
    ] };
  };
  const result = await controller.validateColumn({ name: 'ID_FUENTE_NACIONAL', datatype: 'Texto Largo', comment: 'Numérico (2)', validate_with: 'Fuentes - CODIGO', required: true, values: ['10 - Nacional', 20, '10 - Inventada', 1] }, 'periodo-2026');
  assert.equal(requestedPeriod, 'periodo-2026');
  assert.deepEqual(Array.from(result.errors, e => e.register), [3, 4]);
});

test('financiación permite cero cuando no aplica y mantiene el país numérico', async () => {
  for (const name of ['ID_PAIS_FINANCIADOR', 'NOMBRE_ENTIDAD_FTE_INTERNACIONAL']) {
    const result = await validate({ name, content_type: 'alphabetic', dropdown_options: ['840 - Estados Unidos'] }, [0, '0']);
    assert.equal(result.status, true);
  }
  assert.equal((await validate({ name: 'NOMBRE_ENTIDAD_FTE_INTERNACIONAL', content_type: 'alphabetic' }, ['Entidad 2026'])).status, true);
  assert.equal((await validate({ name: 'ID_PAIS_FINANCIADOR', content_type: 'alphabetic' }, ['Colombia'])).status, false);
});

test('nombre de entidad internacional abreviado acepta N/A en las ocho filas de la captura', async () => {
  for (const name of ['NOMBRE_ENTIDAD_FTE_INTERNAC', 'NOMBRE_ENTIDAD_FTE_INTERNACIONAL']) {
    const field = { name, content_type: 'alphabetic', comment: 'Obligatorio, alfabético (100).' };
    assert.equal((await validate(field, Array(8).fill('N/A'))).status, true);
    assert.equal((await validate(field, ['N/A', 'n/a', '0', 0, 'Fundación Internacional S.A. - 2026'])).status, true);
    assert.equal((await validate({ ...field, dropdown_options: ['Entidad registrada'] }, ['N/A', '0', 'Entidad registrada'])).status, true);
    const invalid = await validate(field, ['', 'x'.repeat(101)]);
    assert.deepEqual(Array.from(invalid.errors, error => error.register), [1, 2]);
    assert.match(invalid.errors[1].message, /100 caracteres/);
    assert.equal((await validate({ ...field, max_length: 2, dropdown_options: ['Entidad registrada'] }, ['N/A'])).status, false);
  }
  assert.equal((await validate({ name: 'ID_PAIS_FINANCIADOR' }, ['N/A'])).status, false);
  assert.equal((await validate({ name: 'OTRO_NOMBRE', content_type: 'alphabetic' }, ['N/A'])).status, true);
});

test('país de institución asociada no permite letras, incluso con una lista mal configurada', async () => {
  const result = await validate({ name: 'ID_PAIS INSTITUCIÓN ASOCIADA', dropdown_options: ['Colombia', '170', '840 - Estados Unidos'] }, ['Colombia', '170abc', 170, '840 - Estados Unidos', '840 - Inventado']);
  assert.deepEqual(Array.from(result.errors, e => e.register), [1, 2, 5]);
});

test('cooperación solo acepta S/N, sin descripciones ni índices de opciones', async () => {
  const result = await validate({ name: 'OTRAS_ACTIVIDADES_COOPERACIÓN' }, ['S', 'N', 'Sí', 'No', 'Descripción', 1, 'S - Sí']);
  assert.deepEqual(Array.from(result.errors, e => e.register), [3, 4, 5, 6, 7]);
});

test('cualquier pregunta S/N exige S o N aunque conserve listas y tipos antiguos', async () => {
  const field = { name: 'ACTIVIDADES_FORMACION', datatype: 'Texto Largo', required: true,
    comment: 'Obligatorio, alfabético (1). El convenio dentro de sus principales actividades incluye actividades de formación (S/N)?',
    multiple: true, dropdown_options: ['f'], excel_validation_options: ['X'], validator_options: ['Sí'] };
  const result = await validate(field, ['S', 'N', 'f', 'Sí', 'No', 'SN', 1, '', 's']);
  assert.deepEqual(Array.from(result.errors, e => e.register), [3, 4, 5, 6, 7, 8, 9]);
  const sanitized = await sanitizeTemplateDropdownPayload({ fields: [field], workbook_sheets: [{ name: 'Convenios', fields: [field] }] });
  for (const normalized of [sanitized.fields[0], sanitized.workbook_sheets[0].fields[0]]) {
    assert.deepEqual(normalized.dropdown_options, ['S', 'N']);
    assert.equal(normalized.multiple, false);
  }
});

test('movilidad saliente rechaza Colombia en cualquier hoja del reporte', () => {
  const errors = validateDatasetRules({ templateName: 'Movilidad_internacional_saliente', sheetName: 'Hoja 2', fields: [{ name: 'ID_PAIS_EXTRANJERO' }], rows: [{ ID_PAIS_EXTRANJERO: '170 - Colombia' }, { ID_PAIS_EXTRANJERO: 170 }, { ID_PAIS_EXTRANJERO: 840 }] });
  assert.equal(errors[0].sheet_name, 'Hoja 2');
  assert.deepEqual(errors[0].errors.map(e => e.register), [1, 2]);
});

test('país extranjero rechaza 170 también en movilidad hacia Colombia y con nombres abreviados', () => {
  for (const templateName of ['Movilidad_de_estudiantes_del_exterior_hacia_Colombia', 'MOV_ESTUD_HACIA_COLOMBIA', 'Plantilla renombrada', '']) {
    const errors = validateDatasetRules({ templateName, sheetName: 'MOV_ESTUD_HACIA_COLOMBIA',
      fields: [{ name: 'ID_PAIS_EXTRANJERO' }, { name: 'PROGRAMA ACADÉMICO' }],
      rows: [
        { ID_PAIS_EXTRANJERO: '063' }, { ID_PAIS_EXTRANJERO: '589' },
        { ID_PAIS_EXTRANJERO: '063' }, { ID_PAIS_EXTRANJERO: 170 },
        { ID_PAIS_EXTRANJERO: '170 - Colombia' }, { ID_PAIS_EXTRANJERO: '0170' },
      ],
    });
    assert.equal(errors.length, 1);
    assert.equal(errors[0].column, 'ID_PAIS_EXTRANJERO');
    assert.equal(errors[0].sheet_name, 'MOV_ESTUD_HACIA_COLOMBIA');
    assert.deepEqual(errors[0].errors.map(error => error.register), [4, 5, 6]);
  }
});

test('descargas y snapshots reciben S/N y fechas sin perder obligatoriedad u opciones de catálogo', async () => {
  const fields = [
    { name: 'OTRAS_ACTIVIDADES_COOPERACIÓN', locked: true, required: true, comment: 'Obligatorio' },
    { name: 'FECHA_INICIO', locked: true, required: true, comment: 'Obligatorio, numérico (8)' },
    { name: 'ID_TIPO_ACTIVIDAD_BIENESTAR', dropdown_options: ['10 - Bienestar'] },
  ];
  const sanitized = await sanitizeTemplateDropdownPayload({ fields, workbook_sheets: [{ name: 'Actividades', fields }] });
  assert.deepEqual(sanitized.fields[0].dropdown_options, ['S', 'N']);
  assert.match(sanitized.fields[0].comment, /S\/N/);
  assert.equal(sanitized.fields[1].datatype, 'Fecha');
  assert.equal(getEffectiveRequired(sanitized.fields[0]), true);
  assert.equal(getEffectiveRequired(sanitized.fields[1]), true);
  assert.equal(sanitized.workbook_sheets[0].fields[1].datatype, 'Fecha');
  assert.deepEqual(sanitized.fields[2].dropdown_options, fields[2].dropdown_options);
  assert.equal((await validate(fields[0], [''])).status, false);
  assert.equal((await validate({ ...fields[0], required_override: true }, [''])).status, true);
  assert.equal((await validate({ ...fields[1], comment: 'Opcional', required: false }, [''])).status, true);
});
