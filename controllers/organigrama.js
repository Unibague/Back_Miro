const svc = require('../services/organigrama');
const Dependency = require('../models/dependencies');
const { TIPOS, RELACIONES, NIVELES } = require('../models/organigrama');

const ctrl = {};

const responderError = (res, e) => {
    const status = e.status || (e.name === 'ValidationError' || e.name === 'CastError' ? 400 : 500);
    res.status(status).json({ error: e.message, subunidades: e.subunidades });
};

ctrl.getAll = async (req, res) => {
    try {
        const incluirInactivos = req.query.incluirInactivos === 'true';
        const nodos = await svc.getAll({ incluirInactivos });
        if (req.query.formato === 'arbol') {
            return res.json(await svc.getTree({ incluirInactivos }));
        }
        res.json(nodos);
    } catch (e) {
        responderError(res, e);
    }
};

ctrl.getCatalogos = async (req, res) => {
    try {
        const dependencias = await Dependency.find({ active: { $ne: false } }, 'dep_code name')
            .sort({ name: 1 })
            .lean();
        res.json({ tipos: TIPOS, relaciones: RELACIONES, niveles: NIVELES, dependencias });
    } catch (e) {
        responderError(res, e);
    }
};

// GET /organigrama/rama?dep_code=XXX → nodo y dep_codes de toda su rama
ctrl.getRama = async (req, res) => {
    try {
        const { dep_code } = req.query;
        if (!dep_code) return res.status(400).json({ error: 'dep_code es requerido' });
        const rama = await svc.getRamaPorDepCode(dep_code);
        if (!rama) return res.status(404).json({ error: 'La dependencia no está vinculada al organigrama' });
        res.json(rama);
    } catch (e) {
        responderError(res, e);
    }
};

ctrl.create = async (req, res) => {
    try {
        res.status(201).json(await svc.create(req.body));
    } catch (e) {
        responderError(res, e);
    }
};

ctrl.update = async (req, res) => {
    try {
        res.json(await svc.update(req.params.id, req.body));
    } catch (e) {
        responderError(res, e);
    }
};

ctrl.remove = async (req, res) => {
    try {
        res.json(await svc.remove(req.params.id, { cascada: req.query.cascada === 'true' }));
    } catch (e) {
        responderError(res, e);
    }
};

ctrl.reordenar = async (req, res) => {
    try {
        await svc.reordenar(req.body.parent || null, req.body.ids || []);
        res.json({ ok: true });
    } catch (e) {
        responderError(res, e);
    }
};

ctrl.vincular = async (req, res) => {
    try {
        res.json(await svc.vincularDependencias());
    } catch (e) {
        responderError(res, e);
    }
};

ctrl.cargarBase = async (req, res) => {
    try {
        res.status(201).json(await svc.cargarEstructuraBase());
    } catch (e) {
        responderError(res, e);
    }
};

module.exports = ctrl;
