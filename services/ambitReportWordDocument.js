const Docxtemplater = require("docxtemplater");
const PizZip = require("pizzip");
const fs = require("fs");
const path = require("path");

const escapeRtf = (value) => {
  const str = String(value ?? "");
  let result = "";
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const code = str.charCodeAt(i);
    if (char === "\\") result += "\\\\";
    else if (char === "{") result += "\\{";
    else if (char === "}") result += "\\}";
    else if (char === "\n" || char === "\r") result += "\\par ";
    else if (code > 127) result += `\\u${code}?`;
    else result += char;
  }
  return result;
};

const sectionsToText = (sections) => {
  if (!sections || typeof sections !== "object") return "Sin contenido generado";
  const parts = [];
  if (sections.objective) parts.push(`\n\n1. OBJETIVO DEL INFORME\n\n${sections.objective}`);
  if (sections.variables) parts.push(`\n\n2. VARIABLES A ANALIZAR\n\n${sections.variables}`);
  if (sections.methodology) parts.push(`\n\n3. METODOLOGÍA A EMPLEAR\n\n${sections.methodology}`);
  if (Array.isArray(sections.analysis) && sections.analysis.length > 0) {
    parts.push(`\n\n4. PROCESAMIENTO Y ANÁLISIS\n`);
    sections.analysis.forEach((dim, i) => {
      parts.push(`\n4.${i + 1}. ${dim.dimension_name || "Dimensión"}\n`);
      if (dim.content) parts.push(`${dim.content}\n`);
      if (dim.conclusions) parts.push(`\n4.${i + 1}.1. Conclusiones del capítulo\n${dim.conclusions}`);
    });
  }
  if (sections.general_conclusions) parts.push(`\n\n5. CONCLUSIONES GENERALES\n\n${sections.general_conclusions}`);
  if (sections.integral_evaluation) parts.push(`\n\nEVALUACIÓN INTEGRAL\n\n${sections.integral_evaluation}`);
  if (Array.isArray(sections.improvement_actions) && sections.improvement_actions.length > 0) {
    parts.push(`\n\nACCIONES DE MEJORA:\n`);
    sections.improvement_actions.forEach((action, i) => parts.push(`${i + 1}. ${action}`));
  }
  if (Array.isArray(sections.references) && sections.references.length > 0) {
    parts.push(`\n\n6. REFERENCIAS BIBLIOGRÁFICAS\n`);
    sections.references.forEach((ref, i) => parts.push(`[${i + 1}] ${ref}`));
  }
  return parts.length > 0 ? parts.join("\n") : "Sin contenido generado";
};

const tableOfContentsToText = (toc) => {
  if (!Array.isArray(toc) || toc.length === 0) return "Sin tabla de contenido";
  return toc.map((item) => `${item.section || ""} ............... Pág. ${item.page || ""}`).join("\n");
};

const buildRtfDocument = ({ reportName, producerReport, responsibleReport, aiMergePlan, aiMetadata }) => {
  const bodyLines = [
    "{\\rtf1\\ansi\\ansicpg1252\\deff0\\deflang1034",
    "{\\fonttbl{\\f0\\fnil\\fcharset0 Arial;}}",
    "{\\*\\generator Miro System;}",
    "\\viewkind4\\uc1\\pard\\f0\\fs24",
    "\\qc\\b\\fs32 ",
    `${escapeRtf(aiMergePlan?.report_title || reportName)}\\par`,
    "\\b0\\fs24\\ql\\par\\par",
    "\\par\\page",
    "\\b\\fs28 TABLA DE CONTENIDO \\b0\\fs24\\par\\par",
    `${escapeRtf(tableOfContentsToText(aiMergePlan?.table_of_contents))}\\par`,
    "\\par\\page",
    `${escapeRtf(sectionsToText(aiMergePlan?.sections))}\\par`,
    "\\par\\par\\page",
    "\\b METADATOS DEL DOCUMENTO \\b0\\par",
    `Fecha de generación: ${escapeRtf(new Date().toISOString())}\\par`,
    aiMetadata?.model ? `Modelo IA: ${escapeRtf(aiMetadata.model)}\\par` : "",
    `Fuente productores: ${escapeRtf(producerReport?.name || "")}\\par`,
    `Fuente responsables: ${escapeRtf(responsibleReport?.name || "")}\\par`,
    "\\par",
    "\\i Nota: Este documento fue generado automáticamente. Revise y ajuste antes de publicar. \\i0\\par",
    "}",
  ].filter(Boolean);
  return Buffer.from(bodyLines.join("\n"), "utf8");
};

