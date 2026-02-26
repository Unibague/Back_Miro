const mongoose = require("mongoose");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Report = require("../models/reports");
const ProducerReport = require("../models/producerReports");
const UserService = require("../services/users");
const AuditLogger = require("../services/auditLogger");
const GeminiAmbitReportsService = require("../services/geminiAmbitReports");
const { uploadFileToGoogleDrive } = require("../config/googleDrive");
const { buildMergedAmbitWordDocument } = require("../services/ambitReportWordDocument");

const ambitReportsController = {};

const buildSafeFileName = (rawName, defaultExtension = ".rtf") => {
  const base = String(rawName || "informe_ambito")
    .trim()
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, "_")
    .slice(0, 120);
//cambio
  const normalized = base || `informe_ambito_${Date.now()}`;
  const hasKnownOfficeExt = /\.(rtf|doc|docx)$/i.test(normalized);
  return hasKnownOfficeExt ? normalized : `${normalized}${defaultExtension}`;
};

const uniqObjectIds = (...groups) => {
  const seen = new Set();
  const result = [];

  for (const group of groups) {
    for (const id of group || []) {
      const value = String(id);
      if (!mongoose.Types.ObjectId.isValid(value) || seen.has(value)) continue;
      seen.add(value);
      result.push(new mongoose.Types.ObjectId(value));
    }
  }

  return result;
};

