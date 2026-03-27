const fs = require("fs");
const { uploadFileToGoogleDrive, updateFileInGoogleDrive } = require("../config/googleDrive");
const mongoose = require("mongoose");
const { ObjectId } = mongoose.Types;
const Report = require("../models/reports");
const User = require("../models/users");
const Period = require("../models/periods");
const PubReport = require("../models/publishedReports");
const UserService = require("../services/users");
const AuditLogger = require('../services/auditLogger');

const datetime_now = () => {
  const now = new Date();

  const offset = -5; // GMT-5
  const dateWithOffset = new Date(now.getTime() + offset * 60 * 60 * 1000);

  return new Date(dateWithOffset.setMilliseconds(now.getMilliseconds()));
};

const reportController = {};

reportController.getReport = async (req, res) => {
  try {
    const { email } = req.query;
    const { id } = req.params;

    // Verificar si el usuario es un administrador activo
    await UserService.findUserByEmailAndRole(email, "Administrador");

    // Obtener el informe
    const report = await Report.findById(id)
      .populate('dimensions');
    
    res.status(200).json(report);
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: "Error getting report", error: error.message });
  }
}

reportController.getReports = async (req, res) => {
  try {
    const { email, page = 1, limit = 10, search = "" } = req.query;

    // Verificar si el usuario es un administrador activo
    const user = await User.findOne({ email, activeRole: "Administrador" });
    if (!user) {
      return res
        .status(403)
        .json({ status: "User not found or isn't an Administrator" });
    }

    // Convertir los parámetros a números y calcular el salto de documentos
    const pageNumber = parseInt(page, 10);
    const pageSize = parseInt(limit, 10);
    const skip = (pageNumber - 1) * pageSize;

    // Crear el filtro de búsqueda, buscando en todas las columnas relevantes
    const searchQuery = search
      ? {
          $or: [
            { name: { $regex: search, $options: "i" } }, // 'i' para insensible a mayúsculas
            { description: { $regex: search, $options: "i" } },
            { "created_by.email": { $regex: search, $options: "i" } }, // Búsqueda en el email del creador
          ],
        }
      : {};

    // Obtener los reportes con el filtro de búsqueda y paginación
    const reports = await Report.find(searchQuery).skip(skip).limit(pageSize);

    // Obtener el total de documentos que coinciden con la búsqueda
    const totalReports = await Report.countDocuments(searchQuery);
    const totalPages = Math.ceil(totalReports / pageSize);

    res.status(200).json({
      reports,
      currentPage: pageNumber,
      totalPages,
      totalReports,
    });
  } catch (error) {
    console.log(error);
    res
      .status(500)
      .json({ status: "Error getting reports", error: error.message });
  }
};

reportController.createReport = async (req, res) => {
  const session = await mongoose.startSession(); // Inicia una sesión de MongoDB
  session.startTransaction(); // Inicia una transacción

  try {
    const { email } = req.body;
    const { name, description, requires_attachment, file_name, dimensions } = req.body;

    const invalidFileNameChars = /[<>:"/\\|?*]/;
    if (invalidFileNameChars.test(req.body.file_name)) {
    return res.status(400).json({
      error: "El nombre del archivo contiene caracteres no permitidos: <>:\"/\\|?*"
    });
  }
    
    const user = await User.findOne({ email, activeRole: "Administrador" }).session(session); // Incluir la sesión en las consultas

    if (!user || user.activeRole !== "Administrador") {
      await session.abortTransaction(); // Aborta la transacción si falla
      session.endSession();
      return res
        .status(403)
        .json({ status: "User not found or isn't an Administrator" });
    }

    if (!req.file) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ status: "No file attached" });
    }

    // Crea el informe, dentro de la sesión
    const newReport = new Report({
      name,
      description,
      requires_attachment,
      file_name,
      created_by: user,
      dimensions
    });

    // Guarda el informe en la base de datos dentro de la transacción
    await newReport.save({ session });

    // Define la ruta en Google Drive y sube el archivo
    const destinationPath = `Formatos/Informes/Dimensiones`;
    const fileData = await uploadFileToGoogleDrive(
      req.file,
      destinationPath,
      file_name
    );

    // Actualiza el informe con la información del archivo subido
    newReport.report_example_id = fileData.id;
    newReport.report_example_link = fileData.webViewLink;
    newReport.report_example_download = fileData.webContentLink;

    // Guarda los cambios en el informe, también dentro de la transacción
    await newReport.save({ session });

    // Registrar en auditoría
    try {
      await AuditLogger.logCreate(
        user,
        'REPORT',
        newReport.name,
        newReport._id.toString(),
        `Creó el informe de ámbito "${newReport.name}" (${newReport.file_name})`,
        req
      );
    } catch (auditError) {
      console.error('Error logging audit:', auditError);
    }

    // Confirma la transacción solo si todo fue exitoso
    await session.commitTransaction();
    session.endSession();

    // Elimina el archivo local después de la subida exitosa
    fs.unlinkSync(req.file.path);

    res.status(201).json({ status: "Report created" });
  } catch (error) {
    console.log(error);

    // Aborta la transacción en caso de error y revierte los cambios
    await session.abortTransaction();
    session.endSession();

    // En caso de error, elimina el archivo si existe
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }

    res
      .status(500)
      .json({ status: "Error creating report", error: error.message });
  }
};


