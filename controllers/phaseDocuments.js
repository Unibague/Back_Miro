const ProcessDocument = require('../models/processDocuments');
const { uploadFileToGoogleDrive, deleteDriveFile } = require('../config/googleDrive');

const processDocumentsController = {};

// GET /process-documents?phase_id=...&actividad_id=...&subactividad_id=...
processDocumentsController.getByPhase = async (req, res) => {
  try {
    const { phase_id, actividad_id, subactividad_id } = req.query;
    if (!phase_id) {
      return res.status(400).json({ error: 'phase_id es requerido' });
    }
    const query = { phase_id };
    if (actividad_id)    query.actividad_id    = actividad_id;
    if (subactividad_id) query.subactividad_id = subactividad_id;
    const docs = await ProcessDocument.find(query).sort({ createdAt: -1 });
    res.status(200).json(docs);
  } catch (error) {
    console.error('Error obteniendo documentos de fase:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// GET /process-documents/by-process?process_id=...
processDocumentsController.getByProcess = async (req, res) => {
  try {
    const { process_id } = req.query;
    if (!process_id) {
      return res.status(400).json({ error: 'process_id es requerido' });
    }
    const docs = await ProcessDocument.find({ process_id }).sort({ createdAt: -1 });
    res.status(200).json(docs);
  } catch (error) {
    console.error('Error obteniendo documentos de proceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// POST /process-documents/:phaseId  (multipart/form-data con campo "file")
// Body puede incluir actividad_id y/o subactividad_id para asociar el doc a una actividad/subactividad
processDocumentsController.create = async (req, res) => {
  try {
    const { phaseId } = req.params;
    if (!phaseId) {
      return res.status(400).json({ error: 'phaseId es requerido' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No se adjuntó ningún archivo' });
    }

    const { actividad_id, subactividad_id } = req.body;

    const destino = 'Fechas/Procesos/Fases';
    const fileData = await uploadFileToGoogleDrive(req.file, destino, req.file.originalname);

    const doc = await ProcessDocument.create({
      phase_id: phaseId,
      actividad_id:    actividad_id    || null,
      subactividad_id: subactividad_id || null,
      name: fileData.name,
      drive_id: fileData.id,
      view_link: fileData.webViewLink,
      download_link: fileData.webContentLink,
      mime_type: req.file.mimetype,
      size: req.file.size,
    });

    res.status(201).json(doc);
  } catch (error) {
    console.error('Error creando documento de fase:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// POST /process-documents/process/:processId  (multipart/form-data con campo "file")
processDocumentsController.createForProcess = async (req, res) => {
  try {
    const { processId } = req.params;
    if (!processId) {
      return res.status(400).json({ error: 'processId es requerido' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No se adjuntó ningún archivo' });
    }

    const destino = 'Fechas/Procesos/Resoluciones';
    const fileData = await uploadFileToGoogleDrive(req.file, destino, req.file.originalname);

    const { doc_type } = req.body;

    const doc = await ProcessDocument.create({
      phase_id: null,
      process_id: processId,
      doc_type: doc_type === 'resolucion' ? 'resolucion' : 'proceso',
      name: fileData.name,
      drive_id: fileData.id,
      view_link: fileData.webViewLink,
      download_link: fileData.webContentLink,
      mime_type: req.file.mimetype,
      size: req.file.size,
    });

    res.status(201).json(doc);
  } catch (error) {
    console.error('Error creando documento de proceso:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// DELETE /process-documents/:id
processDocumentsController.remove = async (req, res) => {
  try {
    const { id } = req.params;
    const doc = await ProcessDocument.findByIdAndDelete(id);
    if (!doc) {
      return res.status(404).json({ error: 'Documento no encontrado' });
    }

    // Intentar borrar también en Drive (si falla, solo se loguea)
    if (doc.drive_id) {
      try {
        await deleteDriveFile(doc.drive_id);
      } catch (err) {
        console.error('Error eliminando archivo en Drive:', err);
      }
    }

    res.status(200).json({ message: 'Documento eliminado correctamente' });
  } catch (error) {
    console.error('Error eliminando documento de fase:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

module.exports = processDocumentsController;

