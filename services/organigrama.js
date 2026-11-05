const Organigrama = require('../models/organigrama');
const Dependency = require('../models/dependencies');
const Program = require('../models/programs');

// ── Estructura base (Organigrama Institucional Universidad de Ibagué) ──────
const nodo = (nombre, tipo, hijos = [], extra = {}) => ({ nombre, tipo, hijos, ...extra });
const staff = (nombre, tipo = 'Unidad administrativa', hijos = []) => nodo(nombre, tipo, hijos, { relacion: 'staff' });
const pregrado = (...nombres) => nombres.map((n) => nodo(n, 'Programa', [], { nivel: 'Pregrado' }));
const posgrado = (...nombres) => nombres.map((n) => nodo(n, 'Programa', [], { nivel: 'Posgrado' }));
const unidades = (...nombres) => nombres.map((n) => nodo(n, 'Unidad académica'));

const ESTRUCTURA_BASE = [
    nodo('Consejo de Fundadores', 'Órgano de gobierno', [
        staff('Revisoría Fiscal'),
        nodo('Consejo Superior', 'Órgano de gobierno', [
            nodo('Rectoría', 'Rectoría', [
                staff('Relaciones Internacionales e Interinstitucionales'),
                staff('Egresados'),
                staff('Filantropía'),
                staff('Secretaría General'),
                staff('Planeación'),
                staff('Consejo Académico', 'Órgano de gobierno'),
                nodo('Vicerrectoría', 'Vicerrectoría', [
                    staff('Bienestar Universitario'),
                    staff('Registro Académico'),
                    staff('Biblioteca'),
                    staff('Paz y Región'),
                    nodo('Facultad de Derecho, Administración y Economía', 'Facultad', [
                        staff('Consejo de Facultad', 'Órgano de gobierno'),
                        staff('Centro de Conciliación'),
                        nodo('Escuela de Gestión para el Desarrollo y la Justicia', 'Escuela', [
                            nodo('Área de Derecho y Ciencias Políticas', 'Área', [
                                staff('Consultorio Jurídico'),
                                ...pregrado('Derecho'),
                                ...posgrado(
                                    'Maestría en Derecho',
                                    'Maestría en Política y Gerencia Pública',
                                    'Especialización en Derecho Administrativo',
                                    'Especialización en Derecho Civil',
                                    'Especialización en Derecho Penal',
                                ),
                            ]),
                            nodo('Área de Economía y Negocios Internacionales', 'Área', [
                                ...pregrado('Economía', 'Administración de Negocios Internacionales'),
                                ...posgrado(
                                    'Maestría en Gerencia de la RSE y Creación de Valor Compartido',
                                    'Maestría en Analítica de Datos para la Toma de Decisiones',
                                ),
                            ]),
                            nodo('Área de Gestión y Estrategia Organizacional', 'Área', [
                                ...pregrado('Administración de Empresas', 'Mercadeo', 'Contaduría Pública'),
                                ...posgrado(
                                    'Maestría en Administración de Negocios',
                                    'Maestría en Marketing e Investigación de Mercados',
                                    'Maestría en Gerencia del Bienestar y de la Salud y Seguridad en el Trabajo',
                                ),
                            ]),
                        ]),
                    ]),
                    nodo('Facultad de Humanidades, Artes, Filosofía y Educación', 'Facultad', [
                        staff('Consejo de Facultad', 'Órgano de gobierno'),
                        staff('Centro de Idiomas'),
                        nodo('Escuela de Formación en Gestión Territorial y Autonomía', 'Escuela', [
                            nodo('Área Comprensión Social y Humana', 'Área', [
                                ...pregrado('Psicología', 'Diseño'),
                                ...posgrado(
                                    'Maestría en Gestión Territorial, Autonomía y Sostenibilidad',
                                    'Especialización en Intervención Psicosocial',
                                ),
                            ]),
                            nodo('Área Creación Colectiva', 'Área', [
                                ...pregrado('Arquitectura', 'Comunicación Social y Periodismo'),
                                ...posgrado('Maestría en Liderazgo y Capacidades para la Innovación'),
                            ]),
                            nodo('Área Educación y Cultura', 'Área', [
                                ...unidades('Filosofía', 'Lenguaje', 'Socio-humanística'),
                            ]),
                        ]),
                    ]),
                    nodo('Facultad de Ciencias, Ingeniería e Innovación', 'Facultad', [
                        staff('Consejo de Facultad', 'Órgano de gobierno'),
                        nodo('Escuela de Innovación, Transformación Tecnológica y Sostenibilidad', 'Escuela', [
                            staff('Unidad de Laboratorios'),
                            nodo('Área de Infraestructura, Ambiente y Desarrollo Sostenible', 'Área', [
                                ...pregrado('Ingeniería Civil', 'Biología Ambiental'),
                                ...unidades('Unidad de Biología y Química'),
                                ...posgrado('Especialización en Estructuras'),
                            ]),
                            nodo('Área de Desarrollo Tecnológico', 'Área', [
                                ...pregrado('Ingeniería Mecánica', 'Ingeniería Electrónica'),
                                ...unidades('Unidad de Física'),
                                ...posgrado(
                                    'Especialización en Energías Renovables',
                                    'Especialización en Gestión Inteligente del Mantenimiento',
                                ),
                            ]),
                            nodo('Área de Gestión de Operaciones y Ciencias Computacionales', 'Área', [
                                ...pregrado('Ingeniería Industrial', 'Ingeniería de Sistemas', 'Ingeniería en Analítica de Datos'),
                                ...unidades('Unidad de Matemáticas y Estadística'),
                                ...posgrado(
                                    'Especialización en Gestión de Operaciones y Logística',
                                    'Especialización en Inteligencia Artificial',
                                    'Maestría en Bioestadística',
                                ),
                            ]),
                        ]),
                    ]),
                ]),
                nodo('Dirección de Investigación y Creación', 'Dirección', [
                    staff('Editorial'),
                    nodo('Centro de Pensamiento Eduardo Aldana Valdez', 'Unidad académica'),
                    nodo('Instituto Caracolí', 'Unidad académica', [
                        nodo('Posgrados de Investigación', 'Unidad académica'),
                    ]),
                    nodo('Colaboratorio Colibrí', 'Unidad académica', [
                        nodo('Laboratorio MAGUA', 'Unidad académica'),
                    ]),
                ]),
                nodo('Dirección de Proyección Social', 'Dirección'),
                nodo('Gerencia de Servicios y Sostenibilidad', 'Gerencia', [
                    nodo('Servicios Tecnológicos', 'Unidad administrativa'),
                    nodo('Servicios Financieros', 'Unidad administrativa'),
                    nodo('Servicios Administrativos', 'Unidad administrativa'),
                    nodo('Servicios de Gestión Integral', 'Unidad administrativa'),
                ]),
            ]),
        ]),
    ]),
];

