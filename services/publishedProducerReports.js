const { uploadFileToGoogleDrive, uploadFilesToGoogleDrive, deleteDriveFile, deleteDriveFiles, moveDriveFolder } = require("../config/googleDrive");
const PubReport = require("../models/publishedProducerReports");
const Dependency = require("../models/dependencies");
const UserService = require("./users");
const ProducerReport = require("../models/producerReports");


class PublishedReportService {
  static async findPublishedReportById(id, session) {
    const pubReport = await PubReport
    .findById(id)
    .populate("period")
    .populate({
      path: "report.producers",
      select: "name responsible",
      model: "dependencies",
    })
    .populate({
      path: "report.dimensions",
      select: "name",
      model: "dependencies",
    })
    .populate({
      path: "filled_reports.dependency",
      select: "name responsible",
      populate: {
        path: "responsible",
        select: "name email",
      },
    })
    .session(session);

    if (pubReport?.filled_reports) {
      const filteredReports = Object.values(
        pubReport.filled_reports.reduce((acc, report) => {
          const depId = report.dependency._id.toString();
          if (!acc[depId] || new Date(report.date) > new Date(acc[depId].date)) {
            acc[depId] = report;
          }
          return acc;
        }, {})
      );
      pubReport.filled_reports = filteredReports;
    }

    if(!pubReport) {
      throw new Error("Report not found.");
    }

    await this.hydrateReportExample(pubReport);
return pubReport;
  }

  static async hydrateReportExample(pubReport) {
  if (!pubReport?.report?._id) return;

  const base = await ProducerReport.findById(pubReport.report._id)
    .select("report_example")
    .lean();

  if (base?.report_example) {
    pubReport.report.report_example = base.report_example;
  }
}


static async findPublishedReports(user, page = 1, limit = 10, search = "", periodId, session) {
  const skip = (page - 1) * limit;
  let query = {
    ...(search && { "report.name": { $regex: search, $options: "i" } }),
    ...(periodId && { period: periodId }),
  };

  console.log('=== DEBUG findPublishedReports ===');
  console.log('User email:', user.email);
  console.log('User activeRole:', user.activeRole);
  console.log('Query:', query);

  let reports;

  if (user.activeRole === "Responsable") {
    console.log('Filtering for Responsable role');
    // Traemos todos los reportes
    reports = await PubReport.find(query)
      .populate({
        path: 'report.dimensions',
        model: 'dimensions',
        populate: {
          path: 'responsible',
          model: 'dependencies'
        }
      })
      .populate('period')
      .session(session);

    console.log('Total reports before filter:', reports.length);
    
    // Filtramos por dimensiones donde el usuario es visualizer
    reports = reports.filter(report =>
      report.report.dimensions.some(d => 
        d.responsible && d.responsible.visualizers && d.responsible.visualizers.includes(user.email)
      )
    );
    
    console.log('Reports after visualizer filter:', reports.length);
  } else {
    console.log('Loading all reports for Administrador');
    // Administrador: todos los reportes
    reports = await PubReport.find(query)
      .populate({
        path: 'period',
        select: 'name producer_report_start_date producer_report_end_date producer_end_date'
      })
      .populate({
        path: 'report.producers',
        model: 'dependencies',
        select: 'name'
      })
      .session(session);
    
    console.log('Total reports for admin:', reports.length);
  }

  // Filtrado de filled_reports (en todos los casos)
  reports.forEach((report) => {
    report.filled_reports = report.filled_reports.filter(
      (fr) => fr.status !== "En Borrador"
    );

    report.filled_reports.sort((a, b) => new Date(b.date) - new Date(a.date));

    const uniqueFilledReports = [];
    const seenDependencies = new Set();

    report.filled_reports.forEach((fr) => {
      if (!seenDependencies.has(fr.dependency.toString())) {
        uniqueFilledReports.push(fr);
        seenDependencies.add(fr.dependency.toString());
      }
    });

    report.filled_reports = uniqueFilledReports;
  });

  const totalReports = reports.length;
  const paginatedReports = reports.slice(skip, skip + limit);

  for (const report of paginatedReports) {
    await this.hydrateReportExample(report);
  }

  console.log('Returning:', {
    total: totalReports,
    page,
    reportsInPage: paginatedReports.length
  });

  return {
    page,
    limit,
    total: totalReports,
    totalPages: Math.ceil(totalReports / limit),
    publishedReports: paginatedReports,
  };
}


static async findPublishedReportsProducer(user, _, __, search = "", periodId, dimensionId, session) {

  
  const query = {
    ...(search && { "report.name": { $regex: search, $options: "i" } }),
    ...(periodId && { period: periodId }),
    ...(dimensionId && { "report.dimensions": dimensionId }),
  };
  
  console.log('Query:', JSON.stringify(query));

  let reports = await PubReport.find(query)
    .populate({
      path: 'report.dimensions',
      model: 'dimensions',
    })
    .populate('period')
    .populate({
      path: 'report.producers',
      model: 'dependencies',
      select: 'name',
      match: { members: user.email }
    })
    .populate({
      path: 'filled_reports.dependency',
      select: 'name responsible',
      match: { members: user.email }
    })
    .session(session);

  // Filtrar los que realmente tienen al menos un productor válido para este usuario
  reports = reports.filter(report =>
    report.report.producers.some(dep => dep !== null)
  );

  // Filtrar los filled_reports válidos
  reports.forEach(report => {
    report.filled_reports = report.filled_reports.filter(fr => fr.dependency !== null);
  });

  // Separar pendientes y entregados
  const pending = reports.filter(
    rep => !rep.filled_reports.length || rep.filled_reports[0].status === "Pendiente"
  );

  const completed = reports.filter(
    rep => rep.filled_reports.length && rep.filled_reports[0].status !== "Pendiente"
  );

  for (const report of pending) {
  await this.hydrateReportExample(report);
}

for (const report of completed) {
  await this.hydrateReportExample(report);
}


  return {
    pendingReports: pending,
    completedReports: completed,
    totalPending: pending.length,
  };
}


static async findPublishedReportProducer(user, id, session) {
  const report = await PubReport
    .findById(id)
    .populate("period")
    .populate("report.dimensions")
    .populate("filled_reports.dependency")
    .populate("report.producers")

if (!report) return null;

await this.hydrateReportExample(report);
return report;

}


