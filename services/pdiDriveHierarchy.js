const Macroproyecto = require('../models/pdiMacroproyecto');
const Proyecto = require('../models/pdiProyecto');
const Accion = require('../models/pdiAccionEstrategica');
const Indicador = require('../models/pdiIndicador');

const cleanCode = (value) => String(value ?? '').trim();

function actionFolderName(accion) {
    const code = cleanCode(accion?.codigo || accion);
    const match = code.match(/(?:^|-)(AE?\d+)$/i);
    if (!match) return code;
    return match[1].toUpperCase().replace(/^AE/, 'A');
}

function buildJerarquia({ macro, proyecto, accion, indicador }) {
    return {
        macro: cleanCode(macro?.codigo || macro),
        proyecto: cleanCode(proyecto?.codigo || proyecto),
        accion: accion ? actionFolderName(accion) : '',
        indicador: cleanCode(indicador?.codigo || indicador),
    };
}

async function getHierarchyForMacro(macroOrId) {
    const macro = typeof macroOrId === 'object' && macroOrId?._id
        ? macroOrId
        : await Macroproyecto.findById(macroOrId).lean();
    if (!macro) throw new Error('Macroproyecto no encontrado para Drive.');
    return { macro, jerarquia: buildJerarquia({ macro }) };
}

async function getHierarchyForProyecto(proyectoOrId) {
    const proyecto = typeof proyectoOrId === 'object' && proyectoOrId?._id && proyectoOrId?.macroproyecto_id
        ? proyectoOrId
        : await Proyecto.findById(proyectoOrId?._id || proyectoOrId).lean();
    if (!proyecto) throw new Error('Proyecto no encontrado para Drive.');

    const macro = await Macroproyecto.findById(proyecto.macroproyecto_id).lean();
    if (!macro) throw new Error('Macroproyecto del proyecto no encontrado para Drive.');

    return { macro, proyecto, jerarquia: buildJerarquia({ macro, proyecto }) };
}

async function getHierarchyForAccion(accionOrId) {
    const accion = typeof accionOrId === 'object' && accionOrId?._id && accionOrId?.proyecto_id
        ? accionOrId
        : await Accion.findById(accionOrId?._id || accionOrId).lean();
    if (!accion) throw new Error('Accion estrategica no encontrada para Drive.');

    const { macro, proyecto } = await getHierarchyForProyecto(accion.proyecto_id);
    return { macro, proyecto, accion, jerarquia: buildJerarquia({ macro, proyecto, accion }) };
}

async function getHierarchyForIndicador(indicadorOrId) {
    const indicador = typeof indicadorOrId === 'object' && indicadorOrId?._id && indicadorOrId?.accion_id
        ? indicadorOrId
        : await Indicador.findById(indicadorOrId?._id || indicadorOrId).lean();
    if (!indicador) throw new Error('Indicador no encontrado para Drive.');

    const { macro, proyecto, accion } = await getHierarchyForAccion(indicador.accion_id);
    return {
        macro,
        proyecto,
        accion,
        indicador,
        jerarquia: buildJerarquia({ macro, proyecto, accion, indicador }),
    };
}

module.exports = {
    actionFolderName,
    buildJerarquia,
    getHierarchyForMacro,
    getHierarchyForProyecto,
    getHierarchyForAccion,
    getHierarchyForIndicador,
};
