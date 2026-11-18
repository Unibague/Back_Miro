const path = require("path");
const PizZip = require("pizzip");

// ExcelJS, al volver a guardar una plantilla, deja dos cosas que Excel tiene
// que "reparar" al abrir el archivo:
//  1. En los dibujos (logos) escribe <xdr:oneCellAnchor editAs="oneCell">,
//     pero editAs solo es válido en twoCellAnchor.
//  2. Descarta los vínculos a libros externos (xl/externalLinks): los nombres
//     definidos que los usan ([1]Lista!$A$1…) quedan apuntando a nada.
// Aquí se corrige el archivo generado tomando lo que falta de la plantilla.

const EXTERNAL_LINK_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/externalLink";
const EXTERNAL_LINK_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.externalLink+xml";

const relationships = (xml) =>
  [...xml.matchAll(/<Relationship\b[^>]*\/?>/g)].map((match) => ({
    xml: match[0],
    id: /\bId="([^"]*)"/.exec(match[0])?.[1],
    type: /\bType="([^"]*)"/.exec(match[0])?.[1],
    target: /\bTarget="([^"]*)"/.exec(match[0])?.[1],
  }));

const fixDrawings = (zip) => {
  zip.file(/^xl\/drawings\/drawing\d+\.xml$/).forEach((file) => {
    const xml = file.asText();
    const fixed = xml.replace(/<xdr:oneCellAnchor\s+editAs="[^"]*"/g, "<xdr:oneCellAnchor");
    if (fixed !== xml) zip.file(file.name, fixed);
  });
};

const restoreExternalLinks = (original, zip) => {
  const originalWorkbook = original.file("xl/workbook.xml")?.asText() || "";
  const originalRels = relationships(original.file("xl/_rels/workbook.xml.rels")?.asText() || "");
  // Orden de <externalReference>: define los índices [1], [2]… de las fórmulas
  const references = [...originalWorkbook.matchAll(/<externalReference\b[^>]*r:id="([^"]*)"[^>]*\/>/g)]
    .map((match) => originalRels.find((rel) => rel.id === match[1] && rel.type === EXTERNAL_LINK_TYPE))
    .filter(Boolean);
  let workbook = zip.file("xl/workbook.xml").asText();
  if (!references.length || /<externalReferences\b/.test(workbook)) return;

  // Partes del vínculo (y sus relaciones) tal cual estaban en la plantilla
  original.file(/^xl\/externalLinks\//).forEach((file) => zip.file(file.name, file.asUint8Array()));

  let relsXml = zip.file("xl/_rels/workbook.xml.rels").asText();
  const usedIds = new Set(relationships(relsXml).map((rel) => rel.id));
  let next = 1;
  const newIds = references.map((reference) => {
    while (usedIds.has(`rId${next}`)) next += 1;
    const id = `rId${next}`;
    usedIds.add(id);
    relsXml = relsXml.replace(
      "</Relationships>",
      `<Relationship Id="${id}" Type="${EXTERNAL_LINK_TYPE}" Target="${reference.target}"/></Relationships>`
    );
    return id;
  });
  zip.file("xl/_rels/workbook.xml.rels", relsXml);

  const block = `<externalReferences>${newIds.map((id) => `<externalReference r:id="${id}"/>`).join("")}</externalReferences>`;
  if (!/xmlns:r="/.test(workbook.slice(0, workbook.indexOf(">", workbook.indexOf("<workbook"))))) {
    workbook = workbook.replace(/<workbook\b/, '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
  }
  // Va justo después de <sheets> (y de <functionGroups>, si existe)
  workbook = /<\/functionGroups>/.test(workbook)
    ? workbook.replace("</functionGroups>", `</functionGroups>${block}`)
    : workbook.replace("</sheets>", `</sheets>${block}`);
  zip.file("xl/workbook.xml", workbook);

  let types = zip.file("[Content_Types].xml").asText();
  references.forEach((reference) => {
    const partName = `/${path.posix.join("xl", reference.target.replace(/^\/?xl\//, ""))}`;
    if (!types.includes(`PartName="${partName}"`)) {
      types = types.replace("</Types>", `<Override PartName="${partName}" ContentType="${EXTERNAL_LINK_CONTENT_TYPE}"/></Types>`);
    }
  });
  zip.file("[Content_Types].xml", types);
};

// Nombres definidos exactamente como en la plantilla (ExcelJS cambia su forma)
const restoreDefinedNames = (original, zip) => {
  const originalBlock = /<definedNames>[\s\S]*?<\/definedNames>/.exec(original.file("xl/workbook.xml")?.asText() || "")?.[0];
  if (!originalBlock) return;
  const sheetNames = (xml) => [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((match) => match[1]).join("|");
  let workbook = zip.file("xl/workbook.xml").asText();
  // Solo si las hojas siguen iguales (los nombres locales usan su posición)
  if (sheetNames(original.file("xl/workbook.xml").asText()) !== sheetNames(workbook)) return;
  workbook = /<definedNames>[\s\S]*?<\/definedNames>/.test(workbook)
    ? workbook.replace(/<definedNames>[\s\S]*?<\/definedNames>/, originalBlock)
    : workbook.replace(/(<\/externalReferences>|<\/sheets>)/, `$1${originalBlock}`);
  zip.file("xl/workbook.xml", workbook);
};

const repairExcelJsOutput = (templateBuffer, outputBuffer) => {
  const original = new PizZip(templateBuffer);
  const zip = new PizZip(outputBuffer);
  fixDrawings(zip);
  restoreExternalLinks(original, zip);
  restoreDefinedNames(original, zip);
  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" });
};

module.exports = { repairExcelJsOutput };