  static async findDraft(publishedReport) {
    return publishedReport.filled_reports.find(
      (filledReport) => filledReport.status === "En Borrador"
    );
  }

  static async publishReport(report, periodId, deadline, session) {
    try {
      const pubReport = new PubReport({
        period: periodId,
        report,
        deadline
      });

      await pubReport.save({ session });
    } catch (error) {
      console.error('Error publishing report:', error);
      throw new Error('Internal Server Error');
    }
  }
  
  static async findDraft(publishedReport) {
    return publishedReport.filled_reports.find(
      (filledReport) => filledReport.status === "En Borrador"
    );
  }

  static async findDraftById(publishedReport, filledRepId) {
    return publishedReport.filled_reports.id(filledRepId);
  }

  static async uploadReportAndAttachments(reportFile, attachments, path) {
    return Promise.all([
      reportFile ? uploadFileToGoogleDrive(reportFile, path, reportFile.originalname) : Promise.resolve({}),
      attachments.length > 0 ? uploadFilesToGoogleDrive(attachments, path) : Promise.resolve([])
    ]);
  }
  
  static mapFileData(fileHandle) {
    return {
      id: fileHandle?.id,
      name: fileHandle?.name,
      view_link: fileHandle?.webViewLink,
      download_link: fileHandle?.webContentLink,
      folder_id: fileHandle?.parents ? fileHandle.parents[0] : undefined,
      description: fileHandle?.description
    };
  }

