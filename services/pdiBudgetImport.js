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

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function extractProjectCodeFromLabel(value) {
    const match = String(value || '').match(/(\d+)\.(\d+)/);
    if (!match) return null;
    return `M${Number(match[1])}-P${Number(match[2])}`;
}

function resolveWorksheet(workbook, options = {}) {
    const requestedSheetName = String(options.sheetName || '').trim();
    if (requestedSheetName && workbook.Sheets[requestedSheetName]) {
        return { worksheet: workbook.Sheets[requestedSheetName], sheetName: requestedSheetName };
    }

    const candidateText = normalizeText(options.sheetMatchText);
    if (candidateText) {
        const candidateTokens = candidateText.split(' ').filter((token) => token.length > 2);
        const rankedMatches = workbook.SheetNames
            .map((name) => {
                const normalizedName = normalizeText(name);
                const matchedTokens = candidateTokens.filter((token) => normalizedName.includes(token));

                if (normalizedName.includes(candidateText) || candidateText.includes(normalizedName)) {
                    return { name, score: Number.MAX_SAFE_INTEGER };
                }

                return { name, score: matchedTokens.length };
            })
            .sort((a, b) => b.score - a.score);

        const matchedSheetName = rankedMatches.find(({ score }) => {
            if (score === Number.MAX_SAFE_INTEGER) return true;
            const minimumScore = candidateTokens.length >= 3 ? 2 : 1;
            return score >= minimumScore;
        })?.name;

        if (matchedSheetName) {
            return { worksheet: workbook.Sheets[matchedSheetName], sheetName: matchedSheetName };
        }
    }

    if (workbook.Sheets[DEFAULT_SHEET_NAME]) {
        return { worksheet: workbook.Sheets[DEFAULT_SHEET_NAME], sheetName: DEFAULT_SHEET_NAME };
    }

    const detectedSheetName = workbook.SheetNames.find((name) => {
        const worksheet = workbook.Sheets[name];
        const rows = xlsx.utils.sheet_to_json(worksheet, {
            header: 1,
            defval: null,
            raw: true,
            blankrows: false,
            range: 0,
        });

        return rows.some((row = []) => normalizeText(row[0]).includes('acciones estrategicas'))
            && rows.some((row = []) => normalizeText(row[0]).startsWith('proyecto '));
    });

    if (detectedSheetName) {
        return { worksheet: workbook.Sheets[detectedSheetName], sheetName: detectedSheetName };
    }

    const availableSheets = workbook.SheetNames.join(', ');
    const suffix = requestedSheetName
        ? `No se encontro la hoja "${requestedSheetName}" en el archivo Excel.`
        : 'No se pudo identificar una hoja de presupuesto valida en el archivo Excel.';
    throw new Error(`${suffix} Hojas disponibles: ${availableSheets}.`);
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

function getSheetNames(filePath) {
    const workbook = xlsx.readFile(filePath, { cellDates: false });
    return workbook.SheetNames;
}

module.exports = {
    DEFAULT_SHEET_NAME,
    parseBudgetWorkbook,
    parseExecutedWorkbook,
    getSheetNames,
    normalizeCode,
    normalizeText,
};

function buildExecutedProjectAggregate() {
    return {
        presupuesto_ejecutado: 0,
        acciones: 0,
        codigos_accion: [],
    };
}

function parseExecutedWorkbook(filePath, options = {}) {
    const workbook = xlsx.readFile(filePath, { cellDates: false });
    const { worksheet, sheetName } = resolveWorksheet(workbook, options);

    const rows = xlsx.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: null,
        raw: true,
        blankrows: false,
    });

    const usesSummaryFormat = rows.some((row = []) => /^Proyecto:/i.test(String(row[0] || '').trim()));
    if (usesSummaryFormat) {
        return parseExecutedSummaryRows(rows, sheetName, workbook);
    }

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

