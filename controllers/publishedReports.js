const PubReport = require("../models/publishedReports");
const Report = require("../models/reports");
const User = require("../models/users");
const Period = require("../models/periods");
const Dimension = require("../models/dimensions");
const Dependency = require("../models/dependencies");
const mongoose = require("mongoose");

const UserService = require("../services/users");
const PublishedReportService = require("../services/publishedReports");
const { attachment } = require("express/lib/response");
const PeriodService = require("../services/period");
const AuditLogger = require('../services/auditLogger');

const pubReportController = {};

const datetime_now = () => {
  const now = new Date();

  const offset = -5; // GMT-5
  const dateWithOffset = new Date(now.getTime() + (offset * 60 * 60 * 1000));

  return dateWithOffset;
};

pubReportController.getPublishedReports = async (req, res) => {
  try {
    const { email, page = 1, limit = 10, search = "", periodId } = req.query;

    // Verificar si el usuario es un administrador o Productor activo
    const user = await User.findOne({
      email,
      activeRole: { $in: ["Administrador"] },
      isActive: true,
    });
    if (!user) {
      return res.status(403).json({
        status: "User not found or isn't an Administrator or Producer",
      });
    }

    // Configurar paginación
    const pageNumber = parseInt(page, 10);
    const pageSize = parseInt(limit, 10);
    const skip = (pageNumber - 1) * pageSize;

    // Crear objeto de búsqueda
    const searchQuery = {
      ...(search.trim()
        ? {
            $or: [
              { "report.name": { $regex: search, $options: "i" } },
              { "period.name": { $regex: search, $options: "i" } },
            ],
          }
        : {}),
      ...(periodId && { period: periodId }),
    };

    const publishedReports = await PubReport.find(searchQuery)
      .skip(skip)
      .limit(pageSize)
      .populate("period")
      .populate({
        path: "report.dimensions",
        select: "name responsible",
      })
      .populate({
        path: "filled_reports.dimension",
        select: "name responsible",
      })
      .exec();

    publishedReports.forEach((report) => {
      // Filtrar los filled_reports que no estén en "En Borrador"
      report.filled_reports = report.filled_reports.filter(
        (fr) => fr.status !== "En Borrador"
      );

      // Ordenar los filled_reports por fecha (asumiendo que tienen una propiedad 'date')
      report.filled_reports.sort((a, b) => new Date(b.date) - new Date(a.date));

      // Eliminar duplicados de filled_reports basados en 'dimension'
      const uniqueFilledReports = [];
      const seenDimensions = new Set();

      report.filled_reports.forEach((fr) => {
        if (!seenDimensions.has(fr.dimension.toString())) {
          uniqueFilledReports.push(fr);
          seenDimensions.add(fr.dimension.toString());
        }
      });

      report.filled_reports = uniqueFilledReports;
    });

    const totalReports = await PubReport.countDocuments(searchQuery);

    // Responder con los datos paginados y la información de paginación
    res.status(200).json({
      total: totalReports,
      page: pageNumber,
      limit: pageSize,
      totalPages: Math.ceil(totalReports / pageSize),
      publishedReports,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      status: "Error getting published reports",
      error: error.message,
    });
  }
};

pubReportController.getAdminPublishedReportById = async (req, res) => {
  try {
    const { email, reportId } = req.query;

    const user = await User.findOne({
      email,
      activeRole: { $in: ["Administrador"] },
      isActive: true,
    });
    if (!user) {
      return res.status(403).json({
        status: "User not found or isn't an Administrator or Producer",
      });
    }

    // Buscar el reporte por su id
    const report = await PubReport.findById(reportId)
      .populate("period")
      .populate({
        path: "report.dimensions",
        select: "name responsible",
        model: "dimensions"
      })
      .populate({
        path: "filled_reports.dimension",
        select: "name responsible",
      })
      .exec();
    
    if (!report) {
      return res.status(404).json({
        status: "Report not found",
      });
    }

    // Filtrar los filled_reports que no estén en "En Borrador"
    report.filled_reports = report.filled_reports.filter(
      (fr) => fr.status !== "En Borrador"
    );

    // Ordenar los filled_reports por fecha (asumiendo que tienen una propiedad 'date')
    report.filled_reports.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Eliminar duplicados de filled_reports basados en 'dimension'
    const uniqueFilledReports = [];
    const seenDimensions = new Set();

    report.filled_reports.forEach((fr) => {
      if (!seenDimensions.has(fr.dimension.toString())) {
        uniqueFilledReports.push(fr);
        seenDimensions.add(fr.dimension.toString());
      }
    });

    report.filled_reports = uniqueFilledReports;

    // Responder con el reporte encontrado
    res.status(200).json({
      status: "success",
      report,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      status: "Error getting the report",
      error: error.message,
    });
  }
};


