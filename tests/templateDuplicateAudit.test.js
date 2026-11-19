const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');

function load(relativePath, mocks) {
  const filename = path.resolve(__dirname, relativePath);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    console: { log() {}, error() {} },
    require: (name) => mocks[name] || localRequire(name),
  }, { filename });
  return module.exports;
}

test('duplicación individual y masiva registran al actor aunque solo se envíe su correo', async () => {
  const logs = [];
  const middleware = load('../middleware/configurationAudit.js', {
    '../services/configurationAudit': { logTemplateChange: async (...args) => logs.push(args) },
    '../models/templates': {}, '../models/reports': {}, '../models/producerReports': {},
    '../models/users': {
      findOne: ({ email }) => ({ select: () => ({ lean: async () => ({ full_name: `Nombre de ${email}` }) }) }),
    },
  });
  for (const [index, email] of ['persona1@example.com', 'persona2@example.com'].entries()) {
    const req = { method: 'POST', params: {}, body: { email, id: 'original' }, query: {}, headers: {} };
    let response;
    const res = { json: (data) => { response = data; } };
    await middleware('template')(req, res, () => {});
    const copy = { _id: `copia-${index}`, template: { name: 'Plantilla - 2026B', created_by: { full_name: 'Creador original' } } };
    await res.json(copy);
    assert.equal(logs[index][0], copy._id);
    assert.equal(logs[index][2].email, email);
    assert.equal(logs[index][2].full_name, `Nombre de ${email}`);
    assert.equal(response, copy);
  }
});

test('las copias anteriores muestran la persona por correo sin alterar autores históricos ni eventos de sistema', async () => {
  let queries = 0;
  const audits = [
    { user: { email: 'persona@example.com', full_name: 'System' } },
    { user: { email: 'persona@example.com', full_name: 'Nombre histórico' } },
    { user: { email: 'system', full_name: 'System' } },
    { user: { email: 'eliminada@example.com', full_name: 'System' } },
  ];
  const Service = load('../services/configurationAudit.js', {
    '../models/configurationAudit': {},
    '../models/users': {
      find: (query) => {
        queries += 1;
        assert.deepEqual(Array.from(query.email.$in), ['persona@example.com', 'eliminada@example.com']);
        return { select: () => ({ lean: async () => [{ email: 'persona@example.com', full_name: 'Persona que duplicó' }] }) };
      },
    },
  });
  await Service.resolveAuditUserNames(audits);
  assert.equal(queries, 1);
  assert.equal(audits[0].user.full_name, 'Persona que duplicó');
  assert.equal(audits[1].user.full_name, 'Nombre histórico');
  assert.equal(audits[2].user.full_name, 'System');
  assert.equal(audits[3].user.full_name, 'eliminada@example.com');
  await Service.resolveAuditUserNames(audits);
  assert.equal(queries, 1);
});

test('el listado de última modificación resuelve nombres de las copias existentes', async () => {
  const id = '111111111111111111111111';
  const Service = load('../services/configurationAudit.js', {
    '../models/configurationAudit': {
      aggregate: async () => [{ _id: id, doc: { user: { email: 'persona@example.com', full_name: 'System' } } }],
    },
    '../models/users': {
      find: () => ({ select: () => ({ lean: async () => [{ email: 'persona@example.com', full_name: 'Persona que duplicó' }] }) }),
    },
  });
  const result = await Service.getLatestAuditsForEntities('template', [id]);
  assert.equal(result[id].user.full_name, 'Persona que duplicó');
});