function detectTipo(firstCell, gastoVal, inversionVal) {
    if (/^Gasto:/i.test(firstCell)) return 'gasto';
    if (/^Inversi/i.test(firstCell)) return 'inversion';
    if (gastoVal > 0 && inversionVal === 0) return 'gasto';
    if (inversionVal > 0 && gastoVal === 0) return 'inversion';
    return 'general';
}

function parseExecutedSummaryRows(rows, sheetName, workbook) {
    const aggregatedByProject = new Map();
    const actions = [];
    let currentProjectCode = null;
    let currentProjectName = '';

    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] || [];
        const firstCell = String(row[0] || '').trim();

        if (!firstCell) continue;

        if (/^Proyecto:/i.test(firstCell)) {
            currentProjectName = firstCell.replace(/^Proyecto:\s*/i, '').trim();
            currentProjectCode = extractProjectCodeFromLabel(currentProjectName);

            if (!aggregatedByProject.has(currentProjectCode || currentProjectName)) {
                aggregatedByProject.set(currentProjectCode || currentProjectName, {
                    codigo: currentProjectCode,
                    nombre_proyecto: currentProjectName,
                    presupuesto_ejecutado: 0,
                    gasto_total: 0,
                    inversion_total: 0,
                    acciones: 0,
                });
            }
            continue;
        }

        if (/^Totales$/i.test(firstCell) || /^Actividad:/i.test(firstCell)) {
            break;
        }

        if (!currentProjectName || /^Total Proyecto$/i.test(firstCell)) {
            continue;
        }

        const gastoVal = toNumber(row[3]);
        const inversionVal = toNumber(row[4]);
        const ejecucionAnio = toNumber(row[6]);
        // Usar ejecución registrada; si está vacía, tomar gasto+inversión como monto comprometido
        const presupuestoEjecutado = ejecucionAnio > 0 ? ejecucionAnio : (gastoVal + inversionVal);
        const tipo = detectTipo(firstCell, gastoVal, inversionVal);
        const nombre_accion_clean = firstCell.replace(/^(Gasto:|Inversión:|Inversion:)\s*/i, '').trim();

        const projectKey = currentProjectCode || currentProjectName;
        const project = aggregatedByProject.get(projectKey);
        if (!project) continue;

        project.presupuesto_ejecutado += presupuestoEjecutado;
        project.gasto_total += tipo === 'gasto' ? presupuestoEjecutado : 0;
        project.inversion_total += tipo === 'inversion' ? presupuestoEjecutado : 0;
        project.acciones += 1;

        actions.push({
            fila: index + 1,
            codigo_accion: null,
            codigo_proyecto: currentProjectCode,
            nombre_proyecto: currentProjectName,
            nombre_accion: nombre_accion_clean,
            tipo,
            gasto: tipo === 'gasto' ? presupuestoEjecutado : 0,
            inversion: tipo === 'inversion' ? presupuestoEjecutado : 0,
            presupuesto_ejecutado: presupuestoEjecutado,
            observacion: row[5] || '',
        });
    }

    // Buscar el título del macro en las primeras filas (ignorar cabeceras y filas de proyecto)
    let projectTitle = null;
    const SKIP_PATTERNS = /^(Acciones Estratégicas|Proyecto:|Total|Actividad:|Presupuesto)/i;
    for (let i = 0; i < Math.min(rows.length, 6); i++) {
        const cell = String(rows[i]?.[0] || '').trim();
        if (cell && !SKIP_PATTERNS.test(cell)) { projectTitle = cell; break; }
    }

    return {
        fileName: workbook?.Props?.Title || null,
        sheetName,
        projectTitle,
        rowsRead: rows.length,
        actionsDetected: actions.length,
        projects: Array.from(aggregatedByProject.values())
            .sort((a, b) => String(a.codigo || a.nombre_proyecto).localeCompare(String(b.codigo || b.nombre_proyecto))),
        actions,
    };
}
