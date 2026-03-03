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

const textFromArray = (list) => {
  if (!Array.isArray(list) || list.length === 0) return "Sin datos";
  return list
    .map((item, index) => {
      if (typeof item === "string") return `${index + 1}. ${item}`;
      return `${index + 1}. ${JSON.stringify(item)}`;
    })
    .join("\n");
};

const sectionsToText = (sections) => {
  if (!sections || typeof sections !== 'object') return "Sin contenido generado";
  
  const parts = [];
  
  if (sections.objective) {
    parts.push(`\n\n1. OBJETIVO DEL INFORME\n\n${sections.objective}`);
  }
  
  if (sections.variables) {
    parts.push(`\n\n2. VARIABLES A ANALIZAR\n\n${sections.variables}`);
  }
  
  if (sections.methodology) {
    parts.push(`\n\n3. METODOLOGÍA A EMPLEAR\n\n${sections.methodology}`);
  }
  
  if (Array.isArray(sections.analysis) && sections.analysis.length > 0) {
    parts.push(`\n\n4. PROCESAMIENTO Y ANÁLISIS\n`);
    sections.analysis.forEach((dim, i) => {
      parts.push(`\n4.${i + 1}. ${dim.dimension_name || 'Dimensión'}\n`);
      if (dim.content) parts.push(`${dim.content}\n`);
      if (dim.conclusions) parts.push(`\n4.${i + 1}.1. Conclusiones del capítulo\n${dim.conclusions}`);
    });
  }
  
  if (sections.general_conclusions) {
    parts.push(`\n\n5. CONCLUSIONES Y RECOMENDACIONES GENERALES\n\n${sections.general_conclusions}`);
  }
  
  if (sections.integral_evaluation) {
    parts.push(`\n\nEVALUACIÓN INTEGRAL\n\n${sections.integral_evaluation}`);
  }
  
  if (Array.isArray(sections.improvement_actions) && sections.improvement_actions.length > 0) {
    parts.push(`\n\nACCIONES DE MEJORA:\n`);
    sections.improvement_actions.forEach((action, i) => {
      parts.push(`${i + 1}. ${action}`);
    });
  }
  
  if (Array.isArray(sections.references) && sections.references.length > 0) {
    parts.push(`\n\n6. REFERENCIAS BIBLIOGRÁFICAS\n`);
    sections.references.forEach((ref, i) => {
      parts.push(`[${i + 1}] ${ref}`);
    });
  } else {
    parts.push(`\n\n6. REFERENCIAS BIBLIOGRÁFICAS\n\n[Espacio para agregar referencias bibliográficas]`);
  }
  
  return parts.length > 0 ? parts.join('\n') : "Sin contenido generado";
};

const tableOfContentsToText = (toc) => {
  if (!Array.isArray(toc) || toc.length === 0) return "Sin tabla de contenido";
  return toc
    .map((item) => `${item.section || ''} ............... Pág. ${item.page || ''}`)  
    .join('\n');
};

const buildDocxDocument = ({
  reportName,
  producerReport,
  responsibleReport,
  aiMergePlan,
  aiMetadata,
}) => {
  const templatePath = path.join(__dirname, "../templates/templateAmbito.docx");
  
  if (!fs.existsSync(templatePath)) {
    throw new Error("Template not found");
  }

  const content = fs.readFileSync(templatePath, "binary");
  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });

  const data = {
    report_title: aiMergePlan?.report_title || reportName,
    generation_date: new Date().toLocaleDateString("es-CO"),
    ai_model: aiMetadata?.model || "N/A",
    producer_source: producerReport?.name || "",
    responsible_source: responsibleReport?.name || "",
    
    table_of_contents: Array.isArray(aiMergePlan?.table_of_contents) 
      ? aiMergePlan.table_of_contents 
      : [],
    
    objective: aiMergePlan?.sections?.objective || "[Contenido pendiente]",
    variables: aiMergePlan?.sections?.variables || "[Contenido pendiente]",
    methodology: aiMergePlan?.sections?.methodology || "[Contenido pendiente]",
    
    analysis: Array.isArray(aiMergePlan?.sections?.analysis)
      ? aiMergePlan.sections.analysis.map((dim, i) => ({
          number: i + 1,
          dimension_name: dim.dimension_name || `Dimensión ${i + 1}`,
          content: dim.content || "[Contenido pendiente]",
          conclusions: dim.conclusions || "[Conclusiones pendientes]",
        }))
      : [],
    
    general_conclusions: aiMergePlan?.sections?.general_conclusions || "[Contenido pendiente]",
    integral_evaluation: aiMergePlan?.sections?.integral_evaluation || "[Contenido pendiente]",
    
    improvement_actions: Array.isArray(aiMergePlan?.sections?.improvement_actions)
      ? aiMergePlan.sections.improvement_actions.map((action, i) => ({
          number: i + 1,
          action: action,
        }))
      : [],
    
    references: Array.isArray(aiMergePlan?.sections?.references)
      ? aiMergePlan.sections.references.map((ref, i) => ({
          number: i + 1,
          reference: ref,
        }))
      : [{number: 1, reference: "[Espacio para agregar referencias bibliográficas]"}],
  };

  doc.render(data);

  return doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
};

const buildRtfDocument = ({
  reportName,
  producerReport,
  responsibleReport,
  aiMergePlan,
  aiMetadata,
}) => {
  const bodyLines = [
    "{\\rtf1\\ansi\\ansicpg1252\\deff0\\deflang1034",
    "{\\fonttbl{\\f0\\fnil\\fcharset0 Arial;}}",
    "{\\*\\generator Miro System;}",
    "\\viewkind4\\uc1\\pard\\f0\\fs24",
    "\\qc\\b\\fs32 ", // Centrado y tamaño grande para título
    `${escapeRtf(aiMergePlan?.report_title || reportName)}\\par`,
    "\\b0\\fs24\\ql\\par\\par", // Volver a normal y alineado izquierda
    "\\par\\page", // Salto de página
    "\\b\\fs28 TABLA DE CONTENIDO \\b0\\fs24\\par\\par",
    `${escapeRtf(tableOfContentsToText(aiMergePlan?.table_of_contents))}\\par`,
    "\\par\\page", // Salto de página
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

const buildMergedAmbitWordDocument = async ({
  reportName,
  producerReport,
  responsibleReport,
  aiMergePlan,
  aiMetadata,
}) => {
  try {
    const templatePath = path.join(__dirname, "../templates/informeResponsable.docx");
    
    if (!fs.existsSync(templatePath)) {
      throw new Error("Template not found");
    }

    const content = fs.readFileSync(templatePath, "binary");
    const zip = new PizZip(content);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
    });

    // Usar datos REALES de los informes, NO de la IA
    const data = {
      report_title: reportName,
      generation_date: new Date().toLocaleDateString("es-CO"),
      producer_name: producerReport?.name || "",
      producer_description: producerReport?.description || "",
      responsible_name: responsibleReport?.name || "",
      responsible_description: responsibleReport?.description || "",
      // Aquí puedes agregar más campos reales de los informes
    };

    doc.render(data);

    return {
      buffer: doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" }),
      stats: {
        format: "docx",
        merged: true,
        usedRealData: true
      },
    };
  } catch (error) {
    console.warn("[DOCX] Error:", error.message);
    
    // Fallback RTF
    const buffer = buildRtfDocument({
      reportName,
      producerReport,
      responsibleReport,
      aiMergePlan,
      aiMetadata,
    });

    return {
      buffer,
      stats: { format: "rtf" },
    };
  }
};

module.exports = {
  buildMergedAmbitWordDocument,
};
