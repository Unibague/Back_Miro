function getSemaforo(avance) {
    if (avance >= 90) return 'verde';
    if (avance >= 60) return 'amarillo';
    return 'rojo';
}

function withSemaforo(doc) {
    const obj = doc.toObject ? doc.toObject({ flattenMaps: true }) : doc;
    const avanceParaSemaforo = obj.avance_total_real != null ? obj.avance_total_real : obj.avance;
    return { ...obj, semaforo: getSemaforo(avanceParaSemaforo) };
}

module.exports = { getSemaforo, withSemaforo };
