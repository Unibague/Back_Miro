const ProcessDocument = require('../models/processDocuments');
const Phase = require('../models/phases');
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
    if (actividad_id) {
      query.actividad_id = actividad_id;
      // Solo docs de esa subactividad o solo de la actividad (sin subactividad)
      query.subactividad_id = subactividad_id || null;
    } else {
      // Solo docs de nivel fase (sin actividad ni subactividad)
      query.actividad_id = null;
    }
    const docs = await ProcessDocument.find(query).sort({ createdAt: -1 });
    res.status(200).json(docs);
  } catch (error) {
    console.error('Error obteniendo documentos de fase:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
};

// GET /process-documents/by-process?process_id=...
// Incluye: PDF de resolución / docs de «información del caso» (process_id) y también
// todos los adjuntos de fases/actividades/subactividades (phase_id ∈ fases del proceso),
// porque POST /process-documents/:phaseId no guarda process_id.
processDocumentsController.getByProcess = async (req, res) => {
  try {
    const { process_id, caso_date_key } = req.query;
    if (!process_id) {
      return res.status(400).json({ error: 'process_id es requerido' });
    }
    if (caso_date_key) {
      const query = { process_id, caso_date_key };
      const docs = await ProcessDocument.find(query).sort({ createdAt: -1 });
      return res.status(200).json(docs);
    }

    const phaseIds = await Phase.find({ proceso_id: process_id }).distinct('_id');
    const or = [{ process_id }];
    if (phaseIds.length) {
      or.push({ phase_id: { $in: phaseIds } });
    }
    const docs = await ProcessDocument.find({ $or: or }).sort({ createdAt: -1 });
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

    const { actividad_id, subactividad_id, caso_date_key, process_id: bodyProcessId } = req.body;

    const cdk =
      caso_date_key && String(caso_date_key).trim() ? String(caso_date_key).trim() : null;
    let processId = bodyProcessId && String(bodyProcessId).trim() ? String(bodyProcessId).trim() : null;
    if (cdk && !processId) {
      const ph = await Phase.findById(phaseId).select('proceso_id').lean();
      if (ph && ph.proceso_id) processId = String(ph.proceso_id);
    }
    const destino = cdk ? 'Fechas/Procesos/InformacionCaso' : 'Fechas/Procesos/Fases';
    const fileData = await uploadFileToGoogleDrive(req.file, destino, req.file.originalname);

    const doc = await ProcessDocument.create({
      phase_id: phaseId,
      process_id: cdk && processId ? processId : null,
      actividad_id: actividad_id || null,
      subactividad_id: subactividad_id || null,
      caso_date_key: cdk || null,
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

    const { doc_type, caso_date_key } = req.body;
    const ds = String(doc_type || '');
    const dtRaw = ds === 'resolucion_rc_oficio' ? 'resolucion_rc_oficio' : ds === 'resolucion' ? 'resolucion' : 'proceso';
    const esResOderivado = dtRaw === 'resolucion' || dtRaw === 'resolucion_rc_oficio';
    const cdk = !esResOderivado && caso_date_key && String(caso_date_key).trim()
      ? String(caso_date_key).trim()
      : null;
    const destino = cdk ? 'Fechas/Procesos/InformacionCaso' : 'Fechas/Procesos/Resoluciones';
    const fileData = await uploadFileToGoogleDrive(req.file, destino, req.file.originalname);

    const doc = await ProcessDocument.create({
      phase_id: null,
      process_id: processId,
      doc_type: esResOderivado ? dtRaw : 'proceso',
      caso_date_key: cdk,
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

