const ExcelJS = require("exceljs");

const MAX_SHEET_NAME = 31;

const sanitizeSheetName = (name, fallback) => {
  const safe = String(name || fallback || "Sheet")
    .replace(/[\\/*?:[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return (safe || fallback || "Sheet").slice(0, MAX_SHEET_NAME);
};

const uniqueSheetName = (workbook, preferred, fallback) => {
  let base = sanitizeSheetName(preferred, fallback);
  let candidate = base;
  let i = 1;

  while (workbook.getWorksheet(candidate)) {
    const suffix = `_${i}`;
    candidate = `${base.slice(0, MAX_SHEET_NAME - suffix.length)}${suffix}`;
    i += 1;
  }

  return candidate;
};

const copyWorksheetValues = (sourceWs, targetWs) => {
  if (!sourceWs || !targetWs) return;

  sourceWs.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const targetRow = targetWs.getRow(rowNumber);

    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const targetCell = targetRow.getCell(colNumber);
      targetCell.value = cell.value;

      if (cell.numFmt) targetCell.numFmt = cell.numFmt;
      if (cell.font) targetCell.font = { ...cell.font };
      if (cell.alignment) targetCell.alignment = { ...cell.alignment };
      if (cell.fill) targetCell.fill = { ...cell.fill };
      if (cell.border) targetCell.border = { ...cell.border };
    });

    targetRow.height = row.height;
  });

  sourceWs.columns?.forEach((col, idx) => {
    const targetCol = targetWs.getColumn(idx + 1);
    if (col.width) targetCol.width = col.width;
  });
};

const tryLoadWorkbook = async (buffer) => {
  if (!buffer) return null;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
};

const writeKv = (ws, row, key, value) => {
  ws.getCell(`A${row}`).value = key;
  ws.getCell(`A${row}`).font = { bold: true };
  ws.getCell(`B${row}`).value = value ?? "";
};

const writeJsonArraySection = (ws, startRow, title, list) => {
  ws.getCell(`A${startRow}`).value = title;
  ws.getCell(`A${startRow}`).font = { bold: true };

  if (!Array.isArray(list) || list.length === 0) {
    ws.getCell(`A${startRow + 1}`).value = "Sin datos";
    return startRow + 2;
  }

  let row = startRow + 1;
  list.forEach((item, idx) => {
    ws.getCell(`A${row}`).value = `${idx + 1}.`;
    ws.getCell(`B${row}`).value = typeof item === "string" ? item : JSON.stringify(item);
    row += 1;
  });
  return row;
};

const buildTemplateSheetFromMergePlan = (workbook, mergePlan) => {
  const ws = workbook.addWorksheet(uniqueSheetName(workbook, "Plantilla_Ambito_IA", "PlantillaIA"));

  ws.columns = [
    { header: "Seccion", key: "section", width: 28 },
    { header: "Campo sugerido", key: "field", width: 36 },
    { header: "Fuente", key: "source", width: 18 },
    { header: "Notas", key: "notes", width: 52 },
  ];

  ws.getRow(1).font = { bold: true };

  const sections = Array.isArray(mergePlan?.sections) ? mergePlan.sections : [];
  const fieldGroups = Array.isArray(mergePlan?.field_groups) ? mergePlan.field_groups : [];

  let row = 2;

  if (sections.length === 0 && fieldGroups.length === 0) {
    ws.getCell(`A${row}`).value = "General";
    ws.getCell(`B${row}`).value = "Campo sugerido por IA no disponible";
    ws.getCell(`C${row}`).value = "both";
    ws.getCell(`D${row}`).value = "Se generó sin plan estructurado";
    return ws;
  }

  for (const section of sections) {
    ws.getCell(`A${row}`).value = section.title || section.id || "Seccion";
    ws.getCell(`B${row}`).value = "";
    ws.getCell(`C${row}`).value = section.source || "both";
    ws.getCell(`D${row}`).value = section.purpose || section.notes || "";
    row += 1;
  }

  for (const group of fieldGroups) {
    const fields = Array.isArray(group.fields) && group.fields.length > 0 ? group.fields : [""];
    for (const field of fields) {
      ws.getCell(`A${row}`).value = group.group_name || "Grupo";
      ws.getCell(`B${row}`).value = field;
      ws.getCell(`C${row}`).value = group.source || "both";
      ws.getCell(`D${row}`).value = "";
      row += 1;
    }
  }

  return ws;
};

const addWorkbookSourceSheets = (targetWorkbook, sourceWorkbook, prefix) => {
  if (!sourceWorkbook) return 0;
  let count = 0;

  sourceWorkbook.worksheets.forEach((sourceWs, idx) => {
    const name = uniqueSheetName(
      targetWorkbook,
      `${prefix}_${idx + 1}_${sourceWs.name}`,
      `${prefix}_${idx + 1}`
    );
    const targetWs = targetWorkbook.addWorksheet(name);
    copyWorksheetValues(sourceWs, targetWs);
    count += 1;
  });

  return count;
};

const buildMergedAmbitWorkbook = async ({
  reportName,
  producerReport,
  responsibleReport,
  aiMergePlan,
  producerBuffer,
  responsibleBuffer,
}) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Miro - IA";
  workbook.created = new Date();

  const producerWb = await tryLoadWorkbook(producerBuffer).catch(() => null);
  const responsibleWb = await tryLoadWorkbook(responsibleBuffer).catch(() => null);

  const summaryWs = workbook.addWorksheet("Resumen_IA");
  summaryWs.columns = [
    { width: 28 },
    { width: 90 },
  ];

  let row = 1;
  writeKv(summaryWs, row++, "Informe de ambito", reportName);
  writeKv(summaryWs, row++, "Base productores", producerReport?.name || "");
  writeKv(summaryWs, row++, "Base responsables", responsibleReport?.name || "");
  writeKv(summaryWs, row++, "Generado", new Date().toISOString());
  row += 1;

  row = writeJsonArraySection(summaryWs, row, "Reglas de fusion", aiMergePlan?.merge_rules);
  row += 1;
  row = writeJsonArraySection(summaryWs, row, "Secciones sugeridas", aiMergePlan?.sections);
  row += 1;
  row = writeJsonArraySection(summaryWs, row, "Grupos de campos", aiMergePlan?.field_groups);
  row += 1;
  row = writeJsonArraySection(summaryWs, row, "Supuestos", aiMergePlan?.assumptions);

  buildTemplateSheetFromMergePlan(workbook, aiMergePlan);

  const copiedProducerSheets = addWorkbookSourceSheets(workbook, producerWb, "PROD");
  const copiedResponsibleSheets = addWorkbookSourceSheets(workbook, responsibleWb, "RESP");

  const buffer = await workbook.xlsx.writeBuffer();

  return {
    buffer: Buffer.from(buffer),
    stats: {
      copiedProducerSheets,
      copiedResponsibleSheets,
      aiSections: Array.isArray(aiMergePlan?.sections) ? aiMergePlan.sections.length : 0,
      aiFieldGroups: Array.isArray(aiMergePlan?.field_groups) ? aiMergePlan.field_groups.length : 0,
    },
  };
};

module.exports = {
  buildMergedAmbitWorkbook,
};
