// Destinatarios de los correos dirigidos a "administradores" del módulo MEN
// (Procesos de calidad). No basta con tener el rol Administrador ni con ver el
// módulo: solo se notifica a quienes pertenecen a un perfil de rol
// Administrador dedicado al MEN, es decir, cuyas vistas son todas del módulo
// (p. ej. "Administrador Procesos MEN"). Así un perfil general que incluye el
// MEN entre muchos otros módulos no recibe estos correos.
const AccessProfile = require('../models/accessProfiles');
const User = require('../models/users');
const { resolveProfiles } = require('./viewPermissionsResolver');
const { userBelongsToProfile } = require('./pdiAdminRecipients');

const MEN_VIEW_KEY = 'dateReview';
const esVistaMen = (vista) => vista.startsWith(MEN_VIEW_KEY);

const isMenAdminProfile = ({ role, permissions }) => {
    const vistas = Object.keys(permissions || {}).filter((v) => (permissions[v] || []).length);
    return role === 'Administrador'
        && vistas.includes(MEN_VIEW_KEY)
        && vistas.every(esVistaMen);
};

const getMenAdminProfiles = async () => {
    const profiles = await AccessProfile.find({}).lean();
    return (await resolveProfiles(profiles)).filter(isMenAdminProfile).map((item) => item.profile);
};

/** Administradores del MEN con el nombre de los perfiles que los incluyen */
const getMenAdminUsers = async () => {
    const menProfiles = await getMenAdminProfiles();
    if (!menProfiles.length) {
        console.warn('[MEN-ADMINS] No hay perfiles de Administrador dedicados al módulo MEN; no se enviarán sus correos.');
        return { perfiles: [], usuarios: [] };
    }

    const admins = await User.find({ roles: 'Administrador', isActive: { $ne: false } })
        .select('email full_name position identification')
        .lean();

    const usuarios = admins
        .filter((user) => user.email)
        .map((user) => ({
            email: String(user.email).toLowerCase().trim(),
            nombre: user.full_name || '',
            perfiles: menProfiles.filter((p) => userBelongsToProfile(user, p)).map((p) => p.name),
        }))
        .filter((u) => u.perfiles.length);

    return { perfiles: menProfiles.map((p) => p.name), usuarios };
};

const getMenAdminEmails = async () => {
    try {
        const { usuarios } = await getMenAdminUsers();
        return [...new Set(usuarios.map((u) => u.email))];
    } catch (e) {
        console.error('[MEN-ADMINS] Error obteniendo administradores MEN:', e.message);
        return [];
    }
};

module.exports = { getMenAdminUsers, getMenAdminEmails };
