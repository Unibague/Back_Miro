const User = require('../models/users');
const { getMergedViewPermissions } = require('../services/viewPermissionsResolver');

// Middleware para verificar que solo administradores puedan realizar acciones de escritura
const requireAdmin = async (req, res, next) => {
    try {
        let email = req.headers['user-email'] ||
                    req.headers['x-user-email'] ||
                    req.query.adminEmail ||
                    req.body.adminEmail ||
                    req.query.email ||
                    req.body.email ||
                    req.headers['authorization']?.split(' ')[1];

        if (!email) {
            const sessionEmail = req.session?.user?.email || req.cookies?.userEmail;
            if (sessionEmail) {
                email = sessionEmail;
            } else {
                return res.status(400).json({
                    message: 'Email requerido para verificar permisos de administrador'
                });
            }
        }

        const user = await User.findOne({ email, isActive: true });

        if (!user) {
            return res.status(404).json({ message: 'Usuario administrador no encontrado o inactivo' });
        }

        if (user.activeRole !== 'Administrador') {
            return res.status(403).json({
                message: 'Acceso denegado. Solo los administradores pueden realizar esta accion.',
                userRole: user.activeRole,
                requiredRole: 'Administrador'
            });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error('Error en middleware de autorizacion:', error);
        res.status(500).json({
            message: 'Error verificando permisos',
            error: error.message
        });
    }
};

// Middleware para verificar acceso de lectura.
// Permite: Administrador, Responsable, Productor, o cualquier usuario cuyo cargo
// tenga configurado el permiso de vista para la ruta solicitada.
const requireReadAccess = async (req, res, next) => {
    try {
        const email = req.query.email ||
                     req.body.email ||
                     req.params.email ||
                     req.headers['user-email'];

        if (!email) {
            return res.status(400).json({
                message: 'Email requerido para verificar permisos'
            });
        }

        const user = await User.findOne({ email, isActive: true });

        if (!user) {
            return res.status(404).json({ message: 'Usuario no encontrado o inactivo' });
        }

        const allowedRoles = ['Administrador', 'Responsable', 'Productor'];
        if (allowedRoles.includes(user.activeRole)) {
            req.user = user;
            return next();
        }

        // Para otros roles, verificar si algún perfil de su rol activo le da
        // permisos de vista (ver services/viewPermissionsResolver.js)
        const { hasProfile, viewPermissions } = await getMergedViewPermissions(user);
        const hasAnyPermission = hasProfile && Object.values(viewPermissions).some(
            (levels) => Array.isArray(levels) && levels.length > 0
        );
        if (hasAnyPermission) {
            req.user = user;
            req.positionPermissions = viewPermissions;
            return next();
        }

        return res.status(403).json({
            message: 'Acceso denegado. Rol o cargo sin permisos suficientes.',
            userRole: user.activeRole,
            position: user.position,
            allowedRoles
        });
    } catch (error) {
        console.error('Error en middleware de lectura:', error);
        res.status(500).json({
            message: 'Error verificando permisos',
            error: error.message
        });
    }
};

const requireAdminOrProfilePermission = async (req, res, next) => {
    try {
        const email = req.headers['user-email'] ||
                      req.headers['x-user-email'] ||
                      req.query.adminEmail ||
                      req.body.adminEmail;

        if (!email) {
            return res.status(400).json({ message: 'Email requerido para verificar permisos' });
        }

        const user = await User.findOne({ email, isActive: true });
        if (!user) {
            return res.status(404).json({ message: 'Usuario no encontrado o inactivo' });
        }

        // Administrador siempre pasa
        if (user.activeRole === 'Administrador') {
            req.user = user;
            return next();
        }

        // Verificar si algún perfil de su rol activo da Gestionar/Administrar en "profiles"
        const { viewPermissions } = await getMergedViewPermissions(user);
        const profilesLevels = viewPermissions['profiles'] || [];
        const hasManagePermission = profilesLevels.includes('Gestionar') || profilesLevels.includes('Administrar');

        if (hasManagePermission) {
            req.user = user;
            return next();
        }

        return res.status(403).json({
            message: 'Acceso denegado. Se requiere rol Administrador o permiso de gestión en perfiles.',
            userRole: user.activeRole
        });
    } catch (error) {
        console.error('Error en middleware requireAdminOrProfilePermission:', error);
        res.status(500).json({ message: 'Error verificando permisos', error: error.message });
    }
};

module.exports = {
    requireAdmin,
    requireReadAccess,
    requireAdminOrProfilePermission
};
