const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getFieldConstraints,
  isStrictDate,
  parseCommentConstraints,
  validateDatasetRules,
  validateFieldValue,
} = require('../helpers/fieldConstraints');

test('interpreta el tipo y máximo de caracteres del comentario SNIES', () => {
  assert.deepEqual(parseCommentConstraints('Obligatorio, alfabético (50).\nPrimer nombre.'), {
    content_type: 'alphabetic', max_length: 50,
  });
  assert.deepEqual(parseCommentConstraints('Obligatorio, numérico (3).'), {
    content_type: 'numeric', max_length: 3,
  });
  assert.deepEqual(parseCommentConstraints('Alfanumérico (12)'), {
    content_type: 'alphanumeric', max_length: 12,
  });
});

test('la configuración explícita prevalece sobre el comentario', () => {
  assert.deepEqual(getFieldConstraints({
    datatype: 'Texto Largo', comment: 'Alfabético (50)', content_type: 'numeric', max_length: 8,
  }), {
    content_type: 'numeric', max_length: 8, min_value: undefined, max_value: undefined, integer_only: false,
  });
});

test('valida contenido, longitud y fechas estrictas', () => {
  const field = { name: 'PRIMER_NOMBRE', datatype: 'Texto Largo', comment: 'Obligatorio, alfabético (5).' };
  assert.deepEqual(validateFieldValue(field, 'María'), []);
  assert.ok(validateFieldValue(field, 'María2').some((message) => message.includes('letras')));
  assert.ok(validateFieldValue(field, 'Alejandro').some((message) => message.includes('5 caracteres')));
  assert.equal(isStrictDate('31/02/2026'), false);
  assert.equal(isStrictDate('28/02/2026'), true);
  assert.deepEqual(validateFieldValue({ datatype: 'Fecha Inicial / Fecha Final' }, ['02/09/2026', '01/09/2026']), [
    'debe tener la fecha inicial antes de la fecha final',
  ]);
  assert.ok(validateFieldValue({ datatype: 'Link' }, 'archivo.pdf').some((message) => message.includes('http')));
});

test('valida porcentajes por fila y movilidad internacional', () => {
  const errors = validateDatasetRules({
    templateName: 'Movilidad Internacional Saliente',
    fields: [
      { name: 'PORCENTAJE_DOCENCIA', datatype: 'Porcentaje' },
      { name: 'PORCENTAJE_INVESTIGACION', datatype: 'Porcentaje' },
      { name: 'ID_PAIS_EXTRANJERO', datatype: 'Entero' },
    ],
    rows: [{ PORCENTAJE_DOCENCIA: 80.5, PORCENTAJE_INVESTIGACION: 30, ID_PAIS_EXTRANJERO: 170 }],
  });
  const messages = errors.flatMap((item) => item.errors.map((error) => error.message));
  assert.ok(messages.some((message) => message.includes('número entero')));
  assert.ok(messages.some((message) => message.includes('superar 100')));
  assert.ok(messages.some((message) => message.includes('país 170')));
});

test('un documento no puede aparecer con dos tipos distintos', () => {
  const errors = validateDatasetRules({
    fields: [{ name: 'NUM_DOCUMENTO' }, { name: 'ID_TIPO_DOCUMENTO' }],
    rows: [
      { NUM_DOCUMENTO: '123', ID_TIPO_DOCUMENTO: 'CC' },
      { NUM_DOCUMENTO: '123', ID_TIPO_DOCUMENTO: 'TI' },
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0].errors[0].message, /otro tipo de documento/);
});
