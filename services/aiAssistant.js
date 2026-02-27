const axios = require('axios');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

// Contexto del sistema MIRÓ
const SYSTEM_CONTEXT = `te llamas ARDI Eres un asistente virtual del Sistema MIRÓ (Mecanismo de Información y Reporte Oficial) de la Universidad de Ibagué.

MIRÓ es un sistema de gestión de información para procesos de acreditación universitaria.

**Funcionalidades principales:**
1. **Gestión de Plantillas**: Crear y configurar plantillas de datos con campos personalizados
2. **Gestión de Reportes**: Generar reportes consolidados desde plantillas
3. **Gestión de Períodos**: Definir períodos académicos con fechas de carga
4. **Roles de Usuario**:
   - Administrador: Gestión completa del sistema
   - Productor: Carga datos en plantillas asignadas
   - Responsable: Revisa y consolida información
5. **Dependencias**: Estructura organizacional jerárquica de la universidad
6. **Sincronización**: Integración con sistema Atlante para usuarios y dependencias
7. **Auditoría**: Registro de cambios y acciones en el sistema

**Características:**
- Carga masiva de datos vía Excel
- Validadores personalizados para campos
- Notificaciones por correo
- Gestión de permisos por dependencia
- Reportes consolidados por dimensión

Responde de forma clara, concisa y en español. Si no sabes algo específico, sugiere contactar al administrador del sistema.`;

class AIAssistantService {
  
  async chat(userMessage, conversationHistory = []) {
    try {
      // Construir mensajes con contexto
      const messages = [
        { role: 'system', content: SYSTEM_CONTEXT },
        ...conversationHistory,
        { role: 'user', content: userMessage }
      ];

      const response = await axios.post(`${OLLAMA_URL}/api/chat`, {
        model: MODEL,
        messages: messages,
        stream: false,
        options: {
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: 500
        }
      });

      return {
        success: true,
        message: response.data.message.content,
        model: MODEL
      };
    } catch (error) {
      console.error('Error en AI Assistant:', error.message);
      return {
        success: false,
        error: 'No se pudo conectar con el asistente de IA. Verifica que Ollama esté ejecutándose.',
        details: error.message
      };
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
