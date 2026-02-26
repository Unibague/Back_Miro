const axios = require("axios");

class GeminiAmbitReportsService {
  static getConfig() {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = (process.env.GEMINI_MODEL || "gemini-2.0-flash").trim();

    if (!apiKey) {
      const error = new Error("GEMINI_API_KEY is not configured");
      error.code = "GEMINI_CONFIG_MISSING";
      throw error;
    }

    return { apiKey, model };
  }

  static buildPrompt({ producerReport, responsibleReport, instructions }) {
    return [
      "Eres un arquitecto de formularios e informes institucionales.",
      "Debes fusionar inteligentemente un informe de productores y un informe de responsables para crear un informe de ambito.",
      "No inventes datos de negocio; trabaja solo con la informacion disponible.",
      "Si no hay campos explicitamente definidos, infiere secciones y grupos de campos a partir de nombres y descripciones.",
      "",
      "INFORME PRODUCTORES (fuente A)",
      JSON.stringify(
        {
          id: String(producerReport._id),
          name: producerReport.name,
          description: producerReport.description || "",
          requires_attachment: !!producerReport.requires_attachment,
          file_name: producerReport.file_name || "",
          dimensions_count: Array.isArray(producerReport.dimensions)
            ? producerReport.dimensions.length
            : 0,
          producers_count: Array.isArray(producerReport.producers)
            ? producerReport.producers.length
            : 0,
        },
        null,
        2
      ),
      "",
      "INFORME RESPONSABLES (fuente B)",
      JSON.stringify(
        {
          id: String(responsibleReport._id),
          name: responsibleReport.name,
          description: responsibleReport.description || "",
          requires_attachment: !!responsibleReport.requires_attachment,
          file_name: responsibleReport.file_name || "",
          dimensions_count: Array.isArray(responsibleReport.dimensions)
            ? responsibleReport.dimensions.length
            : 0,
        },
        null,
        2
      ),
      "",
      "INSTRUCCIONES ADICIONALES DEL USUARIO",
      instructions?.trim() || "(sin instrucciones adicionales)",
      "",
      "RESPONDE EXCLUSIVAMENTE EN JSON VALIDO (sin markdown, sin comentarios) con esta estructura:",
      JSON.stringify(
        {
          merged_report_name_suggestion: "string",
          description: "string",
          filename_suggestion: "string .rtf o .docx",
          requires_attachment: true,
          sections: [
            {
              id: "seccion_1",
              title: "string",
              purpose: "string",
              source: "producer|responsible|both",
              priority: 1,
              notes: "string",
            },
          ],
          field_groups: [
            {
              group_name: "string",
              source: "producer|responsible|both",
              fields: ["campo_1", "campo_2"],
            },
          ],
          merge_rules: [
            "Regla de fusion 1",
            "Regla de fusion 2",
          ],
          assumptions: [
            "Supuesto 1"
          ]
        },
        null,
        2
      ),
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
    const { apiKey, model } = this.getConfig();
    const prompt = this.buildPrompt({ producerReport, responsibleReport, instructions });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    console.log("[Gemini] Using model:", model);

    const requestBody = {
      system_instruction: {
        parts: [
          {
            text: "Eres un asistente experto en diseno de informes institucionales. Siempre respondes JSON valido.",
          },
        ],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
      },
    };

    const MAX_RETRIES = 3;
    let response;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await axios.post(url, requestBody, {
          headers: { "Content-Type": "application/json" },
          timeout: 45000,
        });
        break;
      } catch (axiosError) {
        const status = axiosError?.response?.status;
        console.error(`[Gemini] Attempt ${attempt}/${MAX_RETRIES} failed - status: ${status}`);
        console.error("[Gemini] Error body:", JSON.stringify(axiosError?.response?.data));

        if (status === 429 && attempt < MAX_RETRIES) {
          const retryAfter = axiosError?.response?.headers?.["retry-after"];
          const delayMs = retryAfter ? parseInt(retryAfter) * 1000 : attempt * 10000;
          console.log(`[Gemini] Rate limited. Retrying in ${delayMs / 1000}s...`);
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        throw axiosError;
      }
    }

    const content = response?.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    const parsed = this.safeJsonParse(content);

    if (!parsed) {
      const error = new Error("Gemini response could not be parsed as JSON");
      error.code = "GEMINI_INVALID_JSON";
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
