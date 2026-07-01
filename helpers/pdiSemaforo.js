function clampAvance(avance) {
    return Math.min(Math.max(Number(avance) || 0, 0), 100);
}

function getSemaforo(avance) {
    const safeAvance = clampAvance(avance);
    if (safeAvance >= 90) return 'verde';
    if (safeAvance >= 60) return 'amarillo';
    return 'rojo';
}

function withSemaforo(doc) {
    const obj = doc.toObject ? doc.toObject({ flattenMaps: true }) : doc;
    const avanceParaSemaforo = obj.avance_total_real != null ? obj.avance_total_real : obj.avance;
    const avanceActual = clampAvance(avanceParaSemaforo);
    return {
        ...obj,
        ...(obj.avance_total_real != null ? { avance_total_real: avanceActual } : {}),
        avance_actual: obj.avance_actual != null ? clampAvance(obj.avance_actual) : avanceActual,
        semaforo: getSemaforo(avanceActual),
    };
}

module.exports = { clampAvance, getSemaforo, withSemaforo };