pubReportController.getPublishedReportsResponsible = async (req, res) => {
  try {
    const { email, search = "", periodId } = req.query;

    // Validar usuario Responsable
    const user = await User.findOne({
      email,
      activeRole: "Responsable",
      isActive: true,
    });
    if (!user) {
      return res.status(403).json({ status: "User not found or isn't Responsible" });
    }

    // Filtro base
    const searchQuery = {
      ...(search.trim() && {
        $or: [
          { "report.name": { $regex: search, $options: "i" } },
          { "period.name": { $regex: search, $options: "i" } },
        ],
      }),
      ...(periodId && { period: periodId }),
    };

    let publishedReports = await PubReport.find(searchQuery)
      .populate("period")
      .populate({
        path: "report.dimensions",
        select: "name responsible",
        model: "dimensions",
        populate: {
          path: "responsible",
          match: { visualizers: { $in: [email] } },
          select: "name email",
          model: "dependencies",
        },
      })
      .populate({
        path: "filled_reports.dimension",
        select: "name responsible",
        populate: {
          path: "responsible",
          match: { visualizers: { $in: [email] } },
          select: "name email",
          model: "dependencies",
        },
      });

    // Filtrar solo reportes donde el responsable tiene asignación
    publishedReports = publishedReports.filter((report) =>
      report.report.dimensions.some((dimension) => dimension.responsible !== null)
    );

    console.log(publishedReports);

    // Limpiar y ordenar los filled_reports por fecha (desc)
    const processedReports = publishedReports.map((report) => {
      report.filled_reports = report.filled_reports
        .filter((fr) => fr.dimension.responsible !== null)
        .sort((a, b) => new Date(b.loaded_date) - new Date(a.loaded_date));
      return report;
    });



    // Separar en pendientes y entregados
    const pendingReports = processedReports.filter((r) => r.filled_reports.length === 0);
    const deliveredReports = processedReports.filter((r) => r.filled_reports.length > 0);

    res.status(200).json({
      pendingReports,
      deliveredReports,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      status: "Error getting published reports",
      error: error.message,
    });
  }
};


pubReportController.getLoadedReportsResponsible = async (req, res) => {
  try {
    const { email, page = 1, limit = 10, search = "" } = req.query;

    const user = await User.findOne({
      email,
      isActive: true,
      activeRole: "Responsable",
    });
    if (!user) {
      return res
        .status(403)
        .json({ status: "User not found or isn't an active responsible" });
    }
    // Configurar paginación
    const pageNumber = parseInt(page, 10);
    const pageSize = parseInt(limit, 10);
    const skip = (pageNumber - 1) * pageSize;

    // Crear objeto de búsqueda
    const searchQuery = search.trim()
      ? {
          $or: [
            { "report.name": { $regex: search, $options: "i" } }, // Busca en el campo "report.name"
            { "period.name": { $regex: search, $options: "i" } }, // Busca en el campo "period.name"
          ],
        }
      : {};

    const publishedReports = await PubReport.find(searchQuery)
      .skip(skip)
      .limit(pageSize)
      .populate("period")
      .populate({
        path: "dimensions",
        select: "name responsible",
        match: { responsible: email },
      })
      .populate({
        path: "filled_reports.dimension",
        select: "name responsible",
        match: { responsible: email },
      })
      .where("filled_reports")
      .elemMatch({ $exists: true })
      .exec();

    const publishedReportsFilter = publishedReports.map((report) => {
      const filledReports = report.filled_reports.filter(
        (filledReport) =>
          filledReport.dimension !== null ||
          filledReport.dimension.responsible !== undefined
      );
      return {
        ...report._doc,
        filled_reports: filledReports,
      };
    });

    const totalReports = publishedReports.length;

    res.status(200).json({
      total: totalReports,
      page: pageNumber,
      limit: pageSize,
      totalPages: Math.ceil(totalReports / pageSize),
      publishedReports: publishedReportsFilter,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      status: "Error getting published reports",
      error: error.message,
    });
  }
};

