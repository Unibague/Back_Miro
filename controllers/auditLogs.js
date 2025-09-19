const AuditLog = require('../models/auditLogs');

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
        console.log(`Total audit logs in DB: ${totalLogs}, Page: ${page}, Limit: ${limit}`);

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

module.exports = auditController;