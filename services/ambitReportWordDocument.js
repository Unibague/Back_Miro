const Docxtemplater = require("docxtemplater");
const PizZip = require("pizzip");
const DocxMerger = require("docx-merger");
const fs = require("fs");
const path = require("path");

const buildMergedAmbitWordDocument = async ({
  reportName,
  producerReport,
  responsibleReport,
  aiMergePlan,
  aiMetadata,
}) => {
  try {
    console.log('[DOCX Merge] Starting document generation...');
    
    // Rutas de los templates
    const producerTemplatePath = path.join(__dirname, "../templates/templateProduc.docx");
    const responsibleTemplatePath = path.join(__dirname, "../templates/InformeResponsable.docx");

    console.log('[DOCX Merge] Producer template:', producerTemplatePath);
    console.log('[DOCX Merge] Responsible template:', responsibleTemplatePath);
    console.log('[DOCX Merge] Producer exists:', fs.existsSync(producerTemplatePath));
    console.log('[DOCX Merge] Responsible exists:', fs.existsSync(responsibleTemplatePath));

    // Datos para llenar ambos templates
    const data = {
      report_title: reportName,
      generation_date: new Date().toLocaleDateString("es-CO"),
      producer_name: producerReport?.name || "",
      producer_description: producerReport?.description || "",
      responsible_name: responsibleReport?.name || "",
      responsible_description: responsibleReport?.description || "",
      // Datos de la IA
      objective: aiMergePlan?.sections?.objective || "",
      variables: aiMergePlan?.sections?.variables || "",
      methodology: aiMergePlan?.sections?.methodology || "",
      general_conclusions: aiMergePlan?.sections?.general_conclusions || "",
      integral_evaluation: aiMergePlan?.sections?.integral_evaluation || "",
    };

    console.log('[DOCX Merge] Data prepared:', Object.keys(data));

    // 1. Llenar template PRODUCTOR
    console.log('[DOCX Merge] Filling producer template...');
    const producerContent = fs.readFileSync(producerTemplatePath, "binary");
    const producerZip = new PizZip(producerContent);
    const producerDoc = new Docxtemplater(producerZip, { paragraphLoop: true, linebreaks: true });
    producerDoc.render(data);
    const producerBuffer = producerDoc.getZip().generate({ type: "nodebuffer" });
    console.log('[DOCX Merge] Producer template filled, buffer size:', producerBuffer.length);

    // 2. Llenar template RESPONSABLE
    console.log('[DOCX Merge] Filling responsible template...');
    const responsibleContent = fs.readFileSync(responsibleTemplatePath, "binary");
    const responsibleZip = new PizZip(responsibleContent);
    const responsibleDoc = new Docxtemplater(responsibleZip, { paragraphLoop: true, linebreaks: true });
    responsibleDoc.render(data);
    const responsibleBuffer = responsibleDoc.getZip().generate({ type: "nodebuffer" });
    console.log('[DOCX Merge] Responsible template filled, buffer size:', responsibleBuffer.length);

    // 3. FUSIONAR ambos documentos
    console.log('[DOCX Merge] Merging documents...');
    const merger = new DocxMerger({}, [producerBuffer, responsibleBuffer]);
    
    // docx-merger usa callbacks, no promesas
    const mergedBuffer = await new Promise((resolve, reject) => {
      merger.save('nodebuffer', (data) => {
        if (data) {
          resolve(data);
        } else {
          reject(new Error('Merge returned empty data'));
        }
      });
    });
    
    console.log('[DOCX Merge] Documents merged successfully, buffer size:', mergedBuffer.length);

    return {
      buffer: mergedBuffer,
      stats: {
        format: "docx",
        merged: true,
        usedAI: Boolean(aiMergePlan),
      },
    };
  } catch (error) {
    console.error("[DOCX Merge] Error:", error.message);
    console.error("[DOCX Merge] Stack:", error.stack);
    
    // Fallback: documento simple con info básica
    const fallbackText = `
INFORME DE ÁMBITO: ${reportName}

=== INFORME PRODUCTOR ===
${producerReport?.name || "N/A"}
${producerReport?.description || ""}

=== INFORME RESPONSABLE ===
${responsibleReport?.name || "N/A"}
${responsibleReport?.description || ""}

=== CONCLUSIONES IA ===
${aiMergePlan?.sections?.general_conclusions || "Sin conclusiones generadas"}
    `;

    return {
      buffer: Buffer.from(fallbackText, "utf8"),
      stats: {
        format: "txt",
        merged: false,
        fallback: true,
        error: error.message,
      },
    };
  }
};

module.exports = {
  buildMergedAmbitWordDocument,
};
