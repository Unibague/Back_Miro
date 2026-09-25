const PQR = require('../models/pqr');
const { parseWorkbook, classifyRows } = require('../services/pqrImport');
const Program = require('../models/programs');

const pqrController = {};

async function readImport(req, res) {
  try { return await parseWorkbook(req.file.buffer); }
  catch (error) {
    res.status(400).json({ error: error.message.startsWith('El archivo') || error.message.startsWith('Importa') || error.message.startsWith('No se encontraron')
      ? error.message : 'No se pudo leer el Excel. Verifica que sea un archivo .xlsx válido.' });
    return null;
  }
}

pqrController.previewImport = async (req, res) => {
  const parsed = await readImport(req, res);
  if (!parsed) return;
  try {
    const existing = await PQR.find({}).lean();
    res.json(classifyRows(parsed, existing));
  } catch { res.status(500).json({ error: 'No se pudieron consultar las coincidencias de PQR.' }); }
};

pqrController.importExcel = async (req, res) => {
  const parsed = await readImport(req, res);
  if (!parsed) return;
  let selected;
  try {
    selected = JSON.parse(req.body.seleccion || 'null');
    if (!Array.isArray(selected) || !selected.length || selected.length > 2000 || selected.some(item => !item || typeof item.key !== 'string' || !parsed.rows.some(row => row.key === item.key) || (item.programa_id != null && !/^[a-f0-9]{24}$/i.test(item.programa_id)))) throw new Error();
  } catch { return res.status(400).json({ error: 'Selecciona al menos un PQR válido de la vista previa.' }); }
  try {
    const programIds = [...new Set(selected.map(item => item.programa_id).filter(Boolean))];
    if (programIds.length && await Program.countDocuments({ _id: { $in: programIds } }) !== programIds.length) return res.status(400).json({ error: 'Uno de los programas seleccionados ya no existe. Revisa la selección.' });
    // The unique index makes repeat/concurrent imports of the same PQR idempotent.
    await PQR.init();
    const preview = classifyRows(parsed, await PQR.find({}).lean());
    const result = { creados: 0, omitidos: 0, errores: [], pqrs: [] };
    for (const row of preview.rows.filter(item => selected.some(selection => selection.key === item.key))) {
      if (row.accion === 'existente') { result.omitidos++; continue; }
      if (row.accion === 'error') { result.errores.push({ filas: row.filas, error: row.errors.join(' ') }); continue; }
      try {
        const now = new Date();
        const doc = { ...row.data, programa_id: selected.find(item => item.key === row.key).programa_id || null, importacion_clave: row.key, cerrado: false, createdAt: now, updatedAt: now };
        const write = await PQR.updateOne({ importacion_clave: row.key }, { $setOnInsert: doc }, { upsert: true, runValidators: true, timestamps: false });
        if (write.upsertedCount) {
          result.creados++;
          result.pqrs.push(await PQR.findById(write.upsertedId).lean());
        } else result.omitidos++;
      } catch (error) {
        if (error.code === 11000) result.omitidos++;
        else result.errores.push({ filas: row.filas, error: 'No se pudo guardar este PQR. Puedes reintentar la importación.' });
      }
    }
    res.json(result);
  } catch { res.status(500).json({ error: 'No se pudo importar. Reintenta; los PQR ya guardados se omitirán.' }); }
};

/* GET /pqr?cerrado=false&programa_id=xxx */
pqrController.getAll = async (req, res) => {
  try {
    const filter = {};
    if (req.query.cerrado !== undefined) filter.cerrado = req.query.cerrado === 'true';
    if (req.query.programa_id) filter.programa_id = req.query.programa_id;
    const pqrs = await PQR.find(filter).sort({ createdAt: -1 });
    res.status(200).json(pqrs);
  } catch { res.status(500).json({ error: 'Error interno' }); }
};

/* POST /pqr */
pqrController.create = async (req, res) => {
  try {
    const { nombre_solicitud, programa_id, cedula_encargado } = req.body;
    if (!nombre_solicitud) return res.status(400).json({ error: 'nombre_solicitud es requerido' });
    const ced = typeof cedula_encargado === "string" ? cedula_encargado.trim() || null : cedula_encargado || null;
    const pqr = await PQR.create({
      nombre_solicitud,
      programa_id: programa_id || null,
      cedula_encargado: ced,
    });
    res.status(201).json(pqr);
  } catch { res.status(500).json({ error: 'Error interno' }); }
};

/* PUT /pqr/:id */
pqrController.update = async (req, res) => {
  try {
    const pqr = await PQR.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!pqr) return res.status(404).json({ error: 'PQR no encontrado' });
    res.status(200).json(pqr);
  } catch { res.status(500).json({ error: 'Error interno' }); }
};

/* PUT /pqr/:id/cerrar */
pqrController.cerrar = async (req, res) => {
  try {
    const pqr = await PQR.findByIdAndUpdate(req.params.id, { cerrado: true }, { new: true });
    if (!pqr) return res.status(404).json({ error: 'PQR no encontrado' });
    res.status(200).json(pqr);
  } catch { res.status(500).json({ error: 'Error interno' }); }
};

/* DELETE /pqr/:id */
pqrController.remove = async (req, res) => {
  try {
    await PQR.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: 'PQR eliminado' });
  } catch { res.status(500).json({ error: 'Error interno' }); }
};

module.exports = pqrController;