  static async uploadDraftFiles(reportFile, attachments, path) {
    const [reportFileData, attachmentsData] = await this.uploadReportAndAttachments(reportFile, attachments, path);
    reportFileData
    return {
      report_file: reportFile ? this.mapFileData(reportFileData) : undefined,
      attachments: attachmentsData.map(this.mapFileData),
      folder_id: reportFileData.folder_id ? reportFileData.folder_id : attachmentsData[0]?.folder_id
    };
  }

  static async updateDraftFiles(draft, reportFile, attachments, deletedReport, deletedAttachments, path) {
    const [reportFileData, attachmentsData] = await this.uploadReportAndAttachments(reportFile, attachments, path);
    draft.attachments.push(...attachmentsData.map(this.mapFileData))
    if(deletedReport) {
      await deleteDriveFile(deletedReport);
      draft.report_file = undefined
    }
    if(deletedAttachments) {
      await deleteDriveFiles(deletedAttachments);
      draft.attachments = draft.attachments.filter((attachment) => !deletedAttachments.includes(attachment.id));
    }
    if(reportFile) {
      draft.report_file = this.mapFileData(reportFileData);
    }
    return draft;
  }

  static async upsertReportDraft(
    pubReport, filledRepId, reportFile, attachments, deletedReport, deletedAttachments, nowDate, 
    path, user, session
  ) {
    const draft = await this.findDraft(pubReport, filledRepId);
    const fullPubReport = await PubReport.findById(pubReport._id).session(session);
    if(draft) {
      const updatedDraft = await this.updateDraftFiles(draft, reportFile, attachments, deletedReport, deletedAttachments, path);
      const existingReport = pubReport.filled_reports.id(filledRepId);
      const updatedReport = Object.assign(
        existingReport, updatedDraft, { status_date: nowDate }
      );
      fullPubReport.filled_reports.id(filledRepId).set(updatedReport);
    } else {
      const newDraft = await this.uploadDraftFiles(reportFile, attachments, path);
      newDraft.dependency = pubReport.report.producers[0];
      newDraft.send_by = user;
      newDraft.loaded_date = nowDate
      newDraft.status_date = nowDate
      fullPubReport.filled_reports.unshift(newDraft);
    }
    await fullPubReport.save({ session });
  }

  static async sendProductorReportDraft(email, publishedReportId, filledDraftId, nowtime, session) {
    const user = await UserService.findUserByEmailAndRole(email, "Productor");
    const pubRep = await PubReport.findById(publishedReportId)
      .populate('filled_reports.dependency')
      .populate('period')
      .session(session);
    const draft = await this.findDraftById(pubRep, filledDraftId);

    const nowdate = new Date(nowtime.toDateString());
    const pubRepDeadlineDate = new Date(pubRep.deadline.toDateString());
    const pubRepStartDate = new Date(pubRep.period.producer_start_date.toDateString());
    if(pubRepDeadlineDate < nowdate || pubRepStartDate > nowdate) {
      throw new Error("The report period is already closed");
    }

    const ancestorId = await moveDriveFolder(draft.report_file.folder_id,
      `${pubRep.period.name}/Informes/Productores/Definitivos/${pubRep.report.name}/${draft.dependency.name}/${nowtime.toISOString()}`);

    if (!draft.report_file) {
      throw new Error("Draft must have a report file.");
    }

    if (pubRep.report.requires_attachment && 
      (!draft.attachments || draft.attachments.length === 0)) {
      throw new Error("Draft must have at least one attachment.");
    }

    draft.attachments.forEach((attachment) => {
      if (!attachment.description || attachment.description.trim() === "") {
      throw new Error("Each attachment must have a non-empty description.");
      }
    });

    draft.status = "En Revisión";
    draft.loaded_date = nowtime;
    draft.send_by = user;

    if(!pubRep.folder_id) {
      pubRep.folder_id = ancestorId;
    }

    await pubRep.save({ session });
  }

}

module.exports = PublishedReportService;