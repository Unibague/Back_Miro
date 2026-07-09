// Resuelve si un usuario, segun el perfil de permisos al que pertenece
// (por cargo vinculado o por inclusion/exclusion individual), tiene acceso a
// una vista especifica. Misma logica que usersController.getUserRoles, pero
// exportada para que otros servicios (p.ej. recordatorios por correo) puedan
// respetar el mismo perfil sin duplicar la consulta.
const AccessProfile = require('../models/accessProfiles');
const PositionViewPermission = require('../models/positionViewPermissions');

const normalizePosition = (position) =>
    typeof position === "string" && position.trim() ? position.trim() : "Sin cargo";

const normalizeIdentification = (identification) => {
    if (identification === undefined || identification === null) return null;
    const normalized = Number(String(identification).trim());
    return Number.isFinite(normalized) ? normalized : null;
};

// Perfiles que aplican a este usuario: por cargo vinculado (sin excluirlo
// individualmente) o por inclusion individual (individualMembers).
const getUserProfiles = async (user) => {
    const normalizedPosition = normalizePosition(user.position);
    const normalizedIdentification = normalizeIdentification(user.identification);

    return AccessProfile.find({
        $or: [
            { individualMembers: normalizedIdentification },
            {
                positions: normalizedPosition,
                excludedMembers: { $ne: normalizedIdentification }
            }
        ]
    }).lean();
};

// Permisos de vista mezclados de todos los perfiles del usuario. Si el
// usuario no pertenece a ningun perfil, hasProfile=false: el rol decide todo
// normalmente (no se restringe nada aqui, igual que en el resto de la app).
const getMergedViewPermissions = async (user) => {
    const normalizedPosition = normalizePosition(user.position);
    const profilesWithPosition = await getUserProfiles(user);
    const hasProfile = profilesWithPosition.length > 0;

    if (!hasProfile) {
        return { hasProfile: false, viewPermissions: {} };
    }

    const profilePositionNames = profilesWithPosition.flatMap((profile) =>
        (Array.isArray(profile.positions) ? profile.positions : []).map(normalizePosition)
    );
    const allPositionNames = Array.from(new Set([normalizedPosition, ...profilePositionNames]));

    const allPermissionDocs = await PositionViewPermission.find({ position: { $in: allPositionNames } });

    const viewPermissions = allPermissionDocs.reduce((merged, doc) => {
        const perms = typeof doc.permissions?.toObject === 'function' ? doc.permissions.toObject() : doc.permissions || {};
        Object.entries(perms).forEach(([key, levels]) => {
            if (!merged[key]) merged[key] = [];
            merged[key] = Array.from(new Set([...merged[key], ...(Array.isArray(levels) ? levels : [])]));
        });
        return merged;
    }, {});

    return { hasProfile: true, viewPermissions };
};

// true si el usuario puede ver esta vista: sin perfil asignado, el rol manda
// (sin restriccion aqui); con perfil, manda unicamente lo que el perfil otorgo.
const userHasViewPermission = async (user, key) => {
    const { hasProfile, viewPermissions } = await getMergedViewPermissions(user);
    if (!hasProfile) return true;
    return Array.isArray(viewPermissions[key]) && viewPermissions[key].length > 0;
};

module.exports = {
    getUserProfiles,
    getMergedViewPermissions,
    userHasViewPermission,
    normalizePosition,
    normalizeIdentification,
};
