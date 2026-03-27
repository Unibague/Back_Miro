const ConfigurationAuditService = require('../services/configurationAudit');
const UserService = require('../services/users');

const configAuditController = {};

configAuditController.getTemplateAuditHistory = async (req, res) => {
  try {
    const { templateId } = req.params;
    const { page, limit } = req.query;
    
    const history = await ConfigurationAuditService.getAuditHistory(
      'template',
      templateId,
      { page: parseInt(page) || 1, limit: parseInt(limit) || 20 }
    );
    
    res.status(200).json(history);
  } catch (error) {
    console.error('Error obteniendo historial de plantilla:', error);
    res.status(500).json({ error: error.message });
  }
};

configAuditController.getReportAuditHistory = async (req, res) => {
  try {
    const { reportId } = req.params;
    const { page, limit } = req.query;
    
    const history = await ConfigurationAuditService.getAuditHistory(
      'report',
      reportId,
      { page: parseInt(page) || 1, limit: parseInt(limit) || 20 }
    );
    
    res.status(200).json(history);
  } catch (error) {
    console.error('Error obteniendo historial de informe:', error);
    res.status(500).json({ error: error.message });
  }
};

configAuditController.getProducerReportAuditHistory = async (req, res) => {
  try {
    const { reportId } = req.params;
    const { page, limit } = req.query;
    
    const history = await ConfigurationAuditService.getAuditHistory(
      'producerReport',
      reportId,
      { page: parseInt(page) || 1, limit: parseInt(limit) || 20 }
    );
    
    res.status(200).json(history);
  } catch (error) {
    console.error('Error obteniendo historial de informe de productor:', error);
    res.status(500).json({ error: error.message });
  }
};

configAuditController.getUserAuditHistory = async (req, res) => {
  try {
    const { email } = req.params;
    const { page, limit } = req.query;
    
    await UserService.findUserByEmail(email);
    
    const history = await ConfigurationAuditService.getUserAuditHistory(
      email,
      { page: parseInt(page) || 1, limit: parseInt(limit) || 20 }
    );
    
    res.status(200).json(history);
  } catch (error) {
    console.error('Error obteniendo historial de usuario:', error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = configAuditController;
