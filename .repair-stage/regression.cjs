
test('Excel compatible: sin matrices en reglas, sin rangos solapados y prioridades únicas', async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Movilidad');
  const fields = [
    { name: 'NOMBRE', datatype: 'Texto Largo', required: true, comment: 'Obligatorio, alfabético (50)' },
    { name: 'ID_PAIS_EXTRANJERO', datatype: 'Texto Largo', comment: 'Numérico (3)' },
    { name: 'ID_FUENTE_NACIONAL', dropdown_options: ['1 - Recursos IES', '2 - Recursos públicos'], comment: 'Numérico (2)' },
    { name: 'PORCENTAJE_A', datatype: 'Porcentaje' }, { name: 'PORCENTAJE_B', datatype: 'Porcentaje' },
  ];
  applyValidatorDropdowns({ workbook: book, worksheet: sheet, fields, validators: [], endRow: 1000 });
  const buffer = await book.xlsx.writeBuffer();
  const zip = await require('jszip').loadAsync(buffer);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const validations = [...xml.matchAll(/<dataValidation\b[^>]*\bsqref="([^"]+)"[^>]*>([\s\S]*?)<\/dataValidation>/g)];
  assert.equal(validations.length, fields.length);
  const occupied = new Set();
  for (const [, range, content] of validations) {
    assert.doesNotMatch(content, /[{}]/);
    const match = /^([A-Z]+)(\d+):\1(\d+)$/.exec(range);
    assert.ok(match, range);
    for (let row = Number(match[2]); row <= Number(match[3]); row++) {
      const cell = `${match[1]}${row}`;
      assert.equal(occupied.has(cell), false, `Validación duplicada: ${cell}`);
      occupied.add(cell);
    }
  }
  const formats = [...xml.matchAll(/<cfRule\b[^>]*priority="(\d+)"[^>]*>([\s\S]*?)<\/cfRule>/g)];
  assert.ok(formats.length > 0);
  assert.equal(new Set(formats.map(match => match[1])).size, formats.length);
  formats.forEach(([, , content]) => assert.doesNotMatch(content, /[{}]/));
});

test('ID_FUENTE_NACIONAL acepta la etiqueta exacta con o sin guion, no etiquetas inventadas', () => {
  const field = { name: 'ID_FUENTE_NACIONAL', datatype: 'Texto Largo', comment: 'Numérico (2)', dropdown_options: ['1 - Recursos IES', '2 - Recursos públicos'] };
  assert.equal(onlineError(field, '1 Recursos IES'), '');
  assert.equal(onlineError(field, '1 - Recursos IES'), '');
  assert.ok(onlineError(field, '1 Recursos inventados'));
});
