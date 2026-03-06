const aiAssistantService = require('../services/aiAssistant');
const documentGenerator = require('../services/documentGenerator');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const upload = multer({ dest: 'uploads/temp/' });

const aiAssistantController = {};

// Chat con el asistente
aiAssistantController.chat = async (req, res) => {
  try {
    const { message, history } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const response = await aiAssistantService.chat(message, history || []);
    
    if (!response.success) {
      return res.status(503).json(response);
    }

    res.status(200).json(response);
  } catch (error) {
    console.error('Error in AI chat:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Analizar documento
aiAssistantController.analyzeDocument = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { question, analysisType = 'summary' } = req.body;
    const filePath = req.file.path;
    const mimeType = req.file.mimetype;
    const fileName = req.file.originalname;

    // Construir prompt según tipo de análisis
    let customQuestion = question;
    if (!customQuestion) {
      switch (analysisType) {
        case 'summary':
          customQuestion = 'Resume los puntos principales de este documento';
          break;
        case 'extract':
          customQuestion = 'Extrae los datos más importantes (fechas, números, nombres)';
          break;
        case 'validate':
          customQuestion = 'Valida si este documento cumple con los requisitos de acreditación';
          break;
        default:
          customQuestion = null;
      }
    }

    const result = await aiAssistantService.analyzeDocument(filePath, mimeType, customQuestion);
    
    // Eliminar archivo temporal
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.status(200).json({
      ...result,
      fileName,
      analysisType
    });
  } catch (error) {
    console.error('Error analyzing document:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Generar documento Word con IA
aiAssistantController.generateWord = async (req, res) => {
  try {
    const { prompt } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    
    const result = await documentGenerator.generateWordFromPrompt(prompt);
    
    if (!result.success) {
      return res.status(400).json(result);
    }
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="documento-generado.docx"');
    res.send(result.buffer);
  } catch (error) {
    console.error('Error generating Word:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Generar Excel con IA
aiAssistantController.generateExcel = async (req, res) => {
  try {
    const { prompt } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    
    const result = await documentGenerator.generateExcelFromPrompt(prompt);
    
    if (!result.success) {
      return res.status(400).json(result);
    }
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="datos-generados.xlsx"');
    res.send(result.buffer);
  } catch (error) {
    console.error('Error generating Excel:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

aiAssistantController.upload = upload;

// Verificar estado del servicio
aiAssistantController.health = async (req, res) => {
  try {
    const health = await aiAssistantService.checkHealth();
    res.status(200).json(health);
  } catch (error) {
    console.error('Error checking AI health:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Generar PDF con IA
aiAssistantController.generatePDF = async (req, res) => {
  try {
    const { prompt } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    
    const result = await documentGenerator.generatePDFFromPrompt(prompt);
    
    if (!result.success) {
      return res.status(400).json(result);
    }
    
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="documento-generado.pdf"');
    res.send(result.buffer);
  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};


module.exports = aiAssistantController;
