const PdiConfig = require('../models/pdiConfig');
const { SINGLETON_ID } = require('../models/pdiConfig');

// Garantiza que exista el documento singleton y lo devuelve
async function getOrCreate() {
    let doc = await PdiConfig.findById(SINGLETON_ID);
    if (!doc) {
        doc = await PdiConfig.create({ _id: SINGLETON_ID });
    }
    return doc;
}

const ctrl = {};

// GET /pdi/config
ctrl.get = async (req, res) => {
    try {
        const doc = await getOrCreate();
        // Incluir la lista de años derivada del rango para que el front la use directamente
        const anios = [];
        for (let a = doc.anio_inicio; a <= doc.anio_fin; a++) anios.push(a);
        res.json({ ...doc.toObject(), anios });
    } catch (e) {
        res.status(500).json({ error: 'Error interno' });
    }
};

// PUT /pdi/config
ctrl.update = async (req, res) => {
    try {
        const { nombre, descripcion, anio_inicio, anio_fin, lema } = req.body;

        if (anio_inicio && anio_fin && Number(anio_inicio) > Number(anio_fin)) {
            return res.status(400).json({ error: 'El año de inicio no puede ser mayor al año de fin' });
        }

        const doc = await PdiConfig.findByIdAndUpdate(
            SINGLETON_ID,
            { nombre, descripcion, anio_inicio, anio_fin, lema },
            { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
        );

        const anios = [];
        for (let a = doc.anio_inicio; a <= doc.anio_fin; a++) anios.push(a);
        res.json({ ...doc.toObject(), anios });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
};

module.exports = ctrl;
