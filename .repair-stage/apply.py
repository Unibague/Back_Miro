from pathlib import Path

front = Path(r'C:\Users\UNIBAGUE\Documents\Miro\Front_Miro')
stage = Path(__file__).parent

def replace(text, old, new):
    assert old in text, old[:120]
    return text.replace(old, new, 1)

def rules(text):
    begin = text.index('export const excelDigitsFormula =')
    end = text.index('export const applyExcelFieldValidation', begin)
    text = text[:begin] + '''const removeExcelDigits = (address: string): string => {
  let result = address;
  for (const digit of '0123456789') result = `SUBSTITUTE(${result},"${digit}","")`;
  return result;
};

export const excelDigitsFormula = (address: string): string =>
  `AND(LEN(${address})>0,LEN(${removeExcelDigits(address)})=0)`;

''' + text[end:]
    text = replace(text, 'rules.push(`SUMPRODUCT(--ISNUMBER(SEARCH({"0","1","2","3","4","5","6","7","8","9"},${ref})))=0`);', 'rules.push(`LEN(${removeExcelDigits(ref)})=LEN(${ref})`);')
    # Una regla relativa por columna. ExcelJS optimiza mal los miles de entradas
    # individuales iguales y puede generar rangos superpuestos al serializar.
    begin = text.index('      for (let row = item.firstRow; row <= endRow; row++) {')
    end = text.index('\n    });\n  });', begin)
    text = text[:begin] + '''      const model = (worksheet as any).dataValidations.model;
      const range = `${ref}:${letter(item.col)}${endRow}`;
      const validation: ExcelJS.DataValidation = model[range] || worksheet.getCell(item.firstRow, item.col).dataValidation;
      if (validation.type === 'list') return;
      const base = excelValidationFormula(validation, ref);
      const combined = { ...validation, type: 'custom', formulae: [`IFERROR(AND(${base},${rule}),FALSE)`], showErrorMessage: true, errorStyle: 'stop', errorTitle: 'Porcentaje no válido', error: 'Ingrese un porcentaje entero; la suma del grupo no puede superar 100.' };
      delete combined.operator;
      model[range] = combined;
''' + text[end:]
    return text

def templates(text):
    begin = text.index('    for (let row = firstRow; row <= endRow; row++) applyDatatypeValidation')
    end = text.index('    if (validation.type) highlightExcelValidation', begin)
    text = text[:begin] + '''    const firstCell = worksheet.getCell(firstRow, col);
    applyDatatypeValidation(firstCell, field);
    const ref = `${toColumnLetter(col)}${firstRow}`;
    const validation = firstCell.dataValidation;
    if (validation.type) {
      delete (worksheet as any).dataValidations.model[ref];
      (worksheet as any).dataValidations.add(`${ref}:${toColumnLetter(col)}${endRow}`, validation);
    }
    if (firstCell.numFmt) worksheet.getColumn(col).numFmt = firstCell.numFmt;
''' + text[end:]
    text = replace(text, '  compactExcelValidationFormulas(workbook, worksheet);', '''  compactExcelValidationFormulas(workbook, worksheet);
  let priority = 1;
  ((worksheet as any).conditionalFormattings || []).forEach((format: any) => {
    format.rules.forEach((rule: any) => { rule.priority = priority++; });
  });''')
    text = replace(text, '''    for (let rowNumber = 2; rowNumber <= maxRows; rowNumber++) {
      applyDatatypeValidation(worksheet.getRow(rowNumber).getCell(colNumber), field);
    }''', '''    const firstCell = worksheet.getCell(2, colNumber);
    applyDatatypeValidation(firstCell, field);
    const validation = firstCell.dataValidation;
    if (validation.type) {
      delete (worksheet as any).dataValidations.model[firstCell.address];
      (worksheet as any).dataValidations.add(`${firstCell.address}:${toColumnLetter(colNumber)}${maxRows}`, validation);
    }
    if (firstCell.numFmt) worksheet.getColumn(colNumber).numFmt = firstCell.numFmt;''')
    return text

def options(text):
    marker = '  const codeMatch = options.find(\n'
    return replace(text, marker, '''  // La importación antigua usa "1 Recursos IES" y el catálogo actual
  // "1 - Recursos IES". Comparar toda la etiqueta, nunca solo su prefijo.
  const canonicalLabel = (value: string) => normalizeValidatorText(value).replace(/^([A-Z0-9]+)\\s+-\\s+/, '$1 ');
  const labelMatch = options.find(opt => canonicalLabel(opt.value) === canonicalLabel(text));
  if (labelMatch) return labelMatch.value;

''' + marker)

def tests(text):
    text = text.replace('assert.match(validation.formulae[0], /SEARCH\\(\\{\"0\",\"1\",\"2\",\"3\",\"4\",\"5\",\"6\",\"7\",\"8\",\"9\"\\}/);', 'assert.match(validation.formulae[0], /SUBSTITUTE/);\n    assert.doesNotMatch(validation.formulae[0], /[{}]/);')
    text = text.replace("assert.match(saved.getCell('I2').dataValidation.formulae[0], /SEARCH/);", "assert.match(saved.getCell('I2').dataValidation.formulae[0], /SUBSTITUTE/);")
    # Las comprobaciones de celdas sobre rangos se realizan después de abrir.
    text = replace(text, "assert.match(created.getCell('A4').dataValidation.formulae[0], /SUBSTITUTE/);", "assert.match(created.getCell('A2').worksheet.dataValidations.model['A2:A4'].formulae[0], /SUBSTITUTE/);")
    text += (stage / 'regression.cjs').read_text(encoding='utf-8')
    return text

changes = [('app/utils/excelFieldValidation.ts', rules), ('app/utils/templateUtils.ts', templates), ('app/utils/validatorOptions.ts', options), ('tests/templateValidations.test.cjs', tests)]
prepared = []
for name, transform in changes:
    path = front / name
    raw = path.read_bytes().decode('utf-8')
    newline = '\r\n' if '\r\n' in raw else '\n'
    prepared.append((path, transform(raw.replace('\r\n', '\n')).replace('\n', newline)))
for path, value in prepared:
    path.write_bytes(value.encode('utf-8'))
print('Corregidas fórmulas incompatibles, rangos duplicados y etiquetas de catálogos.')
