const { default: mongoose } = require("mongoose");
const PeriodService = require("../services/period");
const ProducerReportsService = require("../services/producerReports");
const PublishedReportService = require("../services/publishedProducerReports");
const UserService = require("../services/users");
const PubProdReport = require("../models/publishedProducerReports");
const dayjs = require('dayjs');
const User = require('../models/users');
const Dependency = require('../models/dependencies');
const Period = require('../models/periods');
const auditLogger = require('../services/auditLogger');

const datetime_now = () => {
  const now = new Date();

  const offset = -5; // GMT-5
  const dateWithOffset = new Date(now.getTime() + offset * 60 * 60 * 1000);

  return new Date(dateWithOffset.setMilliseconds(now.getMilliseconds()));
};

const pubProdReportController = {};

pubProdReportController.getPublishedProducerReport = async (req, res) => {
  try {
    const {id} = req.params;
    const {email} = req.query;
    await UserService.findUserByEmailAndRoles(email, ["Responsable", "Administrador"]);
    const report = await PublishedReportService.findPublishedReportById(id);
    res.status(200).json(report);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

pubProdReportController.getPublishedProducerReportProducer = async (req, res) => {
  try {
    const { email } = req.query;
    const { id } = req.params;
    const user = await UserService.findUserByEmailAndRole(email, "Productor");
    const report = await PublishedReportService.findPublishedReportProducer(user, id)
    res.status(200).json(report);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

pubProdReportController.getPublishedProducerReports = async (req, res) => {
  try {
    const {email, page, limit, search, periodId} = req.query


    // Si no hay email, intentar obtenerlo del token/sesión o retornar error claro
    if (!email) {
      return res.status(400).json({ 
        message: "Email is required",
        hint: "Add ?email=your@email.com to the URL" 
      });
    }

    const user = await UserService.findUserByEmailAndRoles(email, ["Responsable", "Administrador"]);
    
    const reports = await PublishedReportService.findPublishedReports(user, page, limit, search, periodId);

    res.status(200).json(reports);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

pubProdReportController.deletePublishedProducerReport = async (req, res) => {
  const { id } = req.params;
  const { email } = req.query;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    const report = await PubProdReport.findById(id);
    if (!report) {
      return res.status(404).json({ error: "Informe no encontrado" });
    }

    if (report.filled_reports && report.filled_reports.length > 0) {
      return res.status(400).json({ error: "El informe ya tiene responsables que han diligenciado información" });
    }

    await PubProdReport.findByIdAndDelete(id);
    
    // Audit log
    await auditLogger.logDelete(req, user, 'publishedProducerReport', {
      reportId: id,
      reportName: report.report?.name
    });
    
    return res.status(200).json({ status: "Informe eliminado correctamente" });
  } catch (error) {
    return res.status(500).json({ error: "Error interno del servidor" });
  }
};

pubProdReportController.getPendingProducerReportsByUser = async (req, res) => {
  try {
    let { periodId } = req.query;

    if (!periodId) {
      const activePeriod = await Period.findOne({ is_active: true }).sort({ updatedAt: -1 });
      if (!activePeriod) {
        return res.status(404).json({ message: "No se encontró un periodo activo" });
      }
      periodId = activePeriod._id;
    }

    const users = await User.find({
      isActive: true,
      roles: "Productor",
    }).lean();

    const dependencies = await Dependency.find().lean();
    const reports = await PubProdReport.find({ period: periodId }).lean();


    const results = [];

    for (const user of users) {
      const userDeps = dependencies.filter(dep =>
        dep.members?.includes(user.email)
      );


      const pendingTemplates = [];

      for (const report of reports) {
        const assignedDepIds = (report.report?.producers || []).map(id => id.toString());
        const filledDepIds = new Set((report.filled_reports || []).map(fr => fr.dependency.toString()));

        for (const dep of userDeps) {
          const depIdStr = dep._id.toString();

          if (assignedDepIds.includes(depIdStr) && !filledDepIds.has(depIdStr)) {
            const reportName = report.report?.name || "Informe sin nombre";
            if (!pendingTemplates.includes(reportName)) {
              pendingTemplates.push(reportName);
            }
          }
        }
      }

      if (pendingTemplates.length > 0) {
        results.push({
          full_name: user.full_name,
          email: user.email,
          pendingReports: pendingTemplates,
        });
      }
    }

    return res.status(200).json(results);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};


pubProdReportController.getPublishedProducerReportsProducer = async (req, res) => {
  try {
    const {email, page, limit, search, periodId, dimensionId} = req.query

    const user = await UserService.findUserByEmailAndRole(email, "Productor");
    const reports = await PublishedReportService.findPublishedReportsProducer(user, page, limit, search, periodId, dimensionId);
    res.status(200).json(reports);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

pubProdReportController.loadProducerReportDraft = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let { email, publishedReportId, newAttachmentsDescriptions } = req.body;
    if (!Array.isArray(newAttachmentsDescriptions)) {
      newAttachmentsDescriptions = [newAttachmentsDescriptions];
    }
    const filledDraft = JSON.parse(req.body.filledDraft ?? "");
    const reportFile = req.files["reportFile"]
      ? req.files["reportFile"][0]
      : null;
    const attachments = req.files["attachments"] || [];
    const deletedReport = req.body.deletedReport ?? null;
    const deletedAttachments = req.body.deletedAttachments ?? [];

    attachments.forEach((attachment, index) => {
      attachment.description = newAttachmentsDescriptions[index] || "";
    });

    const nowtime = datetime_now();
    const nowdate = new Date(nowtime);

    const user = await UserService.findUserByEmailAndRole(email, "Productor");

    const pubRep = await PublishedReportService.findPublishedReportProducer(user, publishedReportId, session);
    

    // Establecer deadline a las 23:59:59 del día
    const pubRepDeadline = new Date(pubRep.deadline);
    pubRepDeadline.setHours(23, 59, 59, 999);
    
    const pubRepStartDate = new Date(pubRep.period.producer_start_date);
    pubRepStartDate.setHours(0, 0, 0, 0);
    
    if(pubRepDeadline < nowdate || pubRepStartDate > nowdate) {
      throw new Error("The report period is already closed");
    }
    
    const draft = await PublishedReportService.findDraft(pubRep, filledDraft._id,session);
    const path = `${pubRep.period.name}/Informes/Productores/Borradores/${pubRep.report.name}
      /${pubRep.report.producers[0].name}/${draft ? draft.loaded_date.toISOString() 
      : nowtime.toISOString()}`;

    draft?.attachments?.forEach((draftAttachment) => {
      const filledAttachment = filledDraft?.attachments?.find(
        (attachment) => attachment._id.toString() === draftAttachment._id.toString()
      );
      if (filledAttachment) {
        draftAttachment.description = filledAttachment.description;
      }
    });
    await PublishedReportService.upsertReportDraft(pubRep, draft, reportFile, attachments, 
      deletedReport, deletedAttachments, nowtime, path, user, session
    );

    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ status: "Responsible report draft loaded" });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    
    res.status(500).json({
      status: "Error loading responsible report draft",
      error: error.message,
    });
  }
}

pubProdReportController.sendProducerReport = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { email, publishedReportId, filledDraftId } = req.body;
    
    await PublishedReportService.sendProductorReportDraft(email, publishedReportId, filledDraftId, datetime_now(), session)

    await session.commitTransaction();
    session.endSession();

    res.status(200).json({ status: "Responsible report draft sent" });
  } catch(error) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({
      status: "Error sending responsible report draft",
      error: error.message,
    });
  }
}

pubProdReportController.publishProducerReport = async (req, res) => {
  try {
    
    const {email, reportId, deadline, period} = req.body;
    
    const user = await UserService.findUserByEmailAndRoles(email, ["Responsable", "Administrador"]);
    
    const report = await ProducerReportsService.getReport(reportId);

    const publishedReport = await PublishedReportService.publishReport(report, period, deadline);
    
    // Audit log
    if (publishedReport && publishedReport._id) {
      await auditLogger.logCreate(req, user, 'publishedProducerReport', {
        reportId: publishedReport._id,
        reportName: report.name
      });
    } else {
    }
    
    res.status(200).json({ 
      message: 'Report succesfully published',
      publishedReportId: publishedReport?._id 
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
}

pubProdReportController.setFilledReportStatus = async (req, res) => {
  try {
    const { email, reportId, filledRepId, observations } = req.body;

    const user = await UserService.findUserByEmailAndRole(email, "Administrador");

    const publishedReport = await PubProdReport.findById(reportId)
      .where("filled_reports")
      .elemMatch({ _id: filledRepId })
      .exec();

    if (!publishedReport) {
      return res.status(404).json({ status: "Published Report not found" });
    }

    const filledReport = publishedReport.filled_reports.id(filledRepId);
    if (!filledReport) {
      return res.status(404).json({ status: "Filled Report not found" });
    }

    const now = datetime_now();
    filledReport.status = req.body.status;
    filledReport.status_date = now;
    if (req.body.status === "Rechazado" && !req.body.observations) {
      return res
        .status(400)
        .json({ status: "Observations are required for rejected reports" });
    }
    filledReport.observations = observations;
    filledReport.evaluated_by = user;
    await publishedReport.save();

    res.status(200).json({ status: "Filled report status set" });
  } catch (error) {
    res.status(500).json({
      status: "Error setting filled report status",
      error: error.message,
    });
  }
};


pubProdReportController.updateDeadlines = async (req, res) => {
  try {
    const { email, reportIds, deadline } = req.body;

    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    for (const id of reportIds) {
      await PubProdReport.findByIdAndUpdate(id, { deadline });
    }

    return res.status(200).json({ message: "Fechas actualizadas exitosamente." });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

module.exports = pubProdReportController;