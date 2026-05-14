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
    if (gastoVal > 0 && inversionVal > 0) return 'mixto';
    return 'general';
}

function parseExecutedSummaryRows(rows, sheetName, workbook) {
    const parsedSummary = buildSummaryIndex(rows);
    const parsedDetailActions = parseActivityExecutionBlocks(rows, parsedSummary);
    const parsedActions = parsedDetailActions.length > 0
        ? parsedDetailActions
        : parseTopExecutionRows(parsedSummary.actions);
    const parsedAggregates = aggregateExecutedActionsByProject(parsedActions);
    const parsedProjectTitle = extractSheetTitle(rows);

    return {
        fileName: workbook?.Props?.Title || null,
        sheetName,
        projectTitle: parsedProjectTitle,
        rowsRead: rows.length,
        actionsDetected: parsedActions.length,
        projects: Array.from(parsedAggregates.values())
            .sort((a, b) => String(a.codigo || a.nombre_proyecto).localeCompare(String(b.codigo || b.nombre_proyecto))),
        actions: parsedActions,
    };
}

function stripTipoPrefix(value) {
    return String(value || '')
        .replace(/^\s*(Gasto|Inversi(?:o|\u00f3)n)\s*:\s*/i, '')
        .trim();
}

function detectExplicitTipo(value) {
    const normalized = normalizeText(value);
    if (normalized.startsWith('gasto ')) return 'gasto';
    if (normalized.startsWith('inversion ')) return 'inversion';
    return null;
}

function extractSheetTitle(rows) {
    for (let i = 0; i < Math.min(rows.length, 6); i += 1) {
        const cell = String(rows[i]?.[0] || '').trim();
        const normalized = normalizeText(cell);
        if (cell && !/^(acciones estrategicas|proyecto|total|actividad|presupuesto)/i.test(normalized)) {
            return cell;
        }
    }

    return null;
}

function buildSummaryIndex(rows) {
    const actions = [];
    const byName = new Map();
    let currentProjectCode = null;
    let currentProjectName = '';

    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] || [];
        const firstCell = String(row[0] || '').trim();

        if (/^Actividad:/i.test(firstCell)) break;
        if (!firstCell) continue;

        if (/^Proyecto:/i.test(firstCell)) {
            currentProjectName = firstCell.replace(/^Proyecto:\s*/i, '').trim();
            currentProjectCode = extractProjectCodeFromLabel(currentProjectName);
            continue;
        }

        if (
            !currentProjectName
            || /^Total Proyecto$/i.test(firstCell)
            || /^Totales$/i.test(firstCell)
            || normalizeText(firstCell) === 'acciones estrategicas'
        ) {
            continue;
        }

        const gastoPresupuesto = toNumber(row[3]);
        const inversionPresupuesto = toNumber(row[4]);
        const nombreAccion = stripTipoPrefix(firstCell);
        const tipo = detectExplicitTipo(firstCell) || detectTipo(firstCell, gastoPresupuesto, inversionPresupuesto);
        const action = {
            fila: index + 1,
            codigo_accion: null,
            codigo_proyecto: currentProjectCode,
            nombre_proyecto: currentProjectName,
            nombre_accion: nombreAccion,
            tipo,
            gasto_presupuesto: gastoPresupuesto,
            inversion_presupuesto: inversionPresupuesto,
            ejecucion_anio: toNumber(row[6]),
            observacion: row[5] || '',
        };
        const key = normalizeText(nombreAccion);

        actions.push(action);
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(action);
    }

    return { actions, byName };
}

function findSummaryAction(summary, activityName, explicitTipo) {
    const normalizedName = normalizeText(stripTipoPrefix(activityName));
    const candidates = summary.byName.get(normalizedName) || [];

    if (candidates.length > 0) {
        return explicitTipo
            ? candidates.find((action) => action.tipo === explicitTipo) || candidates[0]
            : candidates[0];
    }

    return summary.actions.find((action) => {
        const candidateName = normalizeText(action.nombre_accion);
        return normalizedName.length > 10
            && (candidateName.includes(normalizedName.slice(0, Math.floor(normalizedName.length * 0.7)))
                || normalizedName.includes(candidateName.slice(0, Math.floor(candidateName.length * 0.7))));
    }) || null;
}

