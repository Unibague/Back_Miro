/**
 * cronBuzonMen.js
 *
 * Envío automático del Buzón MEN, todos los días a las 7:00 a. m.:
 * 15 días antes de la fecha de inicio de cada proceso RC/AV avisa al
 * administrador, y el día de inicio envía las fechas al programa y su línea.
 */

const cron = require('node-cron');
const { ejecutarAutomatico } = require('../services/menMailbox');

function iniciarCronBuzonMen() {
  cron.schedule('0 7 * * *', async () => {
    try {
      const resumen = await ejecutarAutomatico();
      console.log(`[cronBuzonMen] ${new Date().toISOString()} — avisos admin: ${resumen.avisos_admin}, programas: ${resumen.avisos_programa}`
        + (resumen.omitidos.length ? `, omitidos: ${resumen.omitidos.join(' | ')}` : ''));
    } catch (e) {
      console.error('[cronBuzonMen] Error:', e.message);
    }
  });
  console.log('[cronBuzonMen] Programado — corre diariamente a las 7:00 a. m. (hora local del servidor).');
}

module.exports = { iniciarCronBuzonMen };