// ── Utilidades ─────────────────────────────────────────────────────────────
const normalizar = (texto = '') => String(texto)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const buildTree = (nodos) => {
    const porId = new Map(nodos.map((n) => [String(n._id), { ...n, hijos: [] }]));
    const raices = [];
    porId.forEach((n) => {
        const padre = n.parent ? porId.get(String(n.parent)) : null;
        if (padre) padre.hijos.push(n);
        else raices.push(n);
    });
    const ordenar = (lista) => {
        lista.sort((a, b) => (a.orden - b.orden) || a.nombre.localeCompare(b.nombre));
        lista.forEach((n) => ordenar(n.hijos));
    };
    ordenar(raices);
    return raices;
};

const getAll = async ({ incluirInactivos = false } = {}) => {
    const filtro = incluirInactivos ? {} : { active: true };
    return Organigrama.find(filtro).sort({ orden: 1, nombre: 1 }).lean();
};

const getTree = async (opts) => buildTree(await getAll(opts));

// IDs de todos los descendientes de un nodo (sin incluirlo)
const getDescendantIds = async (id) => {
    const nodos = await Organigrama.find({}, '_id parent').lean();
    const hijosPorPadre = new Map();
    nodos.forEach((n) => {
        const key = n.parent ? String(n.parent) : null;
        if (!hijosPorPadre.has(key)) hijosPorPadre.set(key, []);
        hijosPorPadre.get(key).push(String(n._id));
    });
    const resultado = [];
    const pila = [...(hijosPorPadre.get(String(id)) || [])];
    while (pila.length) {
        const actual = pila.pop();
        resultado.push(actual);
        pila.push(...(hijosPorPadre.get(actual) || []));
    }
    return resultado;
};

/**
 * Rama del organigrama a partir de una dependencia: el nodo vinculado a ese
 * dep_code y los dep_code de todos sus descendientes. Es el punto de
 * integración para que otros módulos filtren "una unidad y todo lo que
 * cuelga de ella" (p. ej. una facultad con sus escuelas, áreas y programas).
 */
const getRamaPorDepCode = async (depCode) => {
    const nodo = await Organigrama.findOne({ dep_code: depCode, active: true }).lean();
    if (!nodo) return null;
    const descendientes = await getDescendantIds(nodo._id);
    const nodosRama = await Organigrama.find({ _id: { $in: descendientes }, active: true }).lean();
    const depCodes = [...new Set([depCode, ...nodosRama.map((n) => n.dep_code).filter(Boolean)])];
    return { nodo, dep_codes: depCodes, total_nodos: nodosRama.length + 1 };
};

