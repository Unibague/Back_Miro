/**
 * Configuración centralizada de email
 * Valida y proporciona las credenciales SMTP correctas
 */

const getEmailConfig = (type = 'general') => {
  const configs = {
    general: {
      host: process.env.EMAIL_HOST || 'smtp.gmail.com',
      port: Number(process.env.EMAIL_PORT || 587),
      username: process.env.EMAIL_USERNAME,
      password: process.env.EMAIL_PASSWORD,
      fromName: process.env.MAIL_FROM_NAME || 'Sistema Miró',
      fromAddress: process.env.MAIL_FROM_ADDRESS,
    },
    pdi: {
      host: process.env.PDI_EMAIL_HOST || 'smtp.gmail.com',
      port: Number(process.env.PDI_EMAIL_PORT || 587),
      username: process.env.PDI_EMAIL_USERNAME,
      password: process.env.PDI_EMAIL_PASSWORD,
      fromName: process.env.PDI_MAIL_FROM_NAME || 'Gestión PDI',
      fromAddress: process.env.PDI_MAIL_FROM_ADDRESS,
    }
  };

  const config = configs[type] || configs.general;

  // Validar que las credenciales estén presentes
  if (!config.username || !config.password) {
    throw new Error(`Credenciales de email incompletas para tipo: ${type}. Verifica EMAIL_USERNAME y EMAIL_PASSWORD en .env`);
  }

  return config;
};

module.exports = { getEmailConfig };
