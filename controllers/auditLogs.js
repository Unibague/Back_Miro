const AuditLog = require('../models/auditLogs');
const User = require('../models/users');
const Dependency = require('../models/dependencies');
const PublishedTemplate = require('../models/publishedTemplates');
const UserService = require('../services/users');

const auditController = {};

auditController.getLogs = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 15; // 15 registros por página
        const entityType = req.query.entityType;
        const search = req.query.search || '';
        const skip = (page - 1) * limit;

        // Construir query de búsqueda
        let query = {};
        
        if (entityType) {
            query.entity_type = entityType;
        }
        
        if (search) {
            query.$or = [
                { user_email: { $regex: search, $options: 'i' } },
                { user_name: { $regex: search, $options: 'i' } },
                { entity_name: { $regex: search, $options: 'i' } },
                { details: { $regex: search, $options: 'i' } }
            ];
        }

        // Debug: Log total de registros
        const totalLogs = await AuditLog.countDocuments(query);
        
        // Obtener logs con paginación
        const logs = await AuditLog.find(query)
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const totalPages = Math.ceil(totalLogs / limit);

        res.status(200).json({
            logs,
            totalPages,
            currentPage: page,
            totalLogs,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1
        });
    } catch (error) {
        console.error('Error fetching audit logs:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

auditController.getLogsByEntity = async (req, res) => {
    try {
        const { email } = req.query;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 15;
        const entityType = req.query.entityType;

        const skip = (page - 1) * limit;

        // Obtener usuario y sus dependencias
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Obtener todas las dependencias del usuario (principal + adicionales)
        const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
        
        // Obtener IDs de las dependencias
        const dependencies = await Dependency.find({ dep_code: { $in: allUserDependencies } });
        const dependencyIds = dependencies.map(dep => dep._id.toString());

        console.log(`🔍 Usuario: ${email}, Dependencias: ${allUserDependencies.join(', ')}`);
        
        // Obtener plantillas asignadas a estas dependencias
        const templates = await PublishedTemplate.find({
            'template.producers': { $in: dependencyIds }
        }).select('_id name').lean();

        const templateIds = templates.map(t => t._id.toString());
        const templateNames = templates.map(t => t.name);

        console.log(`📊 Plantillas encontradas: ${templateIds.length}`);

        // Construir query con $or para incluir múltiples casos
        let query = {
            $or: [
                // Logs de carga/eliminación de datos en plantillas de sus dependencias
                { 
                    entity_type: 'publishedTemplateData',
                    entity_name: { $in: templateNames }
                },
                // Logs de configuración de plantillas asignadas
                {
                    entity_type: { $in: ['template', 'report', 'producerReport'] },
                    entity_id: { $in: templateIds }
                },
                // Logs donde el usuario es quien hizo la acción
                { user_email: email },
                // Logs relacionados con sus dependencias
                { 'details.dependency': { $in: allUserDependencies } }
            ]
        };

        if (entityType) {
            query.entity_type = entityType;
        }

        // Obtener logs con paginación
        const logs = await AuditLog.find(query)
            .sort({ timestamp: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const totalLogs = await AuditLog.countDocuments(query);
        const totalPages = Math.ceil(totalLogs / limit);

        console.log(`✅ Logs encontrados: ${totalLogs}`);

        res.status(200).json({
            logs,
            totalPages,
            currentPage: page,
            totalLogs,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1
        });
    } catch (error) {
        console.error('Error fetching logs by entity:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

module.exports = auditController;