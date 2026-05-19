const User = require('../models/users');

// Middleware para verificar que solo administradores puedan realizar acciones de escritura
const requireAdmin = async (req, res, next) => {
    try {
        // Resolver el administrador real que hace la solicitud.
        let email = req.headers['user-email'] ||
                    req.headers['x-user-email'] ||
                    req.query.adminEmail ||
                    req.body.adminEmail ||
                    req.query.email ||
                    req.body.email ||
                    req.headers['authorization']?.split(' ')[1];

        if (!email) {
            console.log('Headers disponibles:', req.headers);
            console.log('Query params:', req.query);
            console.log('Body:', req.body);

            const sessionEmail = req.session?.user?.email || req.cookies?.userEmail;
            if (sessionEmail) {
                console.log('Email encontrado en session/cookies:', sessionEmail);
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

// Middleware para verificar que el usuario tenga acceso de lectura (Administrador o Lider)
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
        if (!allowedRoles.includes(user.activeRole)) {
            return res.status(403).json({
                message: 'Acceso denegado. Rol insuficiente.',
                userRole: user.activeRole,
                allowedRoles
            });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error('Error en middleware de lectura:', error);
        res.status(500).json({
            message: 'Error verificando permisos',
            error: error.message
        });
    }
};

module.exports = {
    requireAdmin,
    requireReadAccess
};
