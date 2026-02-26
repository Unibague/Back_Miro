const escapeRtf = (value) =>
  String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/{/g, "\\{")
    .replace(/}/g, "\\}")
    .replace(/\r\n|\r|\n/g, "\\par ");

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
  if (!Array.isArray(sections) || sections.length === 0) return "Sin secciones sugeridas";
  return sections
    .map((s, i) => {
      const title = s?.title || s?.id || `Seccion ${i + 1}`;
      const source = s?.source || "both";
      const purpose = s?.purpose || "";
      const notes = s?.notes || "";
      return `${i + 1}. ${title}\nFuente: ${source}\nObjetivo: ${purpose}\nNotas: ${notes}`;
    })
    .join("\n\n");
};

const fieldGroupsToText = (groups) => {
  if (!Array.isArray(groups) || groups.length === 0) return "Sin grupos de campos sugeridos";
  return groups
    .map((g, i) => {
      const name = g?.group_name || `Grupo ${i + 1}`;
      const source = g?.source || "both";
      const fields = Array.isArray(g?.fields) ? g.fields.join(", ") : "";
      return `${i + 1}. ${name}\nFuente: ${source}\nCampos: ${fields || "Sin campos listados"}`;
    })
    .join("\n\n");
};

const buildRtfDocument = ({
  reportName,
  producerReport,
  responsibleReport,
  aiMergePlan,
  aiMetadata,
}) => {
  const bodyLines = [
    "{\\rtf1\\ansi\\deff0",
    "{\\fonttbl{\\f0 Arial;}}",
    "\\fs24",
    `\\b ${escapeRtf(reportName)} \\b0\\par`,
    "\\par",
    "\\b Informe de ambito generado con IA \\b0\\par",
    `Fecha de generacion: ${escapeRtf(new Date().toISOString())}\\par`,
    aiMetadata?.model ? `Modelo IA: ${escapeRtf(aiMetadata.model)}\\par` : "",
    "\\par",
    "\\b Fuentes usadas \\b0\\par",
    `Productores: ${escapeRtf(producerReport?.name || "")}\\par`,
    `Responsables: ${escapeRtf(responsibleReport?.name || "")}\\par`,
    "\\par",
    "\\b Descripcion propuesta \\b0\\par",
    `${escapeRtf(aiMergePlan?.description || "Sin descripcion generada por IA")}\\par`,
    "\\par",
    "\\b Secciones sugeridas por IA \\b0\\par",
    `${escapeRtf(sectionsToText(aiMergePlan?.sections))}\\par`,
    "\\par",
    "\\b Grupos de campos sugeridos \\b0\\par",
    `${escapeRtf(fieldGroupsToText(aiMergePlan?.field_groups))}\\par`,
    "\\par",
    "\\b Reglas de fusion \\b0\\par",
    `${escapeRtf(textFromArray(aiMergePlan?.merge_rules))}\\par`,
    "\\par",
    "\\b Supuestos \\b0\\par",
    `${escapeRtf(textFromArray(aiMergePlan?.assumptions))}\\par`,
    "\\par",
    "\\b Nota tecnica \\b0\\par",
    escapeRtf(
      "Este documento es una propuesta inicial generada por IA para unificar informes de productores y responsables. Revise y ajuste el formato final antes de publicarlo."
    ) + "\\par",
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
  const buffer = buildRtfDocument({
    reportName,
    producerReport,
    responsibleReport,
    aiMergePlan,
    aiMetadata,
  });

  return {
    buffer,
    stats: {
      aiSections: Array.isArray(aiMergePlan?.sections) ? aiMergePlan.sections.length : 0,
      aiFieldGroups: Array.isArray(aiMergePlan?.field_groups) ? aiMergePlan.field_groups.length : 0,
      format: "rtf",
    },
  };
};

module.exports = {
  buildMergedAmbitWordDocument,
};
