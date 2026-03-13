const Docxtemplater = require('docxtemplater');
const PizZip = require('pizzip');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const aiAssistant = require('./aiAssistant');
const PDFDocument = require('pdfkit');

class DocumentGeneratorService {
  
  // Validar si el prompt menciona MIRÓ o Universidad de Ibagué
  isRelatedToMiro(prompt) {
    const lowerPrompt = prompt.toLowerCase();
    const miroKeywords = [
      'miró', 'miro',
      'universidad de ibagué', 'universidad de ibague', 'unibague', 'ibagué', 'ibague',
      'informe', 'reporte', 'plantilla', 'documento académico', 'documento academico',
      'dependencia', 'programa académico', 'programa academico'
    ];
    
    return miroKeywords.some(keyword => lowerPrompt.includes(keyword));
  }
  
  async generateWordFromPrompt(prompt, templatePath = null) {
    try {
      // Validar si el prompt está relacionado con MIRÓ
      if (!this.isRelatedToMiro(prompt)) {
        console.log('[Word] Prompt no relacionado con MIRÓ, rechazando generación');
        return { 
          success: false, 
          error: 'El contenido solicitado no está relacionado con el sistema MIRÓ. Por favor, solicita documentos relacionados con acreditación, informes académicos o la Universidad de Ibagué.' 
        };
      }
      
      // 1. IA genera contenido estructurado (optimizado para producción)
      const aiResponse = await aiAssistant.chat(
        `Responde SOLO con JSON válido (sin texto adicional):{"title":"Título","sections":[
        {"heading":"Introducción","content":"Texto normal introducción (3-4 párrafos)"},
        {"heading":"Objetivos","content":"Texto con lista de 4-5 objetivos"},
        {"heading":"Desarrollo","content":"Texto de desarrollo (3-4 párrafos)"},
        {"heading":"Análisis","content":"Texto de análisis (4-5 párrafos)"},
        {"heading":"Conclusiones","content":"Texto con 4-5 conclusiones"},
        {"heading":"Bibliografía","content":"Texto con 4-5 referencias APA"}
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
        
        // CRÍTICO: Limpiar HTML entities recursivamente
        let previousText = '';
        let iterations = 0;
        while (previousText !== jsonText && iterations < 10) {
          previousText = jsonText;
          jsonText = jsonText.replace(/&quot;/gi, '"');
          jsonText = jsonText.replace(/&amp;/gi, '&');
          jsonText = jsonText.replace(/&#39;/gi, "'");
          jsonText = jsonText.replace(/&#x27;/gi, "'");
          jsonText = jsonText.replace(/&lt;/gi, '<');
          jsonText = jsonText.replace(/&gt;/gi, '>');
          jsonText = jsonText.replace(/&apos;/gi, "'");
          iterations++;
        }
        console.log('[Word] Limpieza entities completada en', iterations, 'iteraciones');
        
        // Remover markdown
        jsonText = jsonText.replace(/```json\n?/gi, '').replace(/```\n?/gi, '');
        
        // Limpiar Unicode mal formado
        jsonText = jsonText.replace(/\\u([0-9a-fA-F]{0,3}(?![0-9a-fA-F]))/g, '');
        jsonText = jsonText.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
          return String.fromCharCode(parseInt(hex, 16));
        });
        
        // CRÍTICO: Convertir arrays en "content" a strings ANTES del parsing
        jsonText = jsonText.replace(/"content"\s*:\s*\[([^\]]+)\]/g, (match, arrayContent) => {
          // Extraer elementos del array y convertir a string numerado
          const items = arrayContent.match(/"([^"]+)"/g) || [];
          const numberedList = items.map((item, idx) => {
            const cleanItem = item.replace(/"/g, '');
            return `${idx + 1}. ${cleanItem}`;
          }).join('\\n');
          return `"content":"${numberedList}"`;
        });
        
        // NUEVO: Limpiar caracteres problemáticos dentro de strings
        jsonText = jsonText.replace(/"content"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/g, (match, content) => {
          const cleanContent = content
            .replace(/\\n/g, ' ')   // \n escapado a espacio
            .replace(/\n/g, ' ')     // \n literal a espacio
            .replace(/\\r/g, '')    // \r escapado
            .replace(/\r/g, '')      // \r literal
            .replace(/\\t/g, ' ')   // \t escapado a espacio
            .replace(/\t/g, ' ')     // \t literal a espacio
            .replace(/\s+/g, ' ')    // Múltiples espacios a uno
            .trim();
          return `"content":"${cleanContent}"`;
        });
        
        // Limpiar heading también
        jsonText = jsonText.replace(/"heading"\s*:\s*"([^"]*)"/g, (match, heading) => {
          const cleanHeading = heading.replace(/\s+/g, ' ').trim();
          return `"heading":"${cleanHeading}"`;
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
      // Detectar si el prompt menciona "plantilla" o "template"
      const mentionsTemplate = /plantilla|template|formulario/i.test(prompt);
      
      if (mentionsTemplate) {
        console.log('[Excel] Prompt menciona plantilla, intentando generar desde plantilla');
        
        // Intentar extraer nombre de plantilla del prompt
        const Template = require('../models/templates');
        const templates = await Template.find().select('name fields').lean();
        
        // Buscar plantilla que coincida con el prompt
        const matchedTemplate = templates.find(t => 
          prompt.toLowerCase().includes(t.name.toLowerCase())
        );
        
        if (matchedTemplate) {
          console.log('[Excel] Plantilla encontrada:', matchedTemplate.name);
          return this.generateExcelFromTemplate(matchedTemplate, 5);
        }
      }
      
      // 1. IA genera datos tabulares con prompt MUY específico
      const aiResponse = await aiAssistant.chat(
        `Responde SOLO con JSON válido (sin texto adicional, sin markdown):
          {"sheetName":"Datos","headers":["Columna1","Columna2","Columna3"],"rows":[["valor1","valor2","valor3"],["valor4","valor5","valor6"]]} 
          Genera una tabla Excel sobre: ${prompt}
          Crea 3-5 columnas relevantes y 5-8 filas con datos reales relacionados al tema.
          Responde SOLO con el JSON.`,
        [],
        { maxTokens: 4000, temperature: 0.7 }
      );
      
      if (!aiResponse.success) {
        return { success: false, error: 'IA no disponible' };
      }
      
      // 2. Parsear respuesta con limpieza agresiva
      let data;
      try {
        let jsonText = aiResponse.message.trim();
        
        console.log('[Excel] Respuesta IA completa:', jsonText.substring(0, 300));
        
        // Limpiar HTML entities recursivamente
        let previousText = '';
        let iterations = 0;
        while (previousText !== jsonText && iterations < 10) {
          previousText = jsonText;
          jsonText = jsonText.replace(/&quot;/gi, '"');
          jsonText = jsonText.replace(/&amp;/gi, '&');
          jsonText = jsonText.replace(/&#39;/gi, "'");
          jsonText = jsonText.replace(/&#x27;/gi, "'");
          jsonText = jsonText.replace(/&lt;/gi, '<');
          jsonText = jsonText.replace(/&gt;/gi, '>');
          jsonText = jsonText.replace(/&apos;/gi, "'");
          iterations++;
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
  
  async generateExcelFromTemplate(template, numRows = 5) {
    try {
      console.log('[Excel Template] Generando datos fake para:', template.name);
      
      const headers = [];
      const fakeDataGenerators = [];
      
      // Datos fake realistas
      const nombres = ['Juan Pérez', 'María González', 'Carlos Rodríguez', 'Ana Martínez', 'Luis Hernández', 'Laura Díaz', 'Pedro Sánchez', 'Sofía López', 'Diego Torres', 'Valentina Ramírez'];
      const programas = ['Ingeniería de Sistemas', 'Administración de Empresas', 'Derecho', 'Medicina', 'Psicología', 'Contaduría', 'Arquitectura', 'Biología'];
      const dependencias = ['Facultad de Ingeniería', 'Facultad de Ciencias Económicas', 'Facultad de Derecho', 'Facultad de Ciencias de la Salud', 'Vicerrectoría', 'Rectoría'];
      const estados = ['Activo', 'Inactivo', 'Pendiente', 'Aprobado', 'Rechazado', 'En Proceso'];
      const ciudades = ['Ibagué', 'Bogotá', 'Medellín', 'Cali', 'Barranquilla', 'Cartagena'];
      const tiposDocumento = ['CC - Cédula de ciudadanía', 'TI - Tarjeta de identidad', 'CE - Cédula de extranjería', 'PA - Pasaporte'];
      const modalidades = ['1 - Presencial', '2 - Virtual', '3 - Híbrido'];
      const nacionalidades = ['1 - Nacional', '2 - Extranjero'];
      
      // Procesar campos de la plantilla
      if (template.fields && Array.isArray(template.fields)) {
        template.fields.forEach(field => {
          const fieldName = (field.name || 'Campo').toLowerCase();
          const fieldType = (field.datatype || 'Texto Corto'); // Usar datatype en vez de type
          headers.push(field.name || 'Campo');
          
          console.log(`[Excel Template] Campo: ${field.name}, Tipo: ${fieldType}`);
          
          // Generar función para datos fake según datatype Y nombre del campo
          switch (fieldType) {
            case 'Entero':
              if (/cédula|cedula|documento|dni|identificación/i.test(fieldName)) {
                fakeDataGenerators.push(() => Math.floor(Math.random() * 90000000) + 10000000); // 10000000-99999999
              } else if (/edad|años/i.test(fieldName)) {
                fakeDataGenerators.push(() => Math.floor(Math.random() * 50) + 18); // 18-67
              } else if (/cantidad|total|número/i.test(fieldName)) {
                fakeDataGenerators.push(() => Math.floor(Math.random() * 100) + 1);
              } else {
                fakeDataGenerators.push(() => Math.floor(Math.random() * 1000));
              }
              break;
              
            case 'Decimal':
              if (/promedio|nota|calificación/i.test(fieldName)) {
                fakeDataGenerators.push(() => (Math.random() * 2 + 3).toFixed(1)); // 3.0 - 5.0
              } else if (/precio|costo|valor|monto|salario/i.test(fieldName)) {
                fakeDataGenerators.push(() => (Math.floor(Math.random() * 5000) + 500) * 1000); // 500000-5500000
              } else {
                fakeDataGenerators.push(() => (Math.random() * 100).toFixed(2));
              }
              break;
              
            case 'Porcentaje':
              fakeDataGenerators.push(() => `${Math.floor(Math.random() * 100)}%`);
              break;
              
            case 'True/False':
              fakeDataGenerators.push(() => Math.random() > 0.5 ? 'Sí' : 'No');
              break;
              
            case 'Fecha':
            case 'Fecha Inicial / Fecha Final':
              fakeDataGenerators.push(() => {
                const date = new Date();
                date.setDate(date.getDate() - Math.floor(Math.random() * 365));
                return date.toISOString().split('T')[0];
              });
              break;
              
            case 'Link':
              fakeDataGenerators.push(() => {
                const tipos = ['documento', 'informe', 'certificado', 'acta'];
                const tipo = tipos[Math.floor(Math.random() * tipos.length)];
                return `https://drive.google.com/${tipo}_${Math.floor(Math.random() * 1000)}`;
              });
              break;
              
            case 'Texto Corto':
              // Detectar tipo de dato por nombre del campo
              if (/tipo.*documento|documento.*tipo/i.test(fieldName)) {
                fakeDataGenerators.push(() => tiposDocumento[Math.floor(Math.random() * tiposDocumento.length)]);
              } else if (/modalidad/i.test(fieldName)) {
                fakeDataGenerators.push(() => modalidades[Math.floor(Math.random() * modalidades.length)]);
              } else if (/nacionalidad/i.test(fieldName)) {
                fakeDataGenerators.push(() => nacionalidades[Math.floor(Math.random() * nacionalidades.length)]);
              } else if (/nombre|name/i.test(fieldName)) {
                fakeDataGenerators.push(() => nombres[Math.floor(Math.random() * nombres.length)]);
              } else if (/programa|carrera/i.test(fieldName)) {
                fakeDataGenerators.push(() => programas[Math.floor(Math.random() * programas.length)]);
              } else if (/dependencia|unidad|área/i.test(fieldName)) {
                fakeDataGenerators.push(() => dependencias[Math.floor(Math.random() * dependencias.length)]);
              } else if (/ciudad|municipio/i.test(fieldName)) {
                fakeDataGenerators.push(() => ciudades[Math.floor(Math.random() * ciudades.length)]);
              } else if (/estado|status/i.test(fieldName)) {
                fakeDataGenerators.push(() => estados[Math.floor(Math.random() * estados.length)]);
              } else if (/código|codigo|id/i.test(fieldName)) {
                fakeDataGenerators.push(() => `${Math.floor(Math.random() * 9000) + 1000}`);
              } else {
                fakeDataGenerators.push(() => `Texto ${Math.floor(Math.random() * 100)}`);
              }
              break;
              
            case 'Texto Largo':
              if (/descripción|descripcion|observación|observacion/i.test(fieldName)) {
                fakeDataGenerators.push(() => {
                  const descripciones = [
                    'Cumple con los requisitos establecidos según normativa vigente',
                    'Requiere seguimiento adicional por parte del área responsable',
                    'Documentación completa y verificada correctamente',
                    'En proceso de revisión por el comité evaluador',
                    'Aprobado según los criterios de acreditación institucional'
                  ];
                  return descripciones[Math.floor(Math.random() * descripciones.length)];
                });
              } else if (/tipo.*documento|documento.*tipo/i.test(fieldName)) {
                fakeDataGenerators.push(() => tiposDocumento[Math.floor(Math.random() * tiposDocumento.length)]);
              } else if (/tipo.*entidad|entidad.*tipo/i.test(fieldName)) {
                const tiposEntidad = ['ONG', 'Fundación', 'Empresa Privada', 'Entidad Pública', 'Cooperativa', 'Asociación'];
                fakeDataGenerators.push(() => tiposEntidad[Math.floor(Math.random() * tiposEntidad.length)]);
              } else if (/nombre.*entidad|entidad.*nombre/i.test(fieldName)) {
                const entidades = ['Alcaldía Municipal', 'Gobernación del Tolima', 'Cámara de Comercio', 'Cruz Roja', 'Fundación Social', 'Empresa Regional'];
                fakeDataGenerators.push(() => entidades[Math.floor(Math.random() * entidades.length)]);
              } else if (/nombre.*proyecto|proyecto.*nombre/i.test(fieldName)) {
                const proyectos = ['Desarrollo Comunitario Rural', 'Educación para la Paz', 'Sostenibilidad Ambiental', 'Emprendimiento Social', 'Salud Preventiva'];
                fakeDataGenerators.push(() => proyectos[Math.floor(Math.random() * proyectos.length)]);
              } else if (/producto|resultado/i.test(fieldName)) {
                const productos = ['Informe técnico', 'Manual de procedimientos', 'Cartilla educativa', 'Video documental', 'Aplicación web'];
                fakeDataGenerators.push(() => productos[Math.floor(Math.random() * productos.length)]);
              } else if (/cod|código|codigo/i.test(fieldName)) {
                fakeDataGenerators.push(() => `COD-${Math.floor(Math.random() * 9000) + 1000}`);
              } else if (/nombre|name/i.test(fieldName)) {
                fakeDataGenerators.push(() => nombres[Math.floor(Math.random() * nombres.length)]);
              } else if (/programa|carrera/i.test(fieldName)) {
                fakeDataGenerators.push(() => programas[Math.floor(Math.random() * programas.length)]);
              } else if (/dependencia|unidad|área/i.test(fieldName)) {
                fakeDataGenerators.push(() => dependencias[Math.floor(Math.random() * dependencias.length)]);
              } else {
                fakeDataGenerators.push(() => `Información detallada sobre el registro número ${Math.floor(Math.random() * 100)}`);
              }
              break;
              
            case 'select':
            case 'radio':
            case 'dropdown':
              fakeDataGenerators.push(() => {
                const options = field.options || estados;
                return options[Math.floor(Math.random() * options.length)];
              });
              break;
              
            case 'email':
            case 'correo':
              fakeDataGenerators.push(() => {
                const usuario = nombres[Math.floor(Math.random() * nombres.length)]
                  .toLowerCase()
                  .replace(/\s+/g, '.')
                  .normalize('NFD')
                  .replace(/[\u0300-\u036f]/g, '');
                return `${usuario}@unibague.edu.co`;
              });
              break;
              
            case 'file':
            case 'archivo':
              fakeDataGenerators.push(() => {
                const tipos = ['documento', 'informe', 'certificado', 'acta', 'reporte'];
                const tipo = tipos[Math.floor(Math.random() * tipos.length)];
                return `${tipo}_${Math.floor(Math.random() * 100)}.pdf`;
              });
              break;
              
            default:
              fakeDataGenerators.push(() => `Dato ${Math.floor(Math.random() * 100)}`);
          }
        });
      }
      
      // Si no hay campos, usar headers genéricos
      if (headers.length === 0) {
        headers.push('Nombre', 'Programa', 'Estado');
        fakeDataGenerators.push(
          () => nombres[Math.floor(Math.random() * nombres.length)],
          () => programas[Math.floor(Math.random() * programas.length)],
          () => estados[Math.floor(Math.random() * estados.length)]
        );
      }
      
      // Generar filas con datos fake
      const rows = [];
      for (let i = 0; i < numRows; i++) {
        const row = fakeDataGenerators.map(generator => generator());
        rows.push(row);
      }
      
      // Crear Excel
      const ws = xlsx.utils.aoa_to_sheet([headers, ...rows]);
      const wb = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(wb, ws, 'Datos');
      
      const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
      
      return { 
        success: true, 
        buffer, 
        data: { sheetName: 'Datos', headers, rows },
        format: 'xlsx',
        source: 'template'
      };
    } catch (error) {
      console.error('[Excel Template] Error:', error);
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
      // Validar si el prompt está relacionado con MIRÓ
      if (!this.isRelatedToMiro(prompt)) {
        console.log('[PDF] Prompt no relacionado con MIRÓ, rechazando generación');
        return { 
          success: false, 
          error: 'El contenido solicitado no está relacionado con el sistema MIRÓ. Por favor, solicita documentos relacionados con acreditación, informes académicos o la Universidad de Ibagué.' 
        };
      }
      
      // 1. IA genera contenido estructurado (optimizado para producción)
      const aiResponse = await aiAssistant.chat(
        `Genera SOLO un objeto JSON válido (sin texto adicional, sin markdown, sin explicaciones) con esta estructura exacta:
{
  "title": "Título del documento",
  "author": "Autor",
  "sections": [
    {"heading": "Introducción", "content": "Texto normal de introducción (3-4 párrafos)"},
    {"heading": "Objetivos", "content": "Texto con lista de 4-5 objetivos"},
    {"heading": "Desarrollo", "content": "Texto de desarrollo (3-4 párrafos)"},
    {"heading": "Análisis", "content": "Texto de análisis (3-4 párrafos)"},
    {"heading": "Conclusiones", "content": "Texto con 4-5 conclusiones"},
    {"heading": "Bibliografía", "content": "Texto con 4-5 referencias en formato APA"}
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
        
        // CRÍTICO: Limpiar HTML entities recursivamente
        let previousText = '';
        let iterations = 0;
        while (previousText !== jsonText && iterations < 10) {
          previousText = jsonText;
          jsonText = jsonText.replace(/&quot;/gi, '"');
          jsonText = jsonText.replace(/&amp;/gi, '&');
          jsonText = jsonText.replace(/&#39;/gi, "'");
          jsonText = jsonText.replace(/&#x27;/gi, "'");
          jsonText = jsonText.replace(/&lt;/gi, '<');
          jsonText = jsonText.replace(/&gt;/gi, '>');
          jsonText = jsonText.replace(/&apos;/gi, "'");
          iterations++;
        }
        console.log('[PDF] Limpieza entities completada en', iterations, 'iteraciones');
        
        // Remover markdown
        jsonText = jsonText.replace(/```json\n?/gi, '').replace(/```\n?/gi, '');
        
        // Limpiar Unicode mal formado
        jsonText = jsonText.replace(/\\u([0-9a-fA-F]{0,3}(?![0-9a-fA-F]))/g, '');
        jsonText = jsonText.replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
          return String.fromCharCode(parseInt(hex, 16));
        });
        
        // CRÍTICO: Convertir arrays en "content" a strings ANTES del parsing
        jsonText = jsonText.replace(/"content"\s*:\s*\[([^\]]+)\]/g, (match, arrayContent) => {
          // Extraer elementos del array y convertir a string numerado
          const items = arrayContent.match(/"([^"]+)"/g) || [];
          const numberedList = items.map((item, idx) => {
            const cleanItem = item.replace(/"/g, '');
            return `${idx + 1}. ${cleanItem}`;
          }).join('\\n');
          return `"content":"${numberedList}"`;
        });
        
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
