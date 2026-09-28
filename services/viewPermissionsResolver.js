// Resuelve los permisos de vista de un usuario a partir de sus PERFILES DE
// ACCESO. Regla:
//   1. El rol activo define qué módulos existen para la persona.
//   2. Dentro de ese rol, solo cuentan los perfiles de ESE rol
//      (accessProfile.role). Un perfil de Administrador no da nada cuando la
//      persona está como Responsable, y viceversa.
//   3. Cada perfil tiene sus propios permisos (accessProfile.permissions). Si
//      la persona no tiene ningún perfil de su rol activo, el rol decide todo
//      (hasProfile=false), igual que antes de que existieran los perfiles.
//
// Antes los permisos se guardaban por CARGO (positionViewPermissions): dos
// perfiles que compartían un cargo se sobrescribían entre sí, y cada miembro
// recibía la suma de los permisos de todos los cargos del perfil. Los perfiles
// que todavía no tienen permisos propios guardados los toman (solo lectura) de
// su cargo, con la heurística de legacyProfilePermissions, hasta que se
// vuelvan a guardar desde "Gestionar vistas".
const AccessProfile = require('../models/accessProfiles');
const PositionViewPermission = require('../models/positionViewPermissions');

const ROLES = ['Administrador', 'Responsable', 'Productor', 'Usuario'];

const normalizePosition = (position) =>
    typeof position === "string" && position.trim() ? position.trim() : "Sin cargo";

const normalizeIdentification = (identification) => {
    if (identification === undefined || identification === null) return null;
    const normalized = Number(String(identification).trim());
    return Number.isFinite(normalized) ? normalized : null;
};

const toPlain = (value) => (value && typeof value.toObject === 'function' ? value.toObject() : value || {});

const cleanPermissions = (permissions) => Object.fromEntries(
    Object.entries(toPlain(permissions))
        .map(([key, levels]) => [key, Array.isArray(levels) ? levels : []])
        .filter(([, levels]) => levels.length > 0)
);

// El perfil ya tiene permisos propios guardados (aunque sea vacío). null =
// perfil anterior al cambio: se leen de su cargo.
const hasOwnPermissions = (profile) =>
    Boolean(profile) && profile.permissions !== null && profile.permissions !== undefined;

// Perfiles que aplican a este usuario: por cargo vinculado (sin excluirlo
// individualmente) o por inclusion individual (individualMembers).
const getUserProfiles = async (user) => {
    const normalizedPosition = normalizePosition(user.position);
    const normalizedIdentification = normalizeIdentification(user.identification);

    return AccessProfile.find({
        $or: [
            ...(normalizedIdentification !== null ? [{ individualMembers: normalizedIdentification }] : []),
            {
                positions: normalizedPosition,
                ...(normalizedIdentification !== null ? { excludedMembers: { $ne: normalizedIdentification } } : {})
            }
        ]
    }).lean();
};

// Permisos de un perfil que aún no los tiene guardados (datos anteriores al
// cambio): se toma el documento de un cargo que sea SOLO de este perfil; si
// todos sus cargos son compartidos, el que se guardó más cerca de la última
// edición del perfil (el que casi seguro guardó este perfil).
const legacyProfilePermissions = (profile, allProfiles, docByPosition) => {
    const positions = (profile.positions || []).map(normalizePosition);
    const sharedCount = (position) => allProfiles
        .filter((p) => (p.positions || []).map(normalizePosition).includes(position)).length;
    const docs = positions.map((position) => docByPosition.get(position)).filter(Boolean);
    if (docs.length === 0) return null;

    const ownDoc = docs.find((doc) => sharedCount(doc.position) <= 1);
    if (ownDoc) return ownDoc;

    const profileTime = new Date(profile.updatedAt || 0).getTime();
    return [...docs].sort((a, b) =>
        Math.abs(new Date(a.updatedAt || 0).getTime() - profileTime)
        - Math.abs(new Date(b.updatedAt || 0).getTime() - profileTime)
    )[0];
};

