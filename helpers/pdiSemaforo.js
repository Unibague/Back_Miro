function getSemaforo(avance) {
    if (avance >= 90) return 'verde';
    if (avance >= 60) return 'amarillo';
    return 'rojo';
}

function withSemaforo(doc) {
    const obj = doc.toObject ? doc.toObject() : doc;
    return { ...obj, semaforo: getSemaforo(obj.avance) };
}

module.exports = { getSemaforo, withSemaforo };
