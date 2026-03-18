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

  static buildPrompt({ producerReport, responsibleReport, producerFilledReports, responsibleFilledReports, instructions }) {
    const producerDims = (producerReport.dimensions || []).map(d => d.name || d).filter(Boolean);
    const responsibleDims = (responsibleReport.dimensions || []).map(d => d.name || d).filter(Boolean);
    const allDims = [...new Set([...producerDims, ...responsibleDims])];

    const fmtReports = (list) => list.length > 0
      ? list.slice(0, 5).map((fr, i) =>
          `${i + 1}. Estado:${fr.status} Obs:${(fr.observations || 'ninguna').substring(0, 60)}`
        ).join('; ')
      : 'Sin respuestas.';

    const analysisSchema = allDims.map(dim => `{"dimension_name":"${dim}","content":"...","conclusions":"..."}`).join(',');

    return `Eres experto en acreditacion CNA Colombia. Responde SOLO con JSON valido, sin texto adicional.

DATOS:
Productor: "${producerReport.name}" | Dims: ${producerDims.join(', ') || 'N/A'} | Respuestas: ${fmtReports(producerFilledReports)}
Responsable: "${responsibleReport.name}" | Dims: ${responsibleDims.join(', ') || 'N/A'} | Respuestas: ${fmtReports(responsibleFilledReports)}
${instructions ? `Instrucciones extra: ${instructions}` : ''}

Esquema JSON a completar (reemplaza ... con contenido real en espanol, max 2 oraciones por campo):
{"report_title":"Informe Ambito: ${producerReport.name} y ${responsibleReport.name}","filename_suggestion":"informe_ambito","description":"...","requires_attachment":false,"table_of_contents":[{"section":"Objetivo","page":1},{"section":"Analisis","page":2},{"section":"Conclusiones","page":3}],"sections":{"objective":"...","variables":"...","methodology":"...","analysis":[${analysisSchema}],"general_conclusions":"...","integral_evaluation":"...","improvement_actions":["...","..."],"references":["CNA 2024","Lineamientos Unibague"]}}`;
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

  static async generateMergePlan({ producerReport, responsibleReport, producerFilledReports, responsibleFilledReports, instructions }) {
    const { model, ollamaUrl, useGemini, geminiKey } = this.getConfig();
    const prompt = this.buildPrompt({ producerReport, responsibleReport, producerFilledReports, responsibleFilledReports, instructions });

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
      generationConfig: { temperature: 0.3 }
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
        temperature: 0.6,
        num_predict: 3000,
        num_ctx: 4096
      }
    }, {
      timeout: 240000
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