reportController.updateReport = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;
    const { email, name, description, requires_attachment, file_name, dimensions } = req.body;
    const nowDate = datetime_now().toDateString();
    const pubReportsToUpdate = []
 
    const invalidFileNameChars = /[<>:"/\\|?*]/;
    if (invalidFileNameChars.test(req.body.file_name)) {
    return res.status(400).json({
      error: "El nombre del archivo contiene caracteres no permitidos: <>:\"/\\|?*"
    });
  }
    
    await UserService.findUserByEmailAndRole(email, "Administrador", session);

    const report = await Report.findById(id).session(session);
    if (!report) {
      throw new Error("Report not found");
    }

    // Buscar periodos activos
    const periods = await Period.find({
      responsible_start_date: { $lte: nowDate },
      responsible_end_date: { $gte: nowDate }
    }).session(session);

    if (periods.length > 0) {
      const publishedReportsRelated = await PubReport.find({
        'report._id': new ObjectId(id),
        period: { $in: periods.map(period => period._id) }
      }).session(session);

      for (const pubReport of publishedReportsRelated) {
        if (pubReport.filled_reports.length > 0) {
          res.status(401).json({ message: "Cannot update this report because it is already filled in a published report" });
          return
        }
        pubReportsToUpdate.push(pubReport)
      }
    }

    if (req.file) {
      const fileData = await updateFileInGoogleDrive(report.report_example_id, req.file, file_name);

      // Actualiza los campos relacionados con el archivo
      report.report_example_id = fileData.id;
      report.report_example_link = fileData.webViewLink;
      report.report_example_download = fileData.webContentLink;

      // Eliminar archivo local
      fs.unlinkSync(req.file.path);
    }

    // Actualiza los campos del informe
    report.name = name;
    report.description = description;
    report.requires_attachment = requires_attachment;
    report.file_name = file_name;
    report.dimensions = dimensions;

    await report.save({ session });

    for (const pubReport of pubReportsToUpdate) {
      pubReport.report = report;
      await pubReport.save({ session });
    }
    
    // Registrar en auditoría
    try {
      const user = await User.findOne({ email });
      if (user) {
        await AuditLogger.logUpdate(
          user,
          'REPORT',
          report.name,
          id,
          `Actualizó el informe de ámbito "${report.name}" (${report.file_name})`,
          req
        );
      }
    } catch (auditError) {
      console.error('Error logging audit:', auditError);
    }

    await session.commitTransaction();
    res.status(200).json({ status: "Report updated successfully" });
  } catch (error) {
    await session.abortTransaction();
    if (req.file) {
      fs.unlinkSync(req.file.path);
    }
    if(error.status === 401) {
      res.status(401).json({ message: error.message });
    }
  } finally {
    session.endSession();
  }
};

reportController.deleteReport = async (req, res) => {

  try {
    const { id } = req.params;
    const { email } = req.query;
    const nowDate = datetime_now().toDateString();
    const pubReportsToDelete = []

    // Buscar el informe antes de eliminarlo
    const report = await Report.findById(id);
    if (!report) {
      return res.status(404).json({ status: "Report not found" });
    }
    
    const reportName = report.name;
    const reportFileName = report.file_name;
    
    await Report.findByIdAndDelete(id);
    
    // Registrar en auditoría
    try {
      const userEmail = email || 'user'; // Temporal
      const user = await User.findOne({ email: userEmail });
      if (user) {
        await AuditLogger.logDelete(
          user,
          'REPORT',
          reportName,
          id,
          `Eliminó el informe de ámbito "${reportName}" (${reportFileName})`,
          req
        );
      }
    } catch (auditError) {
      console.error('Error logging audit:', auditError);
    }

    res.status(200).json({ status: "Report deleted" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: "Error deleting report", error: error.message });
  }
}


module.exports = reportController;
