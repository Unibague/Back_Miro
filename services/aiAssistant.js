const axios = require('axios');
const documentReader = require('./documentReader');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

const SYSTEM_CONTEXT = `Eres ARDI, asistente del Sistema MIRÓ de la Universidad de Ibagué.

SOLO RESPONDE SOBRE MIRÓ. Si preguntan algo fuera del sistema, di: "Solo puedo ayudarte con el Sistema MIRÓ".

**PRODUCTORES:**
- Ver Mi Dependencia: Muestra tu unidad organizacional (Facultad, Departamento, etc.)
- Plantillas Publicadas: Formularios asignados a tu dependencia que debes llenar en el período activo
- Informes Productores: Crear reportes con datos de tu dependencia (ejemplo: estadísticas, indicadores)
- Mis Datos: Ver plantillas que ya has llenado anteriormente
- Gestionar Informes: Editar, eliminar o actualizar tus informes

**RESPONSABLES:**
- Consolidar Informes: Revisar informes de productores de tu dependencia y aprobarlos
- Informes Responsable: Crear reportes consolidados con análisis de tu dependencia
- Ver Productores: Lista de productores asignados a tu dependencia

**ADMINISTRADORES:**
- Crear Plantillas: Diseñar formularios con campos (texto, número, fecha, archivo, lista)
- Publicar Plantillas: Asignar plantillas a dependencias y períodos específicos
- Crear Períodos: Definir fechas inicio/fin y deadlines para productores y responsables
- Informes Ámbito (IA): Fusionar informes de productores y responsables usando IA para generar documento Word
- Gestionar Dependencias: Sincronizar estructura organizacional desde sistema Integra
- Auditoría: Ver historial de cambios en configuración (quién, cuándo, qué)
- Notificaciones: Enviar emails automáticos cuando se crean períodos

**FLUJO TÍPICO:**
1. Admin crea período y publica plantillas
2. Productores llenan plantillas en sus dependencias
3. Responsables revisan y consolidan informes
4. Admin genera informes de ámbito con IA

Responde directo, específico y en español.`;

class AIAssistantService {
  
  constructor() {
    this.keepModelLoaded();
  }

  async keepModelLoaded() {
    try {
      await axios.post(`${OLLAMA_URL}/api/generate`, {
        model: MODEL,
        prompt: 'Hola',
        stream: false,
        keep_alive: -1
      });
    } catch (error) {
      // Ignorar error inicial
    }
  }
  
  async chat(userMessage, conversationHistory = [], options = {}) {
    try {
      // Limitar historial a últimos 2 mensajes
      const recentHistory = conversationHistory.slice(-2);
      
      let prompt = SYSTEM_CONTEXT + '\n\n';
      
      // Agregar contexto de documento si existe
      if (options.documentContext) {
        prompt += `DOCUMENTO ADJUNTO:\n${options.documentContext.substring(0, 3000)}\n\n`;
      }
      
      recentHistory.forEach(msg => {
        if (msg.role === 'user') {
          prompt += `Usuario: ${msg.content}\n`;
        } else if (msg.role === 'assistant') {
          prompt += `Asistente: ${msg.content}\n`;
        }
      });
      
      prompt += `Usuario: ${userMessage}\nAsistente:`;

      // Timeout dinámico: 150ms por token + 30s base (más tiempo para respuestas largas)
      const maxTokens = options.maxTokens || 200;
      const dynamicTimeout = Math.max(120000, maxTokens * 150 + 30000);

      const response = await axios.post(`${OLLAMA_URL}/api/generate`, {
        model: MODEL,
        prompt: prompt,
        stream: false,
        keep_alive: -1,
        options: {
          temperature: options.temperature || 0.7,
          num_predict: maxTokens,
          num_ctx: 8192  // Aumentado para respuestas largas
        }
      }, {
        timeout: dynamicTimeout
      });

      return {
        success: true,
        message: response.data.response,
        model: MODEL
      };
    } catch (error) {
      console.error('Error en AI Assistant:', error.message);
      return {
        success: false,
        error: 'No se pudo conectar con el asistente de IA. Verifica que Ollama esté ejecutándose y el modelo descargado.',
        details: error.response?.data || error.message
      };
    }
  }

  async analyzeDocument(filePath, mimeType, question = null) {
    try {
      const extracted = await documentReader.extractText(filePath, mimeType);
      
      if (!extracted.success) {
        return { success: false, error: extracted.error };
      }
      
      const documentText = extracted.text.substring(0, 4000);
      const prompt = question 
        ? `Documento:\n${documentText}\n\nPregunta: ${question}\nRespuesta:`
        : `Resume este documento:\n${documentText}\n\nResumen:`;
      
      const response = await axios.post(`${OLLAMA_URL}/api/generate`, {
        model: MODEL,
        prompt: prompt,
        stream: false,
        keep_alive: -1,
        options: {
          temperature: 0.3,
          num_predict: 300,
          num_ctx: 4096
        }
      }, { timeout: 120000 });
      
      return {
        success: true,
        analysis: response.data.response,
        documentInfo: { pages: extracted.pages || null, length: extracted.text.length }
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async checkHealth() {
    try {
      const response = await axios.get(`${OLLAMA_URL}/api/tags`);
      const models = response.data.models || [];
      const modelExists = models.some(m => m.name === MODEL);
      
      return {
        status: 'ok',
        ollama_url: OLLAMA_URL,
        model: MODEL,
        model_available: modelExists,
        available_models: models.map(m => m.name)
      };
    } catch (error) {
      return {
        status: 'error',
        message: 'Ollama no está disponible',
        error: error.message
      };
    }
  }
}

module.exports = new AIAssistantService();