const validarPadre = async (id, parentId) => {
    if (!parentId) return;
    if (id && String(parentId) === String(id)) {
        throw new Error('Una unidad no puede ser su propio padre');
    }
    const padre = await Organigrama.findById(parentId).lean();
    if (!padre) throw new Error('La unidad padre no existe');
    if (id) {
        const descendientes = await getDescendantIds(id);
        if (descendientes.includes(String(parentId))) {
            throw new Error('No puedes mover una unidad dentro de una de sus propias subunidades');
        }
    }
};

const limpiarDatos = (data = {}) => {
    const limpio = {};
    ['nombre', 'tipo', 'relacion', 'orden', 'descripcion', 'active'].forEach((k) => {
        if (data[k] !== undefined) limpio[k] = data[k];
    });
    if (data.parent !== undefined) limpio.parent = data.parent || null;
    if (data.dep_code !== undefined) limpio.dep_code = data.dep_code ? String(data.dep_code).trim() : null;
    if (data.nivel !== undefined || data.tipo !== undefined) {
        limpio.nivel = (data.tipo ?? 'Programa') === 'Programa' ? (data.nivel || null) : null;
    }
    return limpio;
};

const create = async (data) => {
    const limpio = limpiarDatos(data);
    await validarPadre(null, limpio.parent);
    if (limpio.orden === undefined) {
        limpio.orden = await Organigrama.countDocuments({ parent: limpio.parent ?? null });
    }
    return Organigrama.create(limpio);
};

const update = async (id, data) => {
    const limpio = limpiarDatos(data);
    if (limpio.parent !== undefined) await validarPadre(id, limpio.parent);
    const doc = await Organigrama.findByIdAndUpdate(id, limpio, { new: true, runValidators: true });
    if (!doc) throw new Error('Unidad no encontrada');
    return doc;
};

const remove = async (id, { cascada = false } = {}) => {
    const descendientes = await getDescendantIds(id);
    if (descendientes.length && !cascada) {
        const err = new Error('La unidad tiene subunidades. Muévelas o elimínalas junto con ella.');
        err.status = 409;
        err.subunidades = descendientes.length;
        throw err;
    }
    await Organigrama.deleteMany({ _id: { $in: [id, ...descendientes] } });
    return { eliminados: descendientes.length + 1 };
};

// Reordena los hijos de un padre según la lista de IDs recibida
const reordenar = async (parentId, ids = []) => {
    await Promise.all(ids.map((id, orden) =>
        Organigrama.updateOne({ _id: id, parent: parentId || null }, { $set: { orden } })
    ));
};

// Vincula por nombre las unidades sin dep_code con dependencias y programas existentes
const vincularDependencias = async () => {
    const [nodos, dependencias, programas] = await Promise.all([
        Organigrama.find({ $or: [{ dep_code: null }, { dep_code: '' }] }),
        Dependency.find({}, 'dep_code name').lean(),
        Program.find({}, 'nombre dep_code_programa').lean(),
    ]);
    const depPorNombre = new Map(dependencias.map((d) => [normalizar(d.name), d.dep_code]));
    const progPorNombre = new Map(
        programas.filter((p) => p.dep_code_programa).map((p) => [normalizar(p.nombre), p.dep_code_programa])
    );

    let vinculados = 0;
    for (const n of nodos) {
        const clave = normalizar(n.nombre);
        const depCode = (n.tipo === 'Programa' ? progPorNombre.get(clave) : null) || depPorNombre.get(clave);
        if (depCode) {
            n.dep_code = depCode;
            await n.save();
            vinculados += 1;
        }
    }
    return { vinculados, sin_vincular: nodos.length - vinculados };
};

// Carga la estructura base solo si el organigrama está vacío
const cargarEstructuraBase = async () => {
    const existentes = await Organigrama.countDocuments();
    if (existentes > 0) {
        const err = new Error('El organigrama ya tiene unidades registradas');
        err.status = 409;
        throw err;
    }
    let creados = 0;
    const insertar = async (lista, parent) => {
        for (const [orden, item] of lista.entries()) {
            const doc = await Organigrama.create({
                nombre: item.nombre,
                tipo: item.tipo,
                relacion: item.relacion || 'linea',
                nivel: item.nivel || null,
                parent,
                orden,
            });
            creados += 1;
            await insertar(item.hijos || [], doc._id);
        }
    };
    await insertar(ESTRUCTURA_BASE, null);
    const vinculo = await vincularDependencias();
    return { creados, ...vinculo };
};

module.exports = {
    getAll,
    getTree,
    getDescendantIds,
    getRamaPorDepCode,
    create,
    update,
    remove,
    reordenar,
    vincularDependencias,
    cargarEstructuraBase,
};
