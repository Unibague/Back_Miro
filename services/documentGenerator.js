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
{"heading":"Objetivos","content":"Texto con lista de 3-4 objetivos"},
{"heading":"Desarrollo","content":"Texto de desarrollo (2-3 párrafos)"},
{"heading":"Análisis","content":"Texto de análisis (3-4 párrafos)"},
{"heading":"Conclusiones","content":"Texto con 3-4 conclusiones"},
{"heading":"Bibliografía","content":"Texto con 3-4 referencias APA"}
]}

IMPORTANTE: "content" debe ser SIEMPRE texto (string), NUNCA array.
Tema: ${prompt}
Genera las 6 secciones COMPLETAS.`,
        [],
        { maxTokens: 4000, temperature: 0.7 }
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
        
        // CRÍTICO: Validar y limpiar sections - convertir arrays a strings
        if (content.sections && Array.isArray(content.sections)) {
          content.sections = content.sections.map(section => {
            if (Array.isArray(section.content)) {
              // Convertir array a string con viñetas
              section.content = section.content.map((item, idx) => `${idx + 1}. ${item}`).join('\n');
            } else if (typeof section.content !== 'string') {
              section.content = String(section.content || '');
            }
            return section;
          });
        }
        
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
      
      console.log('[Word] Iniciando generación de Word...');
      
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
      
      console.log('[Word] Word generado exitosamente. Tamaño:', buffer.length, 'bytes');
      
      return { success: true, buffer, content, format: 'docx' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  
  async generateExcelFromPrompt(prompt) {
    try {
      // 1. IA genera datos tabulares con prompt MUY específico
      const aiResponse = await aiAssistant.chat(
        `Responde SOLO con JSON válido (sin texto adicional, sin markdown):
{"sheetName":"Datos","headers":["Columna1","Columna2","Columna3"],"rows":[["valor1","valor2","valor3"],["valor4","valor5","valor6"]]}

Genera una tabla Excel sobre: ${prompt}

Crea 3-5 columnas relevantes y 5-8 filas con datos reales relacionados al tema.
Responde SOLO con el JSON.`,
        [],
        { maxTokens: 2000, temperature: 0.6 }
      );
      
      if (!aiResponse.success) {
        return { success: false, error: 'IA no disponible' };
      }
      
      // 2. Parsear respuesta con limpieza agresiva
      let data;
      try {
        let jsonText = aiResponse.message.trim();
        
        console.log('[Excel] Respuesta IA completa:', jsonText.substring(0, 300));
        
        // Limpiar HTML entities MÚLTIPLES VECES
        for (let i = 0; i < 3; i++) {
          jsonText = jsonText.replace(/&quot;/g, '"');
          jsonText = jsonText.replace(/&amp;/g, '&');
          jsonText = jsonText.replace(/&#39;/g, "'");
          jsonText = jsonText.replace(/&lt;/g, '<');
          jsonText = jsonText.replace(/&gt;/g, '>');
        }
        
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
        if (!data.headers || !Array.isArray(data.headers)) {
          throw new Error('Invalid headers structure');
        }
        
        console.log('[Excel] Parseado exitoso:', data.sheetName, 'Headers:', data.headers?.length, 'Rows:', data.rows?.length);
      } catch (parseError) {
        console.error('[Excel] Error parsing JSON:', parseError.message);
        console.error('[Excel] Texto recibido:', aiResponse.message.substring(0, 500));
        
        // Fallback contextual basado en el prompt
        const isStudentData = prompt.toLowerCase().includes('estudiante') || prompt.toLowerCase().includes('alumno');
        const isFinancial = prompt.toLowerCase().includes('financ') || prompt.toLowerCase().includes('presupuesto');
        
        if (isStudentData) {
          data = {
            sheetName: 'Estudiantes',
            headers: ['Nombre', 'Código', 'Programa', 'Promedio'],
            rows: [
              ['Juan Pérez', '2020001', 'Ingeniería', '4.2'],
              ['María Gómez', '2020002', 'Administración', '4.5'],
              ['Carlos Ruiz', '2020003', 'Derecho', '3.8']
            ]
          };
        } else if (isFinancial) {
          data = {
            sheetName: 'Finanzas',
            headers: ['Concepto', 'Monto', 'Fecha', 'Estado'],
            rows: [
              ['Matrícula', '$2,500,000', '2024-01-15', 'Pagado'],
              ['Materiales', '$500,000', '2024-02-01', 'Pendiente'],
              ['Transporte', '$300,000', '2024-02-15', 'Pagado']
            ]
          };
        } else {
          data = {
            sheetName: 'Datos',
            headers: ['Descripción', 'Valor', 'Observaciones'],
            rows: [
              [`Dato sobre: ${prompt}`, 'Valor 1', 'Información generada'],
              ['Dato adicional', 'Valor 2', 'Ejemplo contextual'],
              ['Dato complementario', 'Valor 3', 'Referencia']
            ]
          };
        }
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
    {"heading": "Objetivos", "content": "Texto con lista de 3-4 objetivos"},
    {"heading": "Desarrollo", "content": "Texto de desarrollo (2-3 párrafos)"},
    {"heading": "Análisis", "content": "Texto de análisis (2-3 párrafos)"},
    {"heading": "Conclusiones", "content": "Texto con 3-4 conclusiones"},
    {"heading": "Bibliografía", "content": "Texto con 3-4 referencias en formato APA"}
  ]
}

IMPORTANTE: "content" debe ser SIEMPRE texto (string), NUNCA array.
Prompt del usuario: ${prompt}

Genera un informe COMPLETO con las 6 secciones. Mantén el contenido conciso pero profesional.
Responde SOLO con el JSON, nada más.`,
        [],
        { maxTokens: 4000, temperature: 0.7 }
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
        
        // CRÍTICO: Validar y limpiar sections - convertir arrays a strings
        if (content.sections && Array.isArray(content.sections)) {
          content.sections = content.sections.map(section => {
            if (Array.isArray(section.content)) {
              // Convertir array a string con viñetas
              section.content = section.content.map((item, idx) => `${idx + 1}. ${item}`).join('\n');
            } else if (typeof section.content !== 'string') {
              section.content = String(section.content || '');
            }
            return section;
          });
        }
        
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
      
      console.log('[PDF] Iniciando generación de PDF...');
      
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
      
      // Validar que el PDF comience con %PDF
      const pdfHeader = buffer.slice(0, 4).toString('ascii');
      console.log('[PDF] Header del PDF:', pdfHeader);
      
      if (!pdfHeader.startsWith('%PDF')) {
        console.error('[PDF] ERROR: PDF inválido, no comienza con %PDF');
        throw new Error('PDF generado es inválido');
      }
      
      console.log('[PDF] PDF generado exitosamente. Tamaño:', buffer.length, 'bytes');
      
      return { success: true, buffer, content, format: 'pdf' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = new DocumentGeneratorService();