pubReportController.getPublishedReport = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  const { id, email } = req.query;

  try {
    // Paso 1: Buscar en dependencies donde members incluya el email
    const dependency = await Dependency.findOne({ members: email }).session(session);
    if (!dependency) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ error: 'No se encontró una dependencia con ese email en members' });
    }

    // Paso 2: Buscar en dimensions donde responsible sea el _id de esa dependencia
    const dimension = await Dimension.findOne({ responsible: dependency._id }).session(session);
    if (!dimension) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ error: 'No se encontró una dimensión con esa dependencia como responsable' });
    }

    console.log(id,
      email,
      dimension._id,)

    // Paso 3: Llamar al servicio usando la dimensión encontrada
    const publishedReport = await PublishedReportService.findPublishedReportById(
      id,
      email,
      dimension._id,
      session
    );

    await session.commitTransaction();
    session.endSession();
    res.status(200).json(publishedReport);

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error(error);
    res.status(500).json({
      status: "Error getting published report",
      error: error.message,
    });
  }
};


pubReportController.publishReport = async (req, res) => {
  const { reportId, periodId, deadline } = req.body;
  try {
    const report = await Report.findById(reportId);
    if (!report) {
      return res.status(404).json({ status: "Report not found" });
    }
    const publishedReport = new PubReport({
      report,
      period: periodId,
      deadline
    });
    await publishedReport.save();
    
    // Registrar en auditoría
    try {
      const userEmail = req.body.email || 'practicantes.g3@unibague.edu.co'; // Temporal
      const user = await User.findOne({ email: userEmail });
      if (user) {
        const period = await Period.findById(periodId);
        await AuditLogger.logCreate(
          user,
          'REPORT',
          `${report.name} (Publicado)`,
          publishedReport._id.toString(),
          `Publicó el informe "${report.name}" para el período ${period?.name || 'desconocido'}`,
          req
        );
      }
    } catch (auditError) {
      console.error('Error logging audit:', auditError);
    }
    
    res.status(200).json({ status: "Published Report created" });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      status: "Error creating published report",
      error: error.message,
    });
  }
};

pubReportController.feedOptionsForPublish = async (req, res) => {
  try {
    const email = req.query.email;
    const user = await User.findOne({
      email,
      isActive: true,
      activeRole: "Administrador",
    });
    if (!user) {
      return res
        .status(403)
        .json({ status: "User not found or isn't an active administrator" });
    }
    //TODO FILTER ONLY ACTIVE PERIODS
    const currentDate = datetime_now();
    console.log('Current date from datetime_now():', currentDate);
    
    const periods = await Period.find({ 
      is_active: true, 
      responsible_end_date: { $gte: currentDate }
     })
     .select("name responsible_end_date");
     
     console.log('Periods found:', periods);
     
     // Debug: Let's also see all active periods without date filter
     const allActivePeriods = await Period.find({ is_active: true })
       .select("name responsible_end_date");
     console.log('All active periods:', allActivePeriods);


    const dimensions = await Dimension.find({}).select("name");
    res.status(200).json({ periods, dimensions });
  } catch (error) {
    console.log(error);
    res
      .status(500)
      .json({ status: "Error getting feed options", error: error.message });
  }
};

