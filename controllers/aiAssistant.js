const aiAssistantService = require('../services/aiAssistant');

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

module.exports = aiAssistantController;