// Rol de un perfil. Si no se ha definido (perfiles anteriores al cambio), se
// deduce del nombre ("Administrador PDI", "Responsable ...", "Productor ...")
// o de sus vistas (todas de Responsable -> Responsable, etc.).
const inferProfileRole = (profile, permissions) => {
    if (ROLES.includes(profile.role)) return profile.role;
    const name = String(profile.name || '').trim().toLowerCase();
    const byName = ROLES.find((role) => name.startsWith(role.toLowerCase()));
    if (byName) return byName;
    const keys = Object.keys(permissions || {});
    if (keys.length > 0 && keys.every((key) => /Responsable$|Responsible$/.test(key))) return 'Responsable';
    if (keys.length > 0 && keys.every((key) => /Productor$/.test(key))) return 'Productor';
    return 'Administrador';
};

// Permisos efectivos de cada perfil: { profile, role, permissions,
// allowed_dimensions, allowed_dependencies }.
const resolveProfiles = async (profiles) => {
    if (profiles.length === 0) return [];
    const needsLegacy = profiles.some((profile) => !hasOwnPermissions(profile));
    let allProfiles = profiles;
    let docByPosition = new Map();
    if (needsLegacy) {
        allProfiles = await AccessProfile.find({}, 'positions').lean();
        const positions = Array.from(new Set(profiles.flatMap((p) => (p.positions || []).map(normalizePosition))));
        const docs = await PositionViewPermission.find({ position: { $in: positions } }).lean();
        docByPosition = new Map(docs.map((doc) => [normalizePosition(doc.position), doc]));
    }

    return profiles.map((profile) => {
        const source = hasOwnPermissions(profile)
            ? profile
            : legacyProfilePermissions(profile, allProfiles, docByPosition) || {};
        const permissions = cleanPermissions(source.permissions);
        return {
            profile,
            role: inferProfileRole(profile, permissions),
            permissions,
            allowed_dimensions: (source.allowed_dimensions || []).map(String),
            allowed_dependencies: (source.allowed_dependencies || []).map(String),
            fromLegacy: !hasOwnPermissions(profile),
        };
    });
};

// [] = sin restricción. Si algún perfil no restringe, el resultado no
// restringe; si todos restringen, es la unión.
const mergeRestriction = (lists) =>
    lists.length === 0 || lists.some((list) => list.length === 0)
        ? []
        : Array.from(new Set(lists.flat()));

// Permisos de vista del usuario para su rol activo (o el rol indicado).
const getMergedViewPermissions = async (user, role = user.activeRole) => {
    const userProfiles = await getUserProfiles(user);
    const resolved = await resolveProfiles(userProfiles);
    const forRole = resolved.filter((item) => item.role === role);

    if (forRole.length === 0) {
        // Sin ningún perfil: el rol decide todo (como antes de los perfiles).
        // Con perfiles, pero ninguno de este rol: NO ve nada en este rol hasta
        // que le asignen un perfil de ese rol (un olvido quita acceso, no lo da).
        return {
            hasProfile: userProfiles.length > 0,
            profiles: [],
            viewPermissions: {},
            allowedDimensions: [],
            allowedDependencies: [],
        };
    }

    const viewPermissions = forRole.reduce((merged, item) => {
        Object.entries(item.permissions).forEach(([key, levels]) => {
            merged[key] = Array.from(new Set([...(merged[key] || []), ...levels]));
        });
        return merged;
    }, {});

    return {
        hasProfile: true,
        profiles: forRole.map((item) => item.profile),
        viewPermissions,
        allowedDimensions: mergeRestriction(forRole.map((item) => item.allowed_dimensions)),
        allowedDependencies: mergeRestriction(forRole.map((item) => item.allowed_dependencies)),
    };
};

// true si el usuario puede ver esta vista: sin perfil de su rol, el rol manda
// (sin restriccion aqui); con perfil, manda unicamente lo que el perfil otorgo.
const userHasViewPermission = async (user, key) => {
    const { hasProfile, viewPermissions } = await getMergedViewPermissions(user);
    if (!hasProfile) return true;
    return Array.isArray(viewPermissions[key]) && viewPermissions[key].length > 0;
};

module.exports = {
    ROLES,
    getUserProfiles,
    resolveProfiles,
    inferProfileRole,
    getMergedViewPermissions,
    userHasViewPermission,
    normalizePosition,
    normalizeIdentification,
};
