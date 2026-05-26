const User = require('../models/users');
const PositionViewPermission = require('../models/positionViewPermissions');

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

        // Para otros roles, verificar si el cargo tiene permisos de vista configurados
        const positionPermission = await PositionViewPermission.findOne({
            position: user.position?.trim()
        });

        if (positionPermission && positionPermission.permissions) {
            const permissionsObj = typeof positionPermission.permissions.toObject === 'function'
                ? positionPermission.permissions.toObject()
                : positionPermission.permissions;

            const hasAnyPermission = Object.values(permissionsObj).some(
                (levels) => Array.isArray(levels) && levels.length > 0
            );

            if (hasAnyPermission) {
                req.user = user;
                req.positionPermissions = permissionsObj;
                return next();
            }
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

        // Verificar si el cargo tiene permiso Gestionar o Administrar en profiles
        const AccessProfile = require('../models/accessProfiles');
        const normalizedPosition = user.position?.trim() || 'Sin cargo';
        const profilesWithPosition = await AccessProfile.find({ positions: normalizedPosition }).lean();
        const profilePositionNames = profilesWithPosition.flatMap(p => (p.positions || []).map(pos => pos.trim()));
        const allPositionNames = Array.from(new Set([normalizedPosition, ...profilePositionNames]));
        const permDocs = await PositionViewPermission.find({ position: { $in: allPositionNames } });

        const hasManagePermission = permDocs.some(doc => {
            const perms = typeof doc.permissions.toObject === 'function' ? doc.permissions.toObject() : doc.permissions || {};
            const profilesLevels = perms['profiles'] || [];
            return profilesLevels.includes('Gestionar') || profilesLevels.includes('Administrar');
        });

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
