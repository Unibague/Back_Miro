const axios = require('axios');
const documentReader = require('./documentReader');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';

// Contexto del sistema MIRÓ
const SYSTEM_CONTEXT = `Eres ARDI, asistente del Sistema MIRÓ de la Universidad de Ibagué.

MIRÓ gestiona información para acreditación universitaria con:
- Plantillas de datos personalizables
- Reportes consolidados
- Períodos académicos
- Roles: Administrador, Productor, Responsable
- Dependencias jerárquicas
- Auditoría de cambios

Responde breve y claro en español.`;

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

      // Timeout dinámico: 100ms por token + 30s base
      const maxTokens = options.maxTokens || 200;
      const dynamicTimeout = Math.max(120000, maxTokens * 100 + 30000);

      const response = await axios.post(`${OLLAMA_URL}/api/generate`, {
        model: MODEL,
        prompt: prompt,
        stream: false,
        keep_alive: -1,
        options: {
          temperature: options.temperature || 0.7,
          num_predict: maxTokens
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
