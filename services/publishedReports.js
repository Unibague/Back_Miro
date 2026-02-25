const { uploadFileToGoogleDrive, uploadFilesToGoogleDrive, deleteDriveFile, deleteDriveFiles, moveDriveFolder } = require("../config/googleDrive");
const Dimension = require("../models/dimensions");
const PubReport = require("../models/publishedReports");
const UserService = require("./users");
const mongoose = require('mongoose');

class PublishedReportService {
static async findPublishedReportById(id, email, dimensionId, session) {

  console.log(dimensionId);

  // Asegurarse de que dimensionId sea un ObjectId
  const dimensionObjectId = new mongoose.Types.ObjectId(dimensionId);

  const pubReport = await PubReport
    .findById(id)
    .populate("period")
    .populate({
      path: "report.dimensions",
      select: "name responsible",
      model: "dimensions"
    })
    .populate({
      path: "filled_reports.dimension",
      select: "name responsible",
      model: "dimensions"
    })
    .session(session);

  if (!pubReport) {
    throw new Error("Report not found.");
  }

  console.log(dimensionId)

  // Filtrar por la dimensión específica
  pubReport.report.dimensions = pubReport.report.dimensions.filter((dimension) =>
    dimension._id.equals(dimensionObjectId)
  );

  pubReport.filled_reports = pubReport.filled_reports.filter((filledReport) =>
    filledReport.dimension?._id?.equals(dimensionObjectId)
  );

  if (pubReport.report.dimensions.length === 0) {
    throw new Error("Dimension not found in this report.");
  }

  return pubReport;
}

  static async findPublishedReports(session) {
    return await PubReport.find().session(session);
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
    const fullReport = await PubReport.findById(pubReport._id).session(session);
    if(draft) {
      const updatedDraft = await this.updateDraftFiles(draft, reportFile, attachments, deletedReport, deletedAttachments, path);
      const existingReport = pubReport.filled_reports.id(filledRepId);
      const updatedReport = Object.assign(
        existingReport, updatedDraft, { status_date: nowDate }
      );
      fullReport.filled_reports.id(filledRepId).set(updatedReport);
    } else {
      const newDraft = await this.uploadDraftFiles(reportFile, attachments, path);
      newDraft.dimension = pubReport.report.dimensions[0];
      newDraft.send_by = user;
      newDraft.loaded_date = nowDate
      newDraft.status_date = nowDate
      fullReport.filled_reports.unshift(newDraft);
    }
    await fullReport.save({ session });
  }

  static async sendResponsibleReportDraft(email, publishedReportId, filledDraftId, nowtime, session) {
    const user = await UserService.findUserByEmailAndRole(email, "Responsable");
    const pubRep = await PubReport.findById(publishedReportId)
      .populate('filled_reports.dimension')
      .populate('period')
      .session(session);
    const draft = await this.findDraftById(pubRep, filledDraftId);

    console.log(filledDraftId)


    const ancestorId = await moveDriveFolder(draft.report_file.folder_id,
      `${pubRep.period.name}/Informes/ vos/${pubRep.report.name}/${draft.dimension.name}/${nowtime.toISOString()}`);

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