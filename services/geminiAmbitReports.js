const axios = require("axios");

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_AMBIT_MODEL || 'qwen2.5:3b';
const USE_GEMINI = process.env.USE_GEMINI_FOR_AMBIT === 'true';
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-pro';

class GeminiAmbitReportsService {
  static getConfig() {
    return { 
      model: USE_GEMINI ? GEMINI_MODEL : MODEL, 
      ollamaUrl: OLLAMA_URL,
      useGemini: USE_GEMINI,
      geminiKey: GEMINI_KEY
    };
  }

  static buildPrompt({ producerReport, responsibleReport, instructions }) {
    return [
      "JSON:",
      JSON.stringify({
        report_title: "Informe de " + producerReport.name,
        table_of_contents: [
          {section: "Objetivo", page: 1},
          {section: "Variables", page: 2},
          {section: "Metodologia", page: 3},
          {section: "Analisis", page: 4},
          {section: "Conclusiones", page: 5}
        ],
        sections: {
          objective: "Analizar datos de " + producerReport.name + " y " + responsibleReport.name,
          variables: "Variables institucionales",
          methodology: "Analisis cuantitativo y cualitativo",
          analysis: [{dimension_name: "General", content: "Analisis de datos", conclusions: "Resultados positivos"}],
          general_conclusions: "Cumplimiento de objetivos",
          integral_evaluation: "Evaluacion satisfactoria",
          improvement_actions: ["Continuar mejorando"],
          references: ["CNA 2024"]
        }
      }),
    ].join("\n");
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
    const { model, ollamaUrl, useGemini, geminiKey } = this.getConfig();
    const prompt = this.buildPrompt({ producerReport, responsibleReport, instructions });

    console.log("[AI] Using:", useGemini ? 'Gemini API' : 'Ollama', model);

    if (useGemini && geminiKey) {
      return await this.generateWithGemini(prompt, model, geminiKey);
    }
    
    return await this.generateWithOllama(prompt, model, ollamaUrl);
  }

  static async generateWithGemini(prompt, model, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${apiKey}`;
    
    const response = await axios.post(url, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { 
        temperature: 0.3
      }
    }, { timeout: 30000 });

    const content = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = this.safeJsonParse(content);

    if (!parsed) {
      const error = new Error("Gemini response invalid JSON");
      error.code = "GEMINI_INVALID_JSON";
      throw error;
    }

    return { model, rawText: content, parsed };
  }

  static async generateWithOllama(prompt, model, ollamaUrl) {
    const response = await axios.post(`${ollamaUrl}/api/generate`, {
      model: model,
      prompt: prompt,
      stream: false,
      format: "json",
      keep_alive: -1,
      options: {
        temperature: 0.2,
        num_predict: 500,
        num_ctx: 4096
      }
    }, {
      timeout: 120000  // 2 minutos para llama3.2:3b
    });

    const content = response?.data?.response;
    const parsed = this.safeJsonParse(content);

    if (!parsed) {
      const error = new Error("Ollama response invalid JSON");
      error.code = "OLLAMA_INVALID_JSON";
      error.raw = content;
      throw error;
    }

    return { model, rawText: content, parsed };
  }
}

module.exports = GeminiAmbitReportsService;