const buildResponsibleWordDocument = ({ reportName, responsibleReport, aiMergePlan }) => {
  const templatePath = path.join(__dirname, "../templates/InformeResponsable.docx");
  const content = fs.readFileSync(templatePath, "binary");
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render({
    report_title: aiMergePlan?.report_title || reportName,
    responsible_name: responsibleReport?.name || "",
    responsible_description: responsibleReport?.description || aiMergePlan?.sections?.objective || "[Sin descripción]",
  });
  return doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
};

const buildProducerWordDocument = ({ reportName, producerReport, aiMergePlan }) => {
  const templatePath = path.join(__dirname, "../templates/templateProduc.docx");
  const content = fs.readFileSync(templatePath, "binary");
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
  doc.render({
    report_title: aiMergePlan?.report_title || reportName,
    producer_name: producerReport?.name || "",
    producer_description: producerReport?.description || aiMergePlan?.sections?.methodology || "[Sin descripción]",
  });
  return doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
};

const buildMergedAmbitWordDocument = async ({
  reportName,
  producerReport,
  responsibleReport,
  aiMergePlan,
  aiMetadata,
}) => {
  try {
    const templatePath = path.join(__dirname, "../templates/template-informe-ambito-v2.docx");

    if (!fs.existsSync(templatePath)) {
      throw new Error("Template template-informe-ambito.docx not found");
    }

    const content = fs.readFileSync(templatePath, "binary");
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });

    const sections = aiMergePlan?.sections;

    const now = new Date();
    const data = {
      report_title: aiMergePlan?.report_title || reportName,
      generation_date: now.toLocaleDateString("es-CO"),
      generation_year: String(now.getFullYear()),
      producer_source: producerReport?.name || "",
      responsible_source: responsibleReport?.name || "",
      ai_model: aiMetadata?.model || "N/A",

      objective: sections?.objective || "[Contenido pendiente]",
      variables: sections?.variables || "[Contenido pendiente]",
      methodology: sections?.methodology || "[Contenido pendiente]",

      analysis_content: Array.isArray(sections?.analysis)
        ? sections.analysis.map((dim, i) =>
            `${i + 1}. ${dim.dimension_name || `Dimensión ${i + 1}`}\n${dim.content || ""}\nConclusiones: ${dim.conclusions || ""}`
          ).join("\n\n")
        : "[Contenido pendiente]",

      general_conclusions: sections?.general_conclusions || "[Contenido pendiente]",
      integral_evaluation: sections?.integral_evaluation || "[Contenido pendiente]",

      improvement_actions: Array.isArray(sections?.improvement_actions)
        ? sections.improvement_actions.map((a, i) => `${i + 1}. ${a}`).join("\n")
        : "[Contenido pendiente]",
    };

    doc.render(data);

    const buffer = doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });

    let responsibleBuffer = null;
    let producerBuffer = null;
    try { responsibleBuffer = buildResponsibleWordDocument({ reportName, responsibleReport, aiMergePlan }); } catch (e) { console.error('[AmbitWord] Error template responsable:', e.message); }
    try { producerBuffer = buildProducerWordDocument({ reportName, producerReport, aiMergePlan }); } catch (e) { console.error('[AmbitWord] Error template productor:', e.message); }

    console.log("[AmbitWord] Documento generado con plantilla. Tamaño:", buffer.length, "bytes");

    return {
      buffer,
      responsibleBuffer,
      producerBuffer,
      stats: { format: "docx", merged: true, usedTemplate: true, usedAiData: Boolean(aiMergePlan) },
    };
  } catch (error) {
    console.error("[AmbitWord] Error con plantilla:", error.message);

    const buffer = buildRtfDocument({ reportName, producerReport, responsibleReport, aiMergePlan, aiMetadata });
    return {
      buffer,
      stats: { format: "rtf", merged: false, fallback: true, error: error.message },
    };
  }
};

module.exports = {
  buildMergedAmbitWordDocument,
  buildResponsibleWordDocument,
  buildProducerWordDocument,
};