ambitReportsController.generateAmbitReportWithAI = async (req, res) => {
  try {
    const {
      producerReportId,
      responsibleReportId,
      name,
      description = "",
      instructions = "",
      email,
    } = req.body;

    if (!email) {
      return res.status(400).json({ message: "email is required" });
    }

    if (!producerReportId || !responsibleReportId) {
      return res.status(400).json({
        message: "producerReportId and responsibleReportId are required",
      });
    }

    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: "name is required" });
    }

    const user = await UserService.findUserByEmailAndRole(email, "Administrador");

    const [producerReport, responsibleReport] = await Promise.all([
      ProducerReport.findById(producerReportId).lean(),
      Report.findById(responsibleReportId).lean(),
    ]);

    if (!producerReport) {
      return res.status(404).json({ message: "Producer report not found" });
    }

    if (!responsibleReport) {
      return res.status(404).json({ message: "Responsible report not found" });
    }

    const mergedDimensions = uniqObjectIds(
      producerReport.dimensions,
      responsibleReport.dimensions
    );

    if (mergedDimensions.length === 0) {
      return res.status(400).json({
        message: "The selected reports do not contain dimensions to merge",
      });
    }

    let aiResult = null;
    let aiError = null;

    try {
      aiResult = await GeminiAmbitReportsService.generateMergePlan({
        producerReport,
        responsibleReport,
        instructions: String(instructions || ""),
      });
    } catch (error) {
      aiError = error;
      console.error("Gemini ambit merge generation failed:", error?.message || error);
    }

    const aiParsed = aiResult?.parsed || null;

    const generatedDescription =
      String(aiParsed?.description || "").trim() ||
      String(description).trim() ||
      [
        "Informe de ambito generado por fusion de plantillas base.",
        `Base productores: ${producerReport.name}.`,
        `Base responsables: ${responsibleReport.name}.`,
        instructions ? `Instrucciones IA: ${String(instructions).trim()}` : "",
      ]
        .filter(Boolean)
        .join(" ");

    const aiSuggestedFileName = buildSafeFileName(aiParsed?.filename_suggestion || name, ".rtf");

    const aiSuggestedRequiresAttachment =
      typeof aiParsed?.requires_attachment === "boolean"
        ? aiParsed.requires_attachment
        : null;

    const inheritedAttachment = responsibleReport.report_example_link
      ? {
          id: responsibleReport.report_example_id || "",
          link: responsibleReport.report_example_link || "",
          download: responsibleReport.report_example_download || "",
          source: "responsible",
        }
      : producerReport?.report_example?.view_link
        ? {
            id: producerReport?.report_example?.id || "",
            link: producerReport?.report_example?.view_link || "",
            download: producerReport?.report_example?.download_link || "",
            source: "producer",
          }
        : null;

    let generatedAttachment = null;
    try {
      const docResult = await buildMergedAmbitWordDocument({
        reportName: String(name).trim(),
        producerReport,
        responsibleReport,
        aiMergePlan: aiParsed,
        aiMetadata: {
          model: aiResult?.model || null,
        },
      });

      const tempFilePath = path.join(
        os.tmpdir(),
        `ambit-report-${Date.now()}-${Math.random().toString(36).slice(2)}.rtf`
      );
      fs.writeFileSync(tempFilePath, docResult.buffer);

      const uploaded = await uploadFileToGoogleDrive(
        {
          path: tempFilePath,
          mimetype: "application/rtf",
        },
        "Formatos/Informes/Dimensiones",
        aiSuggestedFileName
      );

        generatedAttachment = {
          id: uploaded.id,
          link: uploaded.webViewLink,
          download: uploaded.webContentLink,
          source: "generated_ai_merge",
          document_stats: docResult.stats,
        };

      try {
        fs.unlinkSync(tempFilePath);
      } catch (_) {}
    } catch (error) {
      console.error("Error generating/uploading ambit workbook attachment:", error);
    }

    const newReport = new Report({
      name: String(name).trim(),
      description: generatedDescription,
      requires_attachment:
        aiSuggestedRequiresAttachment !== null
          ? aiSuggestedRequiresAttachment
          : Boolean(producerReport.requires_attachment) ||
            Boolean(responsibleReport.requires_attachment),
      file_name: aiSuggestedFileName,
      created_by: {
        email: user.email,
        full_name: user.full_name || user.name || user.email,
      },
      dimensions: mergedDimensions,
      report_example_id: generatedAttachment?.id || inheritedAttachment?.id || "",
      report_example_link: generatedAttachment?.link || inheritedAttachment?.link || "",
      report_example_download: generatedAttachment?.download || inheritedAttachment?.download || "",
      ai_generation: {
        provider: aiResult ? "gemini" : "none",
        model: aiResult?.model || null,
        strategy: aiResult ? "ai-merge-plan" : "base-merge-fallback",
        source_reports: {
          producer: {
            _id: String(producerReport._id),
            name: producerReport.name,
          },
          responsible: {
            _id: String(responsibleReport._id),
            name: responsibleReport.name,
          },
        },
        inherited_attachment_from: generatedAttachment ? null : inheritedAttachment?.source || null,
        generated_attachment: generatedAttachment
          ? {
              source: generatedAttachment.source,
              document_stats: generatedAttachment.document_stats || null,
            }
          : null,
        instructions: String(instructions || "").trim(),
        merge_plan: aiParsed,
        raw_response: aiResult?.rawText || null,
        error: aiError
          ? {
              code: aiError.code || null,
              message: aiError.message || "AI generation failed",
            }
          : null,
        generated_at: new Date(),
      },
    });

    await newReport.save();

    try {
      await AuditLogger.logCreate(req, user, "REPORT", {
        reportId: newReport._id.toString(),
        reportName: newReport.name,
        action: "ai_generate_ambit_report",
        sourceProducerReportId: producerReport._id.toString(),
        sourceProducerReportName: producerReport.name,
        sourceResponsibleReportId: responsibleReport._id.toString(),
        sourceResponsibleReportName: responsibleReport.name,
        mergedDimensions: mergedDimensions.map(String),
        instructions: String(instructions || "").trim(),
        aiEnabled: Boolean(aiResult),
        aiModel: aiResult?.model || null,
        generatedAttachment: Boolean(generatedAttachment),
      });
    } catch (auditError) {
      console.error("Error logging ambit report AI generation:", auditError);
    }

    return res.status(201).json({
      message: "Informe de ambito generado correctamente",
      report: newReport,
      strategy: aiResult ? "ai-merge-plan" : "base-merge-fallback",
      ai: {
        enabled: Boolean(aiResult),
        model: aiResult?.model || null,
        parseSuccess: Boolean(aiParsed),
        error: aiError
          ? {
              code: aiError.code || null,
              message: aiError.message || "AI generation failed",
            }
          : null,
        mergePlan: aiParsed,
      },
      sources: {
        producerReport: {
          _id: producerReport._id,
          name: producerReport.name,
        },
        responsibleReport: {
          _id: responsibleReport._id,
          name: responsibleReport.name,
        },
      },
    });
  } catch (error) {
    console.error("Error generating ambit report with AI:", error);

    if (error?.code === 11000) {
      return res.status(409).json({
        message: "Ya existe un informe con ese nombre",
      });
    }

    return res.status(500).json({
      message: "Error generating ambit report with AI",
      error: error.message,
    });
  }
};

module.exports = ambitReportsController;
