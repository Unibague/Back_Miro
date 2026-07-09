function toNumberValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isNaN(value) ? null : value;
    const normalized = String(value).replace('%', '').replace(',', '.').trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isNaN(parsed) ? null : parsed;
}

function normalizePeso(peso) {
    const value = Number(peso) || 0;
    return value <= 1 ? value * 100 : value;
}

function clampPercentage(value) {
    return Math.min(Math.max(Number(value) || 0, 0), 100);
}

function weightedContribution(items = [], getAdvance, getWeight) {
    return Math.round(
        items.reduce((acc, item) => (
            acc + clampPercentage(getAdvance(item)) * normalizePeso(getWeight(item))
        ), 0) / 100
    );
}

function weightedAverage(items = [], getAdvance, getWeight) {
    const totalWeight = items.reduce((acc, item) => acc + normalizePeso(getWeight(item)), 0);
    if (totalWeight <= 0) return 0;

    return Math.round(
        items.reduce((acc, item) => (
            acc + clampPercentage(getAdvance(item)) * normalizePeso(getWeight(item))
        ), 0) / totalWeight
    );
}

module.exports = {
    toNumberValue,
    normalizePeso,
    clampPercentage,
    weightedContribution,
    weightedAverage,
};
