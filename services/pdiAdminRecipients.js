// Destinatarios de los correos dirigidos a "administradores" del módulo PDI
// (Planeación). No basta con tener el rol Administrador: solo se notifica a
// quienes pertenecen a un perfil de acceso de rol Administrador que otorga
// "Gestionar" sobre la vista principal del PDI (p. ej. el perfil "Administrador
// PDI"). Así los administradores de otros módulos no reciben estos correos.
// Los responsables de acción / proyecto / macroproyecto se notifican aparte.
const AccessProfile = require('../models/accessProfiles');
const User = require('../models/users');
const {
    resolveProfiles,
    normalizePosition,
    normalizeIdentification,
} = require('./viewPermissionsResolver');

const PDI_VIEW_KEY = 'pdi';
const PDI_REQUIRED_LEVEL = 'Gestionar';

const isPdiAdminProfile = ({ role, permissions }) =>
    role === 'Administrador'
    && Array.isArray(permissions?.[PDI_VIEW_KEY])
    && permissions[PDI_VIEW_KEY].includes(PDI_REQUIRED_LEVEL);

const userBelongsToProfile = (user, profile) => {
    const identification = normalizeIdentification(user.identification);
    if (identification !== null && (profile.individualMembers || []).includes(identification)) return true;
    const positions = (profile.positions || []).map(normalizePosition);
    if (!positions.includes(normalizePosition(user.position))) return false;
    return identification === null || !(profile.excludedMembers || []).includes(identification);
};

const getPdiAdminUsers = async () => {
    const profiles = await AccessProfile.find({}).lean();
    const pdiProfiles = (await resolveProfiles(profiles))
        .filter(isPdiAdminProfile)
        .map((item) => item.profile);
    if (!pdiProfiles.length) {
        console.warn('[PDI-ADMINS] No hay perfiles de Administrador con permiso "Gestionar" sobre el PDI; no se enviará el correo.');
        return [];
    }

    const admins = await User.find({ roles: 'Administrador', isActive: { $ne: false } })
        .select('email full_name position identification')
        .lean();

    return admins.filter((user) => user.email && pdiProfiles.some((profile) => userBelongsToProfile(user, profile)));
};

const getPdiAdminEmails = async () => {
    try {
        const users = await getPdiAdminUsers();
        return [...new Set(users.map((u) => String(u.email).toLowerCase().trim()).filter(Boolean))];
    } catch (e) {
        console.error('[PDI-ADMINS] Error obteniendo administradores PDI:', e.message);
        return [];
    }
};

module.exports = { getPdiAdminUsers, getPdiAdminEmails };
