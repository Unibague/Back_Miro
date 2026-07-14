/**
 * Recalcula avance/avance_actual/avance_total_real/avances_por_anio de TODOS
 * los indicadores y cascada (Acción -> Proyecto -> Macroproyecto) usando el
 * endpoint existente ctrl.recalcularTodos, sin duplicar su lógica.
 *
 * Se ejecuta una vez tras el cambio de metodología para "Último valor
 * reportado": ahora ese tipo también referencia la Meta final 2029 en vez de
 * la meta del periodo. Los tipos Acumulado/Promedio no cambian de fórmula,
 * así que recalcularlos es idempotente.
 *
 * Uso: node scripts/recalcularTodosIndicadores.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
    await mongoose.connect(process.env.DB_URI);
    console.log('Conectado a MongoDB:', process.env.DB_URI);

    const ctrl = require('../controllers/pdiIndicador');

    const result = await new Promise((resolve, reject) => {
        const res = {
            json: (body) => resolve(body),
            status: (code) => ({ json: (body) => reject(Object.assign(new Error(body?.error || `HTTP ${code}`), { body })) }),
        };
        ctrl.recalcularTodos({}, res).catch(reject);
    });

    console.log(result.message);
    await mongoose.disconnect();
}

main().catch((err) => {
    console.error('Error en recalculación:', err);
    process.exit(1);
});