pubReportController.loadResponsibleReportDraft = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    let { email, publishedReportId, newAttachmentsDescriptions, dimension } = req.body;
 
    console.log(req.body);
    console.log(dimension);
    
    // Filtrar valores vacíos del array dimension
    if (Array.isArray(dimension)) {
      dimension = dimension.filter(d => d && d.trim() !== '');
      dimension = dimension.length > 0 ? dimension[0] : null;
    }
    
    console.log('Filtered dimension:', dimension);


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
    const nowdate = new Date(nowtime.toDateString());

    const user = await UserService.findUserByEmailAndRole(email, "Responsable", session);

    const pubRep = await PublishedReportService.findPublishedReportById(publishedReportId, email, dimension, session);
    await PeriodService.validatePeriodResponsible(pubRep, nowdate);
    
    const draft = await PublishedReportService.findDraft(pubRep, filledDraft._id,session);
    const path = `${pubRep.period.name}/Informes/Dimensiones/Borradores/${pubRep.report.name}
      /${pubRep.report.dimensions[0].name}/${draft ? draft.loaded_date.toISOString() 
      : nowtime.toISOString()}`;

    draft?.attachments?.forEach((draftAttachment) => {
      const filledAttachment = filledDraft?.attachments?.find(
        (attachment) => attachment._id.toString() === draftAttachment._id.toString()
      );
      if (filledAttachment) {
        draftAttachment.description = filledAttachment.description;
      }
    });
    console.log(filledDraft)
    await PublishedReportService.upsertReportDraft(pubRep, draft, reportFile, attachments, 
      deletedReport, deletedAttachments, nowtime, path, user, session
    );

    await session.commitTransaction();
    session.endSession();
    res.status(200).json({ status: "Responsible report draft loaded" });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.log(error);
    
    res.status(500).json({
      status: "Error loading responsible report draft",
      error: error.message,
    });
  }
};

pubReportController.sendResponsibleReport = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { email, publishedReportId, filledDraftId } = req.body;
    
    await PublishedReportService.sendResponsibleReportDraft(email, publishedReportId, filledDraftId, datetime_now(), session)

    await session.commitTransaction();
    session.endSession();

    res.status(200).json({ status: "Responsible report draft sent" });
  } catch(error) {
    await session.abortTransaction();
    session.endSession();
    console.log(error);
    res.status(500).json({
      status: "Error sending responsible report draft",
      error: error.message,
    });
  }
}

pubReportController.setFilledReportStatus = async (req, res) => {
  try {
    const { email, reportId, filledRepId, observations } = req.body;

    const user = await User.findOne({
      email,
      isActive: true,
      activeRole: "Administrador",
    });
    if (!user) {
      return res
        .status(403)
        .json({ status: "User not found or isn't an active administrator" });
    }

    const publishedReport = await PubReport.findById(reportId)
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

    console.log("This is the filled report ", filledReport);

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
    console.log(error);
    res.status(500).json({
      status: "Error setting filled report status",
      error: error.message,
    });
  }
};

pubReportController.deletePublishedReport = async (req, res) => {
  try {
    const { reportId } = req.params;
    const { email } = req.query;
    const user = await User.findOne({
      email,
      isActive: true,
      activeRole: "Administrador",
    });
    if (!user) {
      return res
        .status(403)
        .json({ status: "User not found or isn't an active administrator" });
    }
    const publishedReport = await PubReport.findById(reportId);
    if (!publishedReport) {
      return res.status(404).json({ status: "Published Report not found" });
    }

    if (publishedReport.filled_reports.length > 0) {
      return res
        .status(401)
        .json({
          status: "Cannot delete a published report with filled reports",
        });
    }

    if (publishedReport.deadline < datetime_now()) {
      return res
        .status(400)
        .json({ status: "Cannot delete a published report from finished periods" });
    }

    const reportName = publishedReport.report?.name || 'Informe desconocido';
    
    await publishedReport.deleteOne()
    
    // Registrar en auditoría
    try {
      await AuditLogger.logDelete(
        user,
        'REPORT',
        `${reportName} (Publicado)`,
        reportId,
        `Eliminó el informe publicado "${reportName}"`,
        req
      );
    } catch (auditError) {
      console.error('Error logging audit:', auditError);
    }
    
    res.status(200).json({ status: "Published Report deleted" });
  } catch (error) {
    console.log(error);
    res.status(500).json({
      status: "Error deleting published report",
      error: error.message,
    });
  }
};

pubReportController.getHistory = async (req, res) => {
  try {
    const { reportId, dimensionId } = req.query;

    const publishedReport = await PubReport.findById(reportId)
      .where("filled_reports")
      .elemMatch({ dimension: dimensionId, status: { $ne: "En Borrador" } })
      .populate((path = "filled_reports.dimension"), (select = "name"))
      .exec();

    if (!publishedReport) {
      return res.status(404).json({ status: "Published Report not found" });
    }

    res.status(200).json(publishedReport.filled_reports);
  } catch (error) {
    console.log(error);
    res.status(500).json({
      status: "Error getting filled report",
      error: error.message,
    });
  }
};

module.exports = pubReportController;
