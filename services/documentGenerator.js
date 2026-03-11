const Docxtemplater = require('docxtemplater');
const PizZip = require('pizzip');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const aiAssistant = require('./aiAssistant');
const PDFDocument = require('pdfkit');

class DocumentGeneratorService {
  
  async generateWordFromPrompt(prompt, templatePath = null) {
    try {
      // 1. IA genera contenido estructurado (optimizado para producción)
      const aiResponse = await aiAssistant.chat(
        `Responde SOLO con JSON válido (sin texto adicional):
{"title":"Título","sections":[
{"heading":"Introducción","content":"Texto normal introducción (2-3 párrafos)"},
{"heading":"Objetivos","content":"Lista de 3-4 objetivos"},
{"heading":"Desarrollo","content":"Texto de desarrollo (2-3 párrafos)"},
{"heading":"Análisis","content":"Texto de análisis (3-4 párrafos)"},
{"heading":"Conclusiones","content":"3-4 conclusiones"},
{"heading":"Bibliografía","content":"3-4 referencias APA"}
]}

Tema: ${prompt}
Genera las 6 secciones COMPLETAS.`,
        [],
        { maxTokens: 3500, temperature: 0.7 }
      );
      
      if (!aiResponse.success) {
        return { success: false, error: 'IA no disponible' };
      }
      
      // 2. Parsear respuesta IA con limpieza AGRESIVA
      let content;
      try {
        let jsonText = aiResponse.message.trim();
        
        console.log('[Word] Respuesta IA original:', jsonText.substring(0, 300));
        
        // Limpiar HTML entities PRIMERO Y MÚLTIPLES VECES
        for (let i = 0; i < 3; i++) {
          jsonText = jsonText.replace(/&quot;/g, '"');
          jsonText = jsonText.replace(/&amp;/g, '&');
          jsonText = jsonText.replace(/&#39;/g, "'");
          jsonText = jsonText.replace(/&lt;/g, '<');
          jsonText = jsonText.replace(/&gt;/g, '>');
        }
        
        // Remover markdown
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        
        // CRÍTICO: Escapar saltos de línea dentro de strings JSON
        jsonText = jsonText.replace(/"content"\s*:\s*"([^"]*)"/g, (match, content) => {
          const cleanContent = content
            .replace(/\n/g, ' ')
            .replace(/\r/g, '')
            .replace(/\t/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          return `"content":"${cleanContent}"`;
        });
        
        // Extraer primer objeto JSON completo
        const firstBrace = jsonText.indexOf('{');
        if (firstBrace > 0) {
          jsonText = jsonText.substring(firstBrace);
        }
        
        // Contar llaves para extraer JSON completo
        let braceCount = 0;
        let endIndex = -1;
        for (let i = 0; i < jsonText.length; i++) {
          if (jsonText[i] === '{') braceCount++;
          if (jsonText[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              endIndex = i + 1;
              break;
            }
          }
        }
        
        if (endIndex > 0) {
          jsonText = jsonText.substring(0, endIndex);
        }
        
        console.log('[Word] JSON limpio:', jsonText.substring(0, 300));
        
        content = JSON.parse(jsonText);
        
        console.log('[Word] Parseado exitoso:', content.title, 'Secciones:', content.sections?.length);
      } catch (parseError) {
        console.error('[Word] Error parsing JSON:', parseError.message);
        console.error('[Word] Texto recibido:', aiResponse.message.substring(0, 500));
        
        // Fallback: usar respuesta como texto plano limpio
        const cleanText = aiResponse.message
          .replace(/```json|```/g, '')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'")
          .replace(/\{[\s\S]*\}/g, '') // Remover JSON fallido
          .trim();
        
        content = {
          title: 'Documento Generado',
          sections: [{ 
            heading: 'Contenido', 
            content: cleanText || `Documento sobre: ${prompt}` 
          }]
        };
      }
      
      // 3. Generar Word con docx library
      const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
      
      const doc = new Document({
        sections: [{
          properties: {},
          children: [
            new Paragraph({
              text: content.title || 'Documento Generado',
              heading: HeadingLevel.HEADING_1,
            }),
            ...content.sections?.flatMap(section => [
              new Paragraph({
                text: section.heading || 'Sección',
                heading: HeadingLevel.HEADING_2,
              }),
              new Paragraph({
                children: [new TextRun(section.content || '')],
              }),
            ]) || []
          ],
        }],
      });
      
      const buffer = await Packer.toBuffer(doc);
      
      return { success: true, buffer, content, format: 'docx' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  async generateExcelFromPrompt(prompt) {
    try {
      // 1. IA genera datos tabulares con prompt MUY específico
      const aiResponse = await aiAssistant.chat(
        `Responde SOLO con este JSON exacto (sin texto adicional):
{"sheetName":"Datos","headers":["Col1","Col2","Col3"],"rows":[["a","b","c"],["d","e","f"]]}

Genera datos para: ${prompt}
Máximo 8 filas. Usa el formato exacto mostrado arriba.`,
        [],
        { maxTokens: 700, temperature: 0.3 }
      );
      
      if (!aiResponse.success) {
        return { success: false, error: 'IA no disponible' };
      }
      
      // 2. Parsear respuesta con limpieza agresiva
      let data;
      try {
        let jsonText = aiResponse.message.trim();
        
        console.log('[Excel] Respuesta IA completa:', jsonText.substring(0, 300));
        
        // Limpiar HTML entities PRIMERO
        jsonText = jsonText.replace(/&quot;/g, '"');
        jsonText = jsonText.replace(/&amp;/g, '&');
        jsonText = jsonText.replace(/&#39;/g, "'");
        jsonText = jsonText.replace(/&lt;/g, '<');
        jsonText = jsonText.replace(/&gt;/g, '>');
        
        // Remover markdown
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '').replace(/```$/g, '');
        
        // Extraer SOLO el primer objeto JSON completo
        const firstBrace = jsonText.indexOf('{');
        if (firstBrace > 0) {
          jsonText = jsonText.substring(firstBrace);
        }
        
        // Encontrar el cierre del primer objeto JSON
        let braceCount = 0;
        let endIndex = -1;
        for (let i = 0; i < jsonText.length; i++) {
          if (jsonText[i] === '{') braceCount++;
          if (jsonText[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              endIndex = i + 1;
              break;
            }
          }
        }
        
        if (endIndex > 0) {
          jsonText = jsonText.substring(0, endIndex);
        }
        
        console.log('[Excel] JSON limpio:', jsonText.substring(0, 300));
        
        data = JSON.parse(jsonText);
        
        // Validar estructura
        if (!data.rows || !Array.isArray(data.rows)) {
          throw new Error('Invalid rows structure');
        }
        
        console.log('[Excel] Parseado exitoso:', data.sheetName, 'Headers:', data.headers?.length, 'Rows:', data.rows?.length);
      } catch (parseError) {
        console.error('[Excel] Error parsing JSON:', parseError.message);
        console.error('[Excel] Texto recibido:', aiResponse.message.substring(0, 500));
        
        // Fallback
        data = {
          sheetName: 'Datos',
          headers: ['Columna 1', 'Columna 2', 'Columna 3'],
          rows: [
            ['Dato 1', 'Dato 2', 'Dato 3'],
            ['Dato 4', 'Dato 5', 'Dato 6']
          ]
        };
      }
      
      // 3. Crear Excel
      const ws = xlsx.utils.aoa_to_sheet([data.headers, ...data.rows]);
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, ws, data.sheetName || 'Hoja1');
      
      const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
      
      return { success: true, buffer, data, format: 'xlsx' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  async generateSimpleWord(content) {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
    
    const doc = new Document({
      sections: [{
        properties: {},
        children: [
          new Paragraph({
            text: content.title || 'Documento Generado',
            heading: HeadingLevel.HEADING_1,
          }),
          ...content.sections?.flatMap(section => [
            new Paragraph({
              text: section.heading || 'Sección',
              heading: HeadingLevel.HEADING_2,
            }),
            new Paragraph({
              children: [new TextRun(section.content || '')],
            }),
          ]) || []
        ],
      }],
    });
    
    const buffer = await Packer.toBuffer(doc);
    return {
      success: true,
      buffer,
      content,
      format: 'docx'
    };
  }

  async generatePDFFromPrompt(prompt) {
    try {
      // 1. IA genera contenido estructurado (optimizado para producción)
      const aiResponse = await aiAssistant.chat(
        `Genera SOLO un objeto JSON válido (sin texto adicional, sin markdown, sin explicaciones) con esta estructura exacta:
{
  "title": "Título del documento",
  "author": "Autor",
  "sections": [
    {"heading": "Introducción", "content": "Texto normal de introducción (2-3 párrafos)"},
    {"heading": "Objetivos", "content": "Lista de 3-4 objetivos"},
    {"heading": "Desarrollo", "content": "Texto de desarrollo (2-3 párrafos)"},
    {"heading": "Análisis", "content": "Texto de análisis (2-3 párrafos)"},
    {"heading": "Conclusiones", "content": "3-4 conclusiones"},
    {"heading": "Bibliografía", "content": "3-4 referencias en formato APA"}
  ]
}

Prompt del usuario: ${prompt}

Genera un informe COMPLETO con las 6 secciones. Mantén el contenido conciso pero profesional.
Responde SOLO con el JSON, nada más.`,
        [],
        { maxTokens: 3500, temperature: 0.7 }
      );
      
      if (!aiResponse.success) {
        return { success: false, error: 'IA no disponible' };
      }
      
      // 2. Parsear respuesta IA con limpieza AGRESIVA (igual que Word)
      let content;
      try {
        let jsonText = aiResponse.message.trim();
        
        console.log('[PDF] Respuesta IA original:', jsonText.substring(0, 300));
        
        // Limpiar HTML entities PRIMERO Y MÚLTIPLES VECES
        for (let i = 0; i < 3; i++) {
          jsonText = jsonText.replace(/&quot;/g, '"');
          jsonText = jsonText.replace(/&amp;/g, '&');
          jsonText = jsonText.replace(/&#39;/g, "'");
          jsonText = jsonText.replace(/&lt;/g, '<');
          jsonText = jsonText.replace(/&gt;/g, '>');
        }
        
        // Remover markdown
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        
        // CRÍTICO: Escapar saltos de línea dentro de strings JSON
        // Reemplazar \n literal por espacio dentro de valores de content
        jsonText = jsonText.replace(/"content"\s*:\s*"([^"]*)"/g, (match, content) => {
          const cleanContent = content
            .replace(/\n/g, ' ')  // Saltos de línea a espacios
            .replace(/\r/g, '')   // Remover retornos de carro
            .replace(/\t/g, ' ')  // Tabs a espacios
            .replace(/\s+/g, ' ') // Múltiples espacios a uno
            .trim();
          return `"content":"${cleanContent}"`;
        });
        
        // Extraer primer objeto JSON completo
        const firstBrace = jsonText.indexOf('{');
        if (firstBrace > 0) {
          jsonText = jsonText.substring(firstBrace);
        }
        
        // Contar llaves para extraer JSON completo
        let braceCount = 0;
        let endIndex = -1;
        for (let i = 0; i < jsonText.length; i++) {
          if (jsonText[i] === '{') braceCount++;
          if (jsonText[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              endIndex = i + 1;
              break;
            }
          }
        }
        
        if (endIndex > 0) {
          jsonText = jsonText.substring(0, endIndex);
        }
        
        console.log('[PDF] JSON limpio:', jsonText.substring(0, 300));
        
        content = JSON.parse(jsonText);
        
        console.log('[PDF] Parseado exitoso:', content.title, 'Secciones:', content.sections?.length);
      } catch (parseError) {
        console.error('[PDF] Error parsing JSON:', parseError.message);
        console.error('[PDF] Texto recibido:', aiResponse.message.substring(0, 500));
        
        // Fallback: usar respuesta como texto plano limpio
        const cleanText = aiResponse.message
          .replace(/```json|```/g, '')
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'")
          .replace(/\{[\s\S]*\}/g, '') // Remover JSON fallido
          .trim();
        
        content = {
          title: 'Documento Generado',
          author: 'Sistema MIRÓ',
          sections: [{ 
            heading: 'Contenido', 
            content: cleanText || `Documento sobre: ${prompt}` 
          }]
        };
      }
      
      // 3. Crear PDF
      const doc = new PDFDocument({ margin: 50 });
      const chunks = [];
      
      doc.on('data', chunk => chunks.push(chunk));
      
      const pdfPromise = new Promise((resolve, reject) => {
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
      });
      
      // Título
      doc.fontSize(24).font('Helvetica-Bold').text(content.title || 'Documento', { align: 'center' });
      doc.moveDown();
      
      // Autor y fecha
      if (content.author) {
        doc.fontSize(12).font('Helvetica').text(`Autor: ${content.author}`);
      }
      doc.fontSize(10).text(`Fecha: ${new Date().toLocaleDateString('es-CO')}`, { align: 'right' });
      doc.moveDown(2);
      
      // Secciones
      if (content.sections && Array.isArray(content.sections)) {
        content.sections.forEach(section => {
          doc.fontSize(16).font('Helvetica-Bold').text(section.heading || 'Sección');
          doc.moveDown(0.5);
          doc.fontSize(12).font('Helvetica').text(section.content || '', { align: 'justify' });
          doc.moveDown(1.5);
        });
      }
      
      // Pie de página
      doc.fontSize(8).text('Generado por Sistema MIRÓ - Universidad de Ibagué', 50, doc.page.height - 50, { align: 'center' });
      
      doc.end();
      
      const buffer = await pdfPromise;
      
      return { success: true, buffer, content, format: 'pdf' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = new DocumentGeneratorService();