function parseActivityExecutionBlocks(rows, summary) {
    const actions = [];
    let block = null;

    const closeBlock = (totalValue) => {
        if (!block?.nombre_accion) return;

        const explicitTipo = detectExplicitTipo(block.rawName);
        const summaryAction = findSummaryAction(summary, block.nombre_accion, explicitTipo);
        let tipo = explicitTipo || summaryAction?.tipo || 'gasto';
        const presupuestoEjecutado = Number.isFinite(totalValue) ? totalValue : block.detalleTotal;

        if (tipo === 'general' || tipo === 'mixto') {
            tipo = (summaryAction?.inversion_presupuesto || 0) > 0
                && (summaryAction?.gasto_presupuesto || 0) === 0
                ? 'inversion'
                : 'gasto';
        }

        actions.push({
            fila: block.fila,
            codigo_accion: null,
            codigo_proyecto: summaryAction?.codigo_proyecto || null,
            nombre_proyecto: summaryAction?.nombre_proyecto || null,
            nombre_accion: stripTipoPrefix(block.nombre_accion),
            tipo,
            gasto: tipo === 'gasto' ? presupuestoEjecutado : 0,
            inversion: tipo === 'inversion' ? presupuestoEjecutado : 0,
            presupuesto_ejecutado: presupuestoEjecutado,
            observacion: summaryAction?.observacion || block.observacion || '',
        });
    };

    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] || [];
        const firstCell = String(row[0] || '').trim();

        if (/^Actividad:/i.test(firstCell)) {
            if (block) closeBlock(block.detalleTotal);
            block = {
                fila: index + 1,
                rawName: row[1] || '',
                nombre_accion: stripTipoPrefix(row[1] || ''),
                detalleTotal: 0,
                observacion: '',
            };
            continue;
        }

        if (!block) continue;

        if (/^Total Actividad$/i.test(firstCell)) {
            closeBlock(toNumber(row[6]));
            block = null;
            continue;
        }

        if (/^Tercero$/i.test(firstCell)) continue;

        const detailValue = toNumber(row[6]);
        block.detalleTotal += detailValue;
        if (!block.observacion && row[2]) {
            block.observacion = String(row[2]).trim();
        }
    }

    if (block) closeBlock(block.detalleTotal);

    return actions;
}

function parseTopExecutionRows(summaryActions) {
    return summaryActions.map((action) => {
        let tipo = action.tipo;
        const presupuestoEjecutado = action.ejecucion_anio || 0;

        if (tipo === 'general' || tipo === 'mixto') {
            tipo = (action.inversion_presupuesto || 0) > 0 && (action.gasto_presupuesto || 0) === 0
                ? 'inversion'
                : 'gasto';
        }

        return {
            fila: action.fila,
            codigo_accion: null,
            codigo_proyecto: action.codigo_proyecto,
            nombre_proyecto: action.nombre_proyecto,
            nombre_accion: action.nombre_accion,
            tipo,
            gasto: tipo === 'gasto' ? presupuestoEjecutado : 0,
            inversion: tipo === 'inversion' ? presupuestoEjecutado : 0,
            presupuesto_ejecutado: presupuestoEjecutado,
            observacion: action.observacion || '',
        };
    });
}

function aggregateExecutedActionsByProject(actions) {
    const aggregatedByProject = new Map();

    for (const action of actions) {
        const projectKey = action.codigo_proyecto || action.nombre_proyecto || 'Sin proyecto';
        if (!aggregatedByProject.has(projectKey)) {
            aggregatedByProject.set(projectKey, {
                codigo: action.codigo_proyecto,
                nombre_proyecto: action.nombre_proyecto,
                presupuesto_ejecutado: 0,
                gasto_total: 0,
                inversion_total: 0,
                acciones: 0,
            });
        }

        const project = aggregatedByProject.get(projectKey);
        project.presupuesto_ejecutado += action.presupuesto_ejecutado || 0;
        project.gasto_total += action.gasto || 0;
        project.inversion_total += action.inversion || 0;
        project.acciones += 1;
    }

    return aggregatedByProject;
}
