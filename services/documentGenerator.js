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
      // 1. IA genera contenido estructurado
      const aiResponse = await aiAssistant.chat(
        `Genera contenido para documento Word en formato JSON con: title, sections (array con heading y content). Prompt: ${prompt}`,
        []
      );
      
      if (!aiResponse.success) {
        return { success: false, error: 'IA no disponible' };
      }
      
      // 2. Parsear respuesta IA
      let content;
      try {
        content = JSON.parse(aiResponse.message);
      } catch {
        content = {
          title: 'Documento Generado',
          sections: [{ heading: 'Contenido', content: aiResponse.message }]
        };
      }
      
      // 3. Generar Word
      const templateFile = templatePath || path.join(__dirname, '../templates/template-simple.docx');
      
      if (!fs.existsSync(templateFile)) {
        return this.generateSimpleWord(content);
      }
      
      const templateContent = fs.readFileSync(templateFile, 'binary');
      const zip = new PizZip(templateContent);
      const doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
      
      doc.render(content);
      
      const buffer = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
      
      return { success: true, buffer, content, format: 'docx' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  async generateExcelFromPrompt(prompt) {
    try {
      // 1. IA genera datos tabulares con prompt simplificado
      const aiResponse = await aiAssistant.chat(
        `Genera JSON: {"sheetName":"nombre","headers":["col1","col2"],"rows":[["dato1","dato2"]]}. Tema: ${prompt}. Solo JSON.`,
        []
      );
      
      if (!aiResponse.success) {
        return { success: false, error: 'IA no disponible' };
      }
      
      // 2. Parsear respuesta con limpieza
      let data;
      try {
        let jsonText = aiResponse.message.trim();
        
        console.log('[Excel] Respuesta IA:', jsonText.substring(0, 200));
        
        // Remover TODO el texto antes del primer {
        const firstBrace = jsonText.indexOf('{');
        if (firstBrace > 0) {
          jsonText = jsonText.substring(firstBrace);
        }
        
        // Remover markdown
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        jsonText = jsonText.replace(/&quot;/g, '"');
        
        // Extraer JSON completo
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/s);
        if (jsonMatch) {
          jsonText = jsonMatch[0];
        }
        
        console.log('[Excel] JSON extraído:', jsonText.substring(0, 200));
        
        data = JSON.parse(jsonText);
        
        console.log('[Excel] Parseado exitoso:', data.sheetName, data.headers);
      } catch (parseError) {
        console.error('[Excel] Error parsing JSON:', parseError.message);
        console.error('[Excel] Texto recibido:', aiResponse.message);
        
        // Fallback
        data = {
          sheetName: 'Datos',
          headers: ['Columna 1', 'Columna 2'],
          rows: [['Dato 1', 'Dato 2']]
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
  
  generateSimpleWord(content) {
    // Fallback: generar Word simple sin template
    const doc = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${content.title || 'Documento'}</w:t></w:r></w:p>
    ${content.sections?.map(s => `
      <w:p><w:r><w:t>${s.heading}</w:t></w:r></w:p>
      <w:p><w:r><w:t>${s.content}</w:t></w:r></w:p>
    `).join('') || ''}
  </w:body>
</w:document>`;
    
    return { success: true, buffer: Buffer.from(doc), content, format: 'docx' };
  }

  async generatePDFFromPrompt(prompt) {
    try {
      // 1. IA genera contenido estructurado
      const aiResponse = await aiAssistant.chat(
        `Genera SOLO un objeto JSON válido (sin texto adicional, sin markdown, sin explicaciones) con esta estructura exacta:
{
  "title": "Título del documento",
  "author": "Autor",
  "sections": [
    {"heading": "Introducción", "content": "Texto de introducción"},
    {"heading": "Desarrollo", "content": "Texto de desarrollo"},
    {"heading": "Conclusiones", "content": "Texto de conclusiones"}
  ]
}

Prompt del usuario: ${prompt}

Responde SOLO con el JSON, nada más.`,
        []
      );
      
      if (!aiResponse.success) {
        return { success: false, error: 'IA no disponible' };
      }
      
      // 2. Parsear respuesta IA (limpiar markdown y extraer JSON)
      let content;
      try {
        let jsonText = aiResponse.message.trim();
        
        console.log('[PDF] Respuesta IA:', jsonText.substring(0, 200));
        
        // Eliminar texto antes del primer {
        const firstBrace = jsonText.indexOf('{');
        if (firstBrace > 0) {
          jsonText = jsonText.substring(firstBrace);
        }
        
        // Remover markdown
        jsonText = jsonText.replace(/```json\n?/g, '').replace(/```\n?/g, '');
        jsonText = jsonText.replace(/&quot;/g, '"');
        
        // Extraer JSON completo
        const jsonMatch = jsonText.match(/\{[\s\S]*\}/s);
        if (jsonMatch) {
          jsonText = jsonMatch[0];
        }
        
        console.log('[PDF] JSON extraído:', jsonText.substring(0, 200));
        
        content = JSON.parse(jsonText);
        
        console.log('[PDF] Parseado exitoso:', content.title);
      } catch (parseError) {
        console.error('[PDF] Error parsing JSON:', parseError.message);
        console.error('[PDF] Texto recibido:', aiResponse.message);
        
        // Fallback: usar respuesta como texto plano
        content = {
          title: 'Documento Generado',
          author: 'Sistema MIRÓ',
          sections: [{ 
            heading: 'Contenido', 
            content: aiResponse.message.replace(/```json|```|&quot;/g, '').trim()
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
