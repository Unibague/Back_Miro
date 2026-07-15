const Dependency = require('../models/dependencies');
const Program = require('../models/programs');

/**
 * Códigos de dependencia (FACULTAD) del usuario: sube la jerarquía dep_father
 * desde cada dependencia donde el usuario es miembro/visualizador hasta
 * encontrar una cuyo nombre contenga "FACULTAD". Replica en backend el mismo
 * cálculo que hace /processes-MEN/responsible en el frontend, para poder
 * aplicarlo como filtro real (no solo de UI) en los endpoints de procesos MEN.
 */
async function resolveFacultadCodesForUser(email) {
    const facCodes = new Set();
    if (!email) return facCodes;

    const allDeps = await Dependency.find({})
        .select('dep_code name dep_father members visualizers')
        .lean();
    const depMap = new Map(allDeps.map((d) => [d.dep_code, d]));

    const myDeps = allDeps.filter((d) =>
        (Array.isArray(d.members) && d.members.includes(email)) ||
        (Array.isArray(d.visualizers) && d.visualizers.includes(email))
    );

    for (const myDep of myDeps) {
        let current = myDep;
        let depth = 0;
        while (current && depth < 10) {
            if (String(current.name || '').toUpperCase().includes('FACULTAD')) {
                facCodes.add(current.dep_code);
                break;
            }
            current = current.dep_father ? depMap.get(current.dep_father) : undefined;
            depth++;
        }
    }

    return facCodes;
}

/**
 * program_code en `processes` puede ser el `_id` Mongo del programa (actual)
 * o, en registros viejos, el `dep_code_programa` legado — de ahí que se
 * devuelvan ambos valores por programa permitido.
 */
async function resolveAllowedProgramCodesForUser(email) {
    const facCodes = await resolveFacultadCodesForUser(email);
    if (!facCodes.size) return { facCodes, programCodes: new Set() };

    const programs = await Program.find({ dep_code_facultad: { $in: [...facCodes] } })
        .select('_id dep_code_programa')
        .lean();

    const programCodes = new Set();
    for (const p of programs) {
        programCodes.add(String(p._id));
        if (p.dep_code_programa) programCodes.add(p.dep_code_programa);
    }

    return { facCodes, programCodes };
}

module.exports = {
    resolveFacultadCodesForUser,
    resolveAllowedProgramCodesForUser,
};
