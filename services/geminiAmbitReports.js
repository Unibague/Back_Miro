const axios = require("axios");

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_AMBIT_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5:7b';

class GeminiAmbitReportsService {
  static getConfig() {
    return { model: MODEL, ollamaUrl: OLLAMA_URL };
  }

  static buildPrompt({ producerReport, responsibleReport, instructions }) {
    return [
      "Eres experto en informes CNA. Genera un informe de ámbito COMPLETO y DETALLADO.",
      "",
      "FUENTE A:",
      `Nombre: ${producerReport.name}`,
      `Descripción: ${producerReport.description || 'N/A'}`,
      `Dimensiones: ${Array.isArray(producerReport.dimensions) ? producerReport.dimensions.length : 0}`,
      "",
      "FUENTE B:",
      `Nombre: ${responsibleReport.name}`,
      `Descripción: ${responsibleReport.description || 'N/A'}`,
      `Dimensiones: ${Array.isArray(responsibleReport.dimensions) ? responsibleReport.dimensions.length : 0}`,
      "",
      instructions?.trim() ? `INSTRUCCIONES: ${instructions.trim()}` : "",
      "",
      "RESPONDE SOLO JSON con contenido MODERADO:",
      JSON.stringify({
        report_title: "Título del informe",
        table_of_contents: [
          {section: "1. Objetivo del informe", page: 4},
          {section: "2. Variables a analizar", page: 4},
          {section: "3. Metodología a emplear", page: 5},
          {section: "4. Procesamiento y análisis", page: 5},
          {section: "5. Conclusiones generales", page: 6},
          {section: "6. Referencias bibliográficas", page: 7}
        ],
        sections: {
          objective: "2 párrafos del objetivo",
          variables: "Lista de 4-5 variables",
          methodology: "2 párrafos de metodología",
          analysis: [
            {
              dimension_name: "Nombre dimensión",
              content: "2 párrafos de análisis",
              conclusions: "3-4 conclusiones"
            }
          ],
          general_conclusions: "4-5 conclusiones generales",
          integral_evaluation: "1-2 párrafos de evaluación",
          improvement_actions: ["Acción 1", "Acción 2", "Acción 3"],
          references: ["Referencia 1", "Referencia 2"]
        }
      }),
      "",
      "IMPORTANTE: Genera contenido PROFESIONAL pero CONCISO para respuesta rápida."
    ].filter(Boolean).join("\n");
  }

  static safeJsonParse(content) {
    if (!content || typeof content !== "string") return null;

    try {
      return JSON.parse(content);
    } catch (_) {
      const first = content.indexOf("{");
      const last = content.lastIndexOf("}");
      if (first >= 0 && last > first) {
        try {
          return JSON.parse(content.slice(first, last + 1));
        } catch (_) {
          return null;
        }
      }
      return null;
    }
  }

  static async generateMergePlan({ producerReport, responsibleReport, instructions }) {
    const { model, ollamaUrl } = this.getConfig();
    const prompt = this.buildPrompt({ producerReport, responsibleReport, instructions });

    console.log("[Ollama] Using model:", model);

    const MAX_RETRIES = 2;
    let response;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await axios.post(`${ollamaUrl}/api/generate`, {
          model: model,
          prompt: prompt,
          stream: false,
          format: "json",
          keep_alive: -1,
          options: {
            temperature: 0.3,
            num_predict: 1200,  // Reducido para evitar timeout
            num_ctx: 4096,
            top_p: 0.9,
            top_k: 40
          }
        }, {
          timeout: 120000  // 2 minutos
        });
        break;
      } catch (axiosError) {
        console.error(`[Ollama] Attempt ${attempt}/${MAX_RETRIES} failed:`, axiosError.message);
        
        if (attempt < MAX_RETRIES) {
          console.log(`[Ollama] Retrying in 5s...`);
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        
        throw axiosError;
      }
    }

    const content = response?.data?.response;
    const parsed = this.safeJsonParse(content);

    if (!parsed) {
      const error = new Error("Ollama response could not be parsed as JSON");
      error.code = "OLLAMA_INVALID_JSON";
      error.raw = content;
      throw error;
    }

    return {
      model,
      rawText: content,
      parsed,
    };
  }
}

module.exports = GeminiAmbitReportsService;
