const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const Validator = require('../models/validators');

const sourceId = '111111111111111111111111';
const targetId = '222222222222222222222222';
const clone = (value) => JSON.parse(JSON.stringify(value));
const catalog = (name, values = ['01', '02']) => ({
  _id: '333333333333333333333333', name,
  columns: [
    { name: 'CODIGO', type: 'Texto', is_validator: true, values },
    { name: 'DESCRIPCION', type: 'Texto', is_validator: false, values: values.map((value) => `Descripción ${value}`) },
  ],
});

function setup({ sources = [], existing = [], concurrent } = {}) {
  const stored = {
    [sourceId]: { screenshot: { validators: sources } },
    [targetId]: { screenshot: { validators: existing } },
  };
  const lookups = [];
  const Period = {
    async findById(id) {
      if (!stored[id]) return null;
      const period = clone(stored[id]);
      period.markModified = () => {};
      period.save = async () => { stored[id] = clone(period); };
      return period;
    },
    async updateOne(query, update) {
      if (concurrent) {
        stored[targetId].screenshot.validators.push(clone(concurrent));
        concurrent = null;
      }
      const validators = stored[query._id].screenshot.validators;
      if (validators.length !== query.$expr.$eq[1]) return { modifiedCount: 0 };
      validators.push(clone(update.$push['screenshot.validators']));
      return { modifiedCount: 1 };
    },
  };
  const filename = path.resolve(__dirname, '../controllers/validators.js');
  const localRequire = createRequire(filename);
  const context = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: context,
    console: { log() {}, warn() {}, error() {} },
    require(name) {
      if (name === '../models/periods') return Period;
      if (name === '../models/validators') return Validator;
      if (/^\.\.\/(models|routes|services)\//.test(name)) return {};
      return localRequire(name);
    },
  }, { filename });
  const controller = context.exports;
  controller.findValidatorByName = async (name, periodId, period) => {
    lookups.push({ name, periodId });
    assert.equal(periodId, sourceId);
    return period.screenshot.validators.find((validator) => validator.name === name) || null;
  };
  return { controller, stored, lookups };
}

test('copia el catálogo completo del origen incluyendo referencias de hojas adicionales', async () => {
  const source = catalog('Países');
  const { controller, stored } = setup({ sources: [source, catalog('Modalidades')] });
  const result = await controller.copyTemplateValidatorsToPeriod({
    fields: [{ name: 'PAIS', validate_with: 'Países - CODIGO' }],
    workbook_sheets: [{ fields: [
      { name: 'OTRO_PAIS', validate_with: { name: 'Países - DESCRIPCION' } },
      { name: 'MODALIDAD', validate_with: 'Modalidades - CODIGO' },
    ] }],
  }, sourceId, targetId);
  assert.equal(result.copied.length, 2);
  const copies = stored[targetId].screenshot.validators;
  assert.equal(copies.length, 2);
  assert.deepEqual(copies[0].columns.map((column) => ({ name: column.name, values: column.values })),
    source.columns.map((column) => ({ name: column.name, values: column.values })));
  assert.notEqual(copies[0]._id, source._id);
  assert.deepEqual(stored[sourceId].screenshot.validators[0], source);
});

test('reutiliza nombres equivalentes sin sobrescribir los datos del destino', async () => {
  const existing = catalog('PAISES', ['99']);
  const { controller, stored, lookups } = setup({ sources: [catalog('Países')], existing: [existing] });
  const result = await controller.copyTemplateValidatorsToPeriod({
    fields: [{ name: 'PAIS', validate_with: 'Países - CODIGO' }],
  }, sourceId, targetId);
  assert.equal(result.reused.length, 1);
  assert.equal(lookups.length, 0);
  assert.deepEqual(stored[targetId].screenshot.validators, [existing]);
});

test('duplicar varias plantillas con el mismo catálogo solo crea un validador', async () => {
  const { controller, stored } = setup({ sources: [catalog('Países')] });
  const template = { fields: [{ name: 'PAIS', validate_with: 'Países - CODIGO' }] };
  await controller.copyTemplateValidatorsToPeriod(template, sourceId, targetId);
  await controller.copyTemplateValidatorsToPeriod(template, sourceId, targetId);
  assert.equal(stored[targetId].screenshot.validators.length, 1);
});

test('una copia simultánea reutiliza el validador recién creado', async () => {
  const source = catalog('Países');
  const { controller, stored } = setup({ sources: [source], concurrent: source });
  const result = await controller.copyTemplateValidatorsToPeriod({ fields: [{ validate_with: 'Países - CODIGO' }] }, sourceId, targetId);
  assert.equal(result.reused.length, 1);
  assert.equal(stored[targetId].screenshot.validators.length, 1);
});

test('genera listas internas de hojas adicionales y conserva las existentes', async () => {
  const existing = catalog('MODALIDAD', ['Existente']);
  const { controller, stored } = setup({ existing: [existing] });
  await controller.copyTemplateValidatorsToPeriod({
    fields: [{ name: 'MODALIDAD', dropdown_options: ['Nueva'] }],
    workbook_sheets: [{ fields: [{ name: 'TURNO', dropdown_options: ['Diurno', 'Nocturno'] }] }],
  }, sourceId, targetId);
  assert.deepEqual(stored[targetId].screenshot.validators[0], existing);
  assert.equal(stored[targetId].screenshot.validators.length, 2);
  assert.deepEqual(stored[targetId].screenshot.validators[1].columns[0].values, ['Diurno', 'Nocturno']);
});

test('reporta referencias faltantes y omite validadores dinámicos de personas', async () => {
  const { controller } = setup();
  await assert.rejects(controller.copyTemplateValidatorsToPeriod({ fields: [{ validate_with: 'No existe - CODIGO' }] }, sourceId, targetId), /No se encontró el validador/);
  const result = await controller.copyTemplateValidatorsToPeriod({ fields: [
    { validate_with: 'Funcionarios - Identificacion' }, { validate_with: 'Estudiantes - Codigo' },
  ] }, sourceId, targetId);
  assert.equal(result.copied.length, 0);
});
