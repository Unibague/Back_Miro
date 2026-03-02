const fs = require("fs");
const path = require("path");
const { Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel } = require("docx");

const createTemplate = async () => {
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          // PORTADA
          new Paragraph({
            text: "UNIVERSIDAD DE IBAGUÉ",
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
          }),
          new Paragraph({
            text: "Sistema de Aseguramiento de la Calidad",
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
          }),
          new Paragraph({
            text: "{report_title}",
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
            spacing: { before: 800, after: 400 },
          }),
          new Paragraph({
            text: "Fecha: {generation_date}",
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
          }),
          new Paragraph({
            text: "Fuente Productores: {producer_source}",
            alignment: AlignmentType.CENTER,
          }),
          new Paragraph({
            text: "Fuente Responsables: {responsible_source}",
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
          }),
          
          // SALTO DE PÁGINA
          new Paragraph({ text: "", pageBreakBefore: true }),
          
          // TABLA DE CONTENIDO
          new Paragraph({
            text: "TABLA DE CONTENIDO",
            heading: HeadingLevel.HEADING_1,
            spacing: { after: 200 },
          }),
          new Paragraph({ text: "{#table_of_contents}" }),
          new Paragraph({ text: "{section} ............... Pág. {page}" }),
          new Paragraph({ text: "{/table_of_contents}" }),
          
          // SALTO DE PÁGINA
          new Paragraph({ text: "", pageBreakBefore: true }),
          
          // 1. OBJETIVO
          new Paragraph({
            text: "1. OBJETIVO DEL INFORME",
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 200 },
          }),
          new Paragraph({ text: "{objective}" }),
          
          // 2. VARIABLES
          new Paragraph({
            text: "2. VARIABLES A ANALIZAR",
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 400, after: 200 },
          }),
          new Paragraph({ text: "{variables}" }),
          
          // 3. METODOLOGÍA
          new Paragraph({
            text: "3. METODOLOGÍA A EMPLEAR",
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 400, after: 200 },
          }),
          new Paragraph({ text: "{methodology}" }),
          
          // SALTO DE PÁGINA
          new Paragraph({ text: "", pageBreakBefore: true }),
          
          // 4. ANÁLISIS
          new Paragraph({
            text: "4. PROCESAMIENTO Y ANÁLISIS",
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 200 },
          }),
          new Paragraph({ text: "{#analysis}" }),
          new Paragraph({
            text: "4.{number}. {dimension_name}",
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 100 },
          }),
          new Paragraph({ text: "{content}" }),
          new Paragraph({
            text: "4.{number}.1. Conclusiones del capítulo",
            heading: HeadingLevel.HEADING_3,
            spacing: { before: 200, after: 100 },
          }),
          new Paragraph({ text: "{conclusions}" }),
          new Paragraph({ text: "{/analysis}" }),
          
          // SALTO DE PÁGINA
          new Paragraph({ text: "", pageBreakBefore: true }),
          
          // 5. CONCLUSIONES
          new Paragraph({
            text: "5. CONCLUSIONES Y RECOMENDACIONES GENERALES",
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 200 },
          }),
          new Paragraph({ text: "{general_conclusions}" }),
          
          // EVALUACIÓN INTEGRAL
          new Paragraph({
            text: "EVALUACIÓN INTEGRAL",
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 400, after: 200 },
          }),
          new Paragraph({ text: "{integral_evaluation}" }),
          
          // ACCIONES DE MEJORA
          new Paragraph({
            text: "ACCIONES DE MEJORA",
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 400, after: 200 },
          }),
          new Paragraph({ text: "{#improvement_actions}" }),
          new Paragraph({ text: "{number}. {action}" }),
          new Paragraph({ text: "{/improvement_actions}" }),
          
          // SALTO DE PÁGINA
          new Paragraph({ text: "", pageBreakBefore: true }),
          
          // 6. REFERENCIAS
          new Paragraph({
            text: "6. REFERENCIAS BIBLIOGRÁFICAS",
            heading: HeadingLevel.HEADING_1,
            spacing: { before: 200, after: 200 },
          }),
          new Paragraph({ text: "{#references}" }),
          new Paragraph({ text: "[{number}] {reference}" }),
          new Paragraph({ text: "{/references}" }),
          
          // METADATOS
          new Paragraph({ text: "", pageBreakBefore: true }),
          new Paragraph({
            text: "METADATOS DEL DOCUMENTO",
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 200 },
          }),
          new Paragraph({ text: "Modelo IA: {ai_model}" }),
          new Paragraph({ text: "Nota: Este documento fue generado automáticamente. Revise y ajuste antes de publicar." }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  const outputPath = path.join(__dirname, "../templates/template-informe-ambito.docx");
  
  fs.writeFileSync(outputPath, buffer);
  console.log("✅ Template creado en:", outputPath);
};

createTemplate().catch(console.error);
