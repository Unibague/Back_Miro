const User = require('../models/users');

// Middleware para verificar que solo administradores puedan realizar acciones de escritura
const requireAdmin = async (req, res, next) => {
    try {
        // Extraer email del usuario autenticado de diferentes fuentes posibles
        const email = req.headers['user-email'] || 
                     req.headers['x-user-email'] ||
                     req.query.adminEmail ||
                     req.body.adminEmail;
        
        if (!email) {
            console.log('Headers disponibles:', req.headers);
            console.log('Query params:', req.query);
            console.log('Body:', req.body);
            return res.status(400).json({ 
                message: 'Email del administrador requerido para verificar permisos. Incluye adminEmail en query/body o user-email en headers.',
                debug: {
                    headers: Object.keys(req.headers),
                    query: Object.keys(req.query),
                    body: Object.keys(req.body)
                }
            });
        }
        
        const user = await User.findOne({ email, isActive: true });
        
        if (!user) {
            return res.status(404).json({ message: 'Usuario administrador no encontrado o inactivo' });
        }
        
        if (user.activeRole !== 'Administrador') {
            return res.status(403).json({ 
                message: 'Acceso denegado. Solo los administradores pueden realizar esta acción.',
                userRole: user.activeRole,
                requiredRole: 'Administrador'
            });
        }
        
        // Agregar información del usuario a la request para uso posterior
        req.user = user;
        next();
    } catch (error) {
        console.error('Error en middleware de autorización:', error);
        res.status(500).json({ 
            message: 'Error verificando permisos', 
            error: error.message 
        });
    }
};

// Middleware para verificar que el usuario tenga acceso de lectura (Administrador o Líder)
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
        
        // Permitir acceso a Administradores y Responsables
        const allowedRoles = ['Administrador', 'Responsable'];
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