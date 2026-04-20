const xlsx = require('xlsx');

const DEFAULT_SHEET_NAME = '4. PRESUPUESTO';
const ACTION_CODE_REGEX = /^M\d+-P\d+-AE\d+$/i;
const PROJECT_CODE_REGEX = /^(M\d+-P\d+)/i;
const EXECUTED_COLUMN_INDEXES = [5, 7, 9, 11, 13, 15, 17, 19];
function toNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value == null) return 0;

    const normalized = String(value)
        .trim()
        .replace(/\$/g, '')
        .replace(/\s+/g, '')
        .replace(/\.(?=\d{3}(?:\D|$))/g, '')
        .replace(/,/g, '.');

    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeCode(value) {
    return String(value || '')
        .toUpperCase()
        .replace(/[^A-Z0-9-]/g, '')
        .trim();
}

function buildProjectAggregate() {
    return {
        presupuesto: 0,
        acciones: 0,
        codigos_accion: [],
    };
}

function parseBudgetWorkbook(filePath, options = {}) {
    const sheetName = options.sheetName || DEFAULT_SHEET_NAME;
    const workbook = xlsx.readFile(filePath, { cellDates: false });
    const worksheet = workbook.Sheets[sheetName];

    if (!worksheet) {
        throw new Error(`No se encontro la hoja "${sheetName}" en el archivo Excel.`);
    }

    const rows = xlsx.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: null,
        raw: true,
        blankrows: false,
    });

    const aggregatedByProject = new Map();
    const actionsByCode = new Map();
    let currentActionCode = null;
    let currentProjectCode = null;
    let currentActionName = '';

    for (let index = 3; index < rows.length; index += 1) {
        const row = rows[index] || [];
        const actionCode = normalizeCode(row[1]);

        if (ACTION_CODE_REGEX.test(actionCode)) {
            const projectCodeMatch = actionCode.match(PROJECT_CODE_REGEX);
            if (!projectCodeMatch) continue;

            currentActionCode = actionCode;
            currentProjectCode = normalizeCode(projectCodeMatch[1]);
            currentActionName = row[2] || '';

            const presupuesto = toNumber(row[3]);
            const current = aggregatedByProject.get(currentProjectCode) || buildProjectAggregate();
            current.presupuesto += presupuesto;
            current.acciones += 1;
            current.codigos_accion.push(actionCode);
            aggregatedByProject.set(currentProjectCode, current);

            actionsByCode.set(actionCode, {
                fila: index + 1,
                codigo_accion: actionCode,
                codigo_proyecto: currentProjectCode,
                presupuesto,
                nombre_accion: currentActionName,
            });
            continue;
        }
    }

    return {
        fileName: workbook?.Props?.Title || null,
        sheetName,
        projectTitle: rows[0]?.[2] || null,
        rowsRead: rows.length,
        actionsDetected: actionsByCode.size,
        projects: Array.from(aggregatedByProject.entries())
            .map(([codigo, values]) => ({
                codigo,
                presupuesto: values.presupuesto,
                acciones: values.acciones,
                codigos_accion: values.codigos_accion,
            }))
            .sort((a, b) => a.codigo.localeCompare(b.codigo)),
        actions: Array.from(actionsByCode.values()),
    };
}

module.exports = {
    DEFAULT_SHEET_NAME,
    parseBudgetWorkbook,
    parseExecutedWorkbook,
    normalizeCode,
};

function buildExecutedProjectAggregate() {
    return {
        presupuesto_ejecutado: 0,
        acciones: 0,
        codigos_accion: [],
    };
}

function parseExecutedWorkbook(filePath, options = {}) {
    const sheetName = options.sheetName || DEFAULT_SHEET_NAME;
    const workbook = xlsx.readFile(filePath, { cellDates: false });
    const worksheet = workbook.Sheets[sheetName];

    if (!worksheet) {
        throw new Error(`No se encontro la hoja "${sheetName}" en el archivo Excel.`);
    }

    const rows = xlsx.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: null,
        raw: true,
        blankrows: false,
    });

    const aggregatedByProject = new Map();
    const actionsByCode = new Map();
    let currentActionCode = null;
    let currentProjectCode = null;
    let currentActionName = '';

    for (let index = 3; index < rows.length; index += 1) {
        const row = rows[index] || [];
        const rowLabel = String(row[2] || '').trim();
        const actionCode = normalizeCode(row[1]);
        const presupuestoEjecutado = EXECUTED_COLUMN_INDEXES.reduce(
            (acc, columnIndex) => acc + toNumber(row[columnIndex]),
            0
        );

        if (ACTION_CODE_REGEX.test(actionCode)) {
            const projectCodeMatch = actionCode.match(PROJECT_CODE_REGEX);
            if (!projectCodeMatch) continue;

            currentActionCode = actionCode;
            currentProjectCode = normalizeCode(projectCodeMatch[1]);
            currentActionName = row[2] || '';

            const current = aggregatedByProject.get(currentProjectCode) || buildExecutedProjectAggregate();
            current.presupuesto_ejecutado += presupuestoEjecutado;
            current.acciones += 1;
            current.codigos_accion.push(actionCode);
            aggregatedByProject.set(currentProjectCode, current);

            actionsByCode.set(actionCode, {
                fila: index + 1,
                codigo_accion: actionCode,
                codigo_proyecto: currentProjectCode,
                presupuesto_ejecutado: presupuestoEjecutado,
                nombre_accion: currentActionName,
            });
            continue;
        }

        if (!currentActionCode || !currentProjectCode || !rowLabel || !presupuestoEjecutado) continue;

        const current = aggregatedByProject.get(currentProjectCode);
        if (current) {
            current.presupuesto_ejecutado += presupuestoEjecutado;
        }

        const action = actionsByCode.get(currentActionCode);
        if (action) {
            action.presupuesto_ejecutado += presupuestoEjecutado;
        }
    }

    return {
        fileName: workbook?.Props?.Title || null,
        sheetName,
        projectTitle: rows[0]?.[2] || null,
        rowsRead: rows.length,
        actionsDetected: actionsByCode.size,
        projects: Array.from(aggregatedByProject.entries())
            .map(([codigo, values]) => ({
                codigo,
                presupuesto_ejecutado: values.presupuesto_ejecutado,
                acciones: values.acciones,
                codigos_accion: values.codigos_accion,
            }))
            .sort((a, b) => a.codigo.localeCompare(b.codigo)),
        actions: Array.from(actionsByCode.values()),
    };
}
