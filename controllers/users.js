//const { loadEnvFile } = require("process");
const axios = require('axios');
const User = require('../models/users');
const PositionViewPermission = require('../models/positionViewPermissions');
const AccessProfile = require('../models/accessProfiles');
const Dependency = require('../models/dependencies');
const Dimension = require('../models/dimensions');
const dependencyController = require('./dependencies.js');
const { default: mongoose } = require('mongoose');
const periodController = require('./periods.js');
const PendingUserChanges = require('../models/pendingUserChanges');
const auditLogger = require('../services/auditLogger');

const userController = {}

USERS_ENDPOINT = process.env.USERS_ENDPOINT;
// Added 'Chat' role to the list of available roles
const roles = ["Administrador", "Responsable", "Productor", "Usuario"];
const profiles = ["Ver", "Administrar", "Gestionar"];
// "module" = modulo grande del dashboard (las tarjetas de /dashboard).
// "group" = submodulo dentro de ese modulo. La pantalla de permisos por
// perfil (Gestionar vistas) agrupa dinamicamente por estos dos campos: para
// agregar una vista nueva a la jerarquia solo hay que declararla aqui, con el
// module/group que le corresponda, sin tocar el frontend.
// "roles" = quien tiene esta vista por defecto HOY en el sistema cuando el
// usuario no tiene un perfil de permisos configurado (ver canSee en
// app/dashboard/page.tsx del frontend). Sirve como referencia informativa en
// "Gestionar vistas": no reemplaza los permisos guardados de cada perfil,
// solo documenta el comportamiento por defecto para que Planeación/TI sepa
// que tocar cuando arma un perfil nuevo.
const viewPermissionOptions = [
    { key: "dashboard", label: "Inicio", path: "/dashboard", module: "General", group: "General", roles: ["Administrador"] },
    { key: "dashboardResponsable", label: "Inicio (Responsable)", path: "/dashboard", module: "General", group: "General", roles: ["Responsable"] },
    { key: "dashboardProductor", label: "Inicio (Productor)", path: "/dashboard", module: "General", group: "General", roles: ["Productor"] },

    { key: "adminTemplates", label: "Configurar Plantillas", path: "/admin/templates", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Administrador"] },
    { key: "publishedTemplates", label: "Gestionar Plantillas (publicadas por Productores)", path: "/templates/published", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Administrador"] },
    { key: "publishedTemplatesResponsable", label: "Gestionar Plantillas (publicadas por Productores) — Responsable", path: "/templates/published", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Responsable"] },
    { key: "producerTemplates", label: "Gestionar Plantillas (Productor)", path: "/producer/templates", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Productor"] },
    { key: "templatesWithFilters", label: "Gestión de Plantillas con Filtros", path: "/templates-with-filters", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Responsable"] },
    { key: "templatesWithFiltersProductor", label: "Gestión de Plantillas con Filtros (Productor)", path: "/templates-with-filters", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Productor"] },
    { key: "adminReports", label: "Configurar Informes de Gestión de Responsables", path: "/admin/reports", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Administrador"] },
    { key: "publishedReports", label: "Gestionar informes Responsables", path: "/admin/reports/uploaded", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Administrador"] },
    { key: "producerReportsConfig", label: "Configurar Informes de Gestión de Productores", path: "/admin/reports/producers", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Administrador"] },
    { key: "producerReportsManagement", label: "Gestionar Informes Productores", path: "/reportproducers", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Administrador"] },
    { key: "producerReportsManagementResponsable", label: "Gestionar Informes Productores (Responsable)", path: "/reportproducers", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Responsable"] },
    { key: "producerReports", label: "Informe de gestión de productor", path: "/producer/reports", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Productor"] },
    { key: "responsibleReports", label: "Informe de Gestión de Responsables", path: "/responsible/reports", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Responsable"] },
    { key: "validationsView", label: "Validaciones", path: "/validations", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Responsable"] },
    { key: "ambitosReportsConfig", label: "Configurar Informes de Ámbitos", path: "/admin/reports/ambitos", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Administrador"] },
    { key: "ambitosReportsManagement", label: "Gestionar Informes Ámbitos", path: "/admin/reports/ambitos/uploaded", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Administrador"] },
    { key: "templatesLogs", label: "Valida los Registros de Error", path: "/admin/logs", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Administrador"] },
    { key: "reminders", label: "Recordatorios por correo", path: "/admin/reminders", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Administrador"] },
    { key: "audit", label: "Historial de Trazabilidad", path: "/admin/audit", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Administrador"] },
    { key: "templatesManagement", label: "Gestión de Plantillas con Filtros (admin)", path: "/admin/templates-management", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Administrador"] },
    { key: "dependenciesHierarchy", label: "Jerarquía de Dependencias", path: "/admin/dependencies-hierarchy", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Administrador"] },
    { key: "traceability", label: "Historial de Cambios", path: "/traceability", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Responsable"] },
    { key: "traceabilityProductor", label: "Historial de Cambios (Productor)", path: "/traceability", module: "Gestión de reportes", group: "Plantillas y reportes", roles: ["Productor"] },
    { key: "historicoDocentes", label: "Consulta de Información", path: "/historico-docentes", module: "Gestión de reportes", group: "Consulta de información", roles: ["Administrador"] },
    { key: "historicoDocentesResponsable", label: "Consulta de Información (Responsable)", path: "/historico-docentes", module: "Gestión de reportes", group: "Consulta de información", roles: ["Responsable"] },
    { key: "historicoDocentesProductor", label: "Consulta de Información (Productor)", path: "/historico-docentes", module: "Gestión de reportes", group: "Consulta de información", roles: ["Productor"] },
    { key: "snies", label: "SNIES", path: "/snies/templates", module: "Gestión de reportes", group: "SNIES", roles: ["Administrador"] },
    { key: "sniesProductor", label: "SNIES (productor encargado)", path: "/snies/templates", module: "Gestión de reportes", group: "SNIES", roles: ["Productor"] },
    { key: "cna", label: "CNA", path: "/cna/templates", module: "Gestión de reportes", group: "CNA", roles: ["Administrador"] },

    { key: "supportTemplates", label: "Cruce de apoyos SIGA/Iceberg", path: "/apoyos-plantillas", module: "Cruce de apoyos SIGA/Iceberg", group: "Cruce de apoyos", roles: ["Administrador"] },

    { key: "dateReview", label: "Gestión de procesos MEN (RC, AV, Plan de mejoramiento)", path: "/processes-MEN", module: "Procesos de calidad MEN", group: "Gestion de procesos", roles: ["Administrador"] },
    { key: "dateReviewComunicaciones", label: "Comunicaciones MEN", path: "/processes-MEN?modulo=comunicaciones", module: "Procesos de calidad MEN", group: "Gestion de procesos", roles: ["Administrador"] },
    { key: "dateReviewResponsible", label: "Estado de procesos MEN (mi facultad)", path: "/processes-MEN/responsible", module: "Procesos de calidad MEN", group: "Gestion de procesos", roles: ["Responsable"] },
    { key: "dateReviewResponsibleProductor", label: "Estado de procesos MEN (mi facultad) — Productor", path: "/processes-MEN/responsible", module: "Procesos de calidad MEN", group: "Gestion de procesos", roles: ["Productor"] },
    { key: "dateReviewDashboard", label: "Estadísticas y tablero de procesos MEN", path: "/processes-MEN", module: "Procesos de calidad MEN", group: "Gestion de procesos", roles: ["Administrador"] },
    { key: "dateReviewAlerts", label: "Alertas de procesos MEN", path: "/processes-MEN?section=alertas", module: "Procesos de calidad MEN", group: "Gestion de procesos", roles: ["Administrador"] },
    { key: "dateReviewHistory", label: "Historial de procesos MEN", path: "/processes-MEN?section=historial", module: "Procesos de calidad MEN", group: "Gestion de procesos", roles: ["Administrador"] },
    { key: "dateReviewProgram", label: "Ficha de programa MEN", path: "/processes-MEN/program/:programId", module: "Procesos de calidad MEN", group: "Gestion de procesos", roles: ["Administrador"] },
    { key: "dateReviewProgramProcess", label: "Gestionar proceso MEN por programa", path: "/processes-MEN?programId=:programId&gestionar=1", module: "Procesos de calidad MEN", group: "Gestion de procesos", roles: ["Administrador"] },
    { key: "dateReviewRc", label: "Procesos de Registro Calificado", path: "/processes-MEN?tipo=registro-calificado", module: "Procesos de calidad MEN", group: "Gestion de procesos", roles: ["Administrador"] },
    { key: "dateReviewAv", label: "Procesos de Acreditación Voluntaria", path: "/processes-MEN?tipo=acreditacion-voluntaria", module: "Procesos de calidad MEN", group: "Gestion de procesos", roles: ["Administrador"] },
    { key: "dateReviewAdmin", label: "Administrar importación de procesos MEN", path: "/processes-MEN/admin", module: "Procesos de calidad MEN", group: "Gestion de procesos", roles: ["Administrador"] },

    { key: "pdi", label: "PDI - Vista principal", path: "/pdi", module: "PDI", group: "PDI", roles: ["Administrador"] },
    { key: "pdiResponsable", label: "PDI - Vista principal (Responsable)", path: "/pdi", module: "PDI", group: "PDI", roles: ["Responsable"] },
    // "Mis indicadores" es un concepto exclusivo de Responsable (indicadores
    // asignados al usuario que inició sesión); no existe una variante de
    // Administrador porque un administrador no tiene indicadores propios.
    { key: "pdiMineResponsable", label: "Proyectos PDI (mis indicadores)", path: "/pdi/mis-indicadores", module: "PDI", group: "PDI", roles: ["Responsable"] },
    { key: "pdiDashboard", label: "Tablero de control PDI", path: "/pdi/dashboard", module: "PDI", group: "PDI", roles: ["Administrador"] },
    { key: "pdiDashboardResponsable", label: "Tablero de control PDI (Responsable)", path: "/pdi/dashboard", module: "PDI", group: "PDI", roles: ["Responsable"] },
    { key: "pdiForms", label: "Formularios PDI", path: "/pdi/formularios", module: "PDI", group: "PDI", roles: ["Administrador"] },
    { key: "pdiFormsResponsable", label: "Formularios PDI (Responsable)", path: "/pdi/formularios", module: "PDI", group: "PDI", roles: ["Responsable"] },
    { key: "pdiCharts", label: "Gráficas PDI", path: "/pdi/graficas", module: "PDI", group: "PDI", roles: ["Administrador"] },
    { key: "pdiChartsResponsable", label: "Gráficas PDI (Responsable)", path: "/pdi/graficas", module: "PDI", group: "PDI", roles: ["Responsable"] },

    { key: "periods", label: "Gestionar Periodos", path: "/admin/periods", module: "Configuración", group: "Administración", roles: ["Administrador"] },
    { key: "dimensions", label: "Gestionar Ámbitos", path: "/admin/dimensions", module: "Configuración", group: "Administración", roles: ["Administrador"] },
    { key: "dependencies", label: "Gestionar Dependencias", path: "/admin/dependencies", module: "Configuración", group: "Administración", roles: ["Administrador"] },
    { key: "validations", label: "Gestionar Validaciones", path: "/admin/validations", module: "Configuración", group: "Administración", roles: ["Administrador"] },
    { key: "users", label: "Gestionar Usuarios", path: "/admin/users", module: "Configuración", group: "Administración", roles: ["Administrador"] },
    { key: "configuration", label: "Configuración general", path: "/configuracion", module: "Configuración", group: "Administración", roles: ["Administrador"] },
    { key: "profiles", label: "Gestionar perfiles", path: "/configuracion/perfiles", module: "Configuración", group: "Administración", roles: ["Administrador"] },
    { key: "homeSettings", label: "Ajustes Pagina Inicial", path: "/admin/homeSettings", module: "Configuración", group: "Administración", roles: ["Administrador"] },

    { key: "dependency", label: "Ver Mi Dependencia", path: "/dependency", module: "Administración", group: "Administración", roles: ["Responsable"] },
    { key: "dependencyAdmin", label: "Ver Mi Dependencia (Administrador)", path: "/dependency", module: "Administración", group: "Administración", roles: ["Administrador"] },
    { key: "childDependenciesTemplates", label: "Visualizar plantillas de dependencias hijo", path: "/dependency/children-dependencies/templates", module: "Administración", group: "Administración", roles: ["Responsable"] },
    { key: "childDependenciesTemplatesAdmin", label: "Visualizar plantillas de dependencias hijo (Administrador)", path: "/dependency/children-dependencies/templates", module: "Administración", group: "Administración", roles: ["Administrador"] },
    { key: "childDependenciesReports", label: "Visualizar reportes de dependencias hijo", path: "/dependency/children-dependencies/reports", module: "Administración", group: "Administración", roles: ["Responsable"] },
    { key: "childDependenciesReportsAdmin", label: "Visualizar reportes de dependencias hijo (Administrador)", path: "/dependency/children-dependencies/reports", module: "Administración", group: "Administración", roles: ["Administrador"] }
];

userController.addExternalUser = async (req, res) => {
    const dep_code = req.body.dep_code;

    const email = req.body.email;

    await dependencyController.addUserToDependency(dep_code, email);
    const user = new User( req.body )
    await user.save();
    res.status(200).json({status: "User created"});
}

userController.loadUsers = async (req, res) => {
    console.log('=== DEBUG loadUsers ===');
    console.log('Headers:', req.headers);
    console.log('Query:', req.query);
    console.log('Body:', req.body);
    console.log('User from middleware:', req.user);
    
    try {
        // Sincronizar dependencias primero (sin req/res)
        await dependencyController.syncDependenciesInternal();

        const response = await axios.get(USERS_ENDPOINT);

        const usersMigrated = await User.find({ migrated: true });

        // Only non-migrated users for processing
        const externalUsers = response.data
            .filter(user => user.code_user && user.code_user.trim() !== "" && 
                !usersMigrated.some(migratedUser => migratedUser.email === user.email)
          )
            .map(user => ({
                identification: user.identification,
                full_name: user.full_name,
                email: user.email,
                position: user.position,
                dep_code: user.dep_code,
            }));
            
        // DEBUG: Verificar usuario específico
        const williamUser = response.data.find(u => u.email === 'william.londono@unibague.edu.co');
        console.log('=== DEBUG WILLIAM USER ===');
        console.log('William found in endpoint:', williamUser ? 'YES' : 'NO');
        if (williamUser) {
            console.log('William data:', {
                email: williamUser.email,
                dep_code: williamUser.dep_code,
                code_user: williamUser.code_user,
                full_name: williamUser.full_name
            });
            const isMigrated = usersMigrated.some(m => m.email === williamUser.email);
            console.log('William is migrated:', isMigrated);
            console.log('William will be processed:', !isMigrated && williamUser.code_user && williamUser.code_user.trim() !== "");
        }
        console.log('=== END DEBUG ===');

        // Handle dependency updates concurrently
        await Promise.all(
            externalUsers.map(async (externalUser) => {
                try {
                    await dependencyController.addUserToDependency(externalUser.dep_code, externalUser.email);
                } catch (error) {
                    console.error(`Error processing user ${externalUser.email}:`, error);
                }
            })
        );
        
        // Detectar cambios en usuarios migrados y crear registros de cambios pendientes
        console.log('=== DETECTING CHANGES IN MIGRATED USERS ===');
        const pendingChanges = [];
        const migratedUsersToAddToMembers = [];
        
        for (const externalUser of response.data.filter(user => user.code_user && user.code_user.trim() !== "")) {
            const migratedUser = usersMigrated.find(m => m.email === externalUser.email);
            if (migratedUser) {
                // Verificar si el usuario está en members de su dependencia actual
                const userDependency = await Dependency.findOne({ dep_code: migratedUser.dep_code });
                if (userDependency && !userDependency.members.includes(migratedUser.email)) {
                    migratedUsersToAddToMembers.push({
                        email: migratedUser.email,
                        dep_code: migratedUser.dep_code
                    });
                }
                
                // Verificar si hay cambio de dependencia
                if (migratedUser.dep_code !== externalUser.dep_code) {
                    const currentDep = await Dependency.findOne({ dep_code: migratedUser.dep_code });
                    const proposedDep = await Dependency.findOne({ dep_code: externalUser.dep_code });
                    
                    if (currentDep && proposedDep) {
                        pendingChanges.push({
                            user_email: externalUser.email,
                            user_name: externalUser.full_name,
                            change_type: 'dependency_change',
                            current_value: migratedUser.dep_code,
                            proposed_value: externalUser.dep_code,
                            current_dependency_name: currentDep.name,
                            proposed_dependency_name: proposedDep.name
                        });
                        console.log(`Detected change: ${externalUser.email} (${currentDep.name} -> ${proposedDep.name})`);
                    }
                }
            }
        }
        
        console.log(`Pending changes detected: ${pendingChanges.length}`);
        console.log(`Migrated users to add to members: ${migratedUsersToAddToMembers.length}`);
        
        // Guardar cambios pendientes (evitar duplicados)
        if (pendingChanges.length > 0) {
            try {
                await PendingUserChanges.insertMany(pendingChanges, { ordered: false });
                console.log(`${pendingChanges.length} pending changes saved`);
            } catch (error) {
                // Ignorar errores de duplicados (E11000)
                if (error.code !== 11000) {
                    console.error('Error saving pending changes:', error);
                }
            }
        }
        
        // Agregar usuarios migrados al array members de su dependencia actual (sin moverlos)
        await Promise.all(
            migratedUsersToAddToMembers.map(async (user) => {
                try {
                    const dependency = await Dependency.findOne({ dep_code: user.dep_code });
                    if (dependency && !dependency.members.includes(user.email)) {
                        dependency.members.push(user.email);
                        await dependency.save();
                        console.log(`Usuario migrado agregado a members: ${user.email} -> ${dependency.name}`);
                    }
                } catch (error) {
                    console.error(`Error adding migrated user to members ${user.email}:`, error);
                }
            })
        );

        // Sync users (upsert active users)
        await User.syncUsers(externalUsers);
        
        // RESET: Activar a TODOS los usuarios primero (para limpiar estado de producción)
        console.log('=== RESET: Activando todos los usuarios ===');
        const resetResult = await User.updateMany(
            {},
            { $set: { isActive: true } }
        );
        console.log(`Usuarios activados en reset: ${resetResult.modifiedCount}`);
        
        // All users from external endpoint (for deactivation comparison)
        const allExternalEmails = new Set(
            response.data
                .filter(user => user.code_user && user.code_user.trim() !== "")
                .map(user => user.email)
        );

        // DEBUG: Mostrar usuarios que serían desactivados
        const usersToDeactivate = await User.find(
            { 
                email: { $nin: Array.from(allExternalEmails) },
                isActive: true
            },
            { email: 1, full_name: 1, dep_code: 1, migrated: 1, roles: 1 }
        );
        
        console.log('=== DEBUG: USUARIOS QUE SERÍAN DESACTIVADOS ===');
        console.log(`Total: ${usersToDeactivate.length}`);
        usersToDeactivate.forEach((user, index) => {
            console.log(`${index + 1}. ${user.email} - ${user.full_name}`);
            console.log(`   Dependencia: ${user.dep_code}`);
            console.log(`   Migrado: ${user.migrated ? 'Sí' : 'No'}`);
            console.log(`   Roles: ${user.roles?.join(', ') || 'Sin roles'}`);
            console.log('   ---');
        });
        console.log('=== FIN DEBUG ===');
        
        // Desactivar usuarios que no están en el endpoint externo
        await User.updateMany(
            { email: { $nin: Array.from(allExternalEmails) } },
            { $set: { isActive: false } }
        );

        // Eliminar usuarios desactivados de las dependencias
        await userController.deleteDeactivatedUsersFromDependency();
        periodController.updateScreenshotsJob()

        res.status(200).send("Users synchronized");
    } catch (error) {
        console.error('Error during user synchronization:', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
};

userController.deleteDeactivatedUsersFromDependency = async () => {
  try {
    const users = await User.find({ isActive: false });
    const dependencies = await Dependency.find();
    const updatePromises = dependencies.map(async (dependency) => {
        dependency.members = dependency.members.filter(member => !users.some(user => user.email === member));
        await dependency.save();
    });
    await Promise.all(updatePromises);
  } catch (error) {
    console.error("Error removing users from dependencies:", error);
  }
};

// Get all users existing into the DB with pagination
userController.getUsersPagination = async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const search = req.query.search || '';
    const periodId = req.query.periodId || '';
    const skip = (page - 1) * limit;

    try {
        const query = search
            ? {
                $or: [
                    { identification: !isNaN(Number(search)) ? Number(search) : undefined },
                    { full_name: { $regex: search, $options: 'i' } },
                    { position: { $regex: search, $options: 'i' } },
                    { email: { $regex: search, $options: 'i' } },
                    { roles: { $regex: search, $options: 'i' } },
                    { profiles: { $regex: search, $options: 'i' } }
                ].filter(condition => condition !== undefined)
            }
            : {};
        const users = await User.find(query).skip(skip).limit(limit);
        const total = await User.countDocuments(query);

        res.status(200).json({
            users,
            total,
            page,
            pages: Math.ceil(total / limit)
        });
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

// Get all users existing into the DB
userController.getUsers = async (req, res) => {
    const users = await User.find();
    res.status(200).json(users);
}

// Export all active users to Excel
userController.exportActiveUsersExcel = async (req, res) => {
    try {
        const ExcelJS = require('exceljs');
        const [activeUsers, allDependencies] = await Promise.all([
            User.find({ isActive: true }).sort({ full_name: 1 }),
            Dependency.find({}, { dep_code: 1, name: 1 }).lean(),
        ]);

        const depMap = {};
        allDependencies.forEach((d) => { depMap[d.dep_code] = d.name; });

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Usuarios Activos');

        sheet.columns = [
            { header: 'ID', key: 'identification', width: 15 },
            { header: 'Nombre Completo', key: 'full_name', width: 35 },
            { header: 'Posición', key: 'position', width: 40 },
            { header: 'Email', key: 'email', width: 35 },
            { header: 'Dependencia', key: 'dependencia', width: 40 },
            { header: 'Roles', key: 'roles', width: 30 },
            { header: 'Estado', key: 'estado', width: 12 },
        ];

        sheet.getRow(1).eachCell((cell) => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2196F3' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });

        activeUsers.forEach((user) => {
            sheet.addRow({
                identification: user.identification,
                full_name: user.full_name,
                position: user.position,
                email: user.email,
                dependencia: depMap[user.dep_code] || user.dep_code || '',
                roles: (user.roles || []).join(', '),
                estado: 'Activo',
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="usuarios_activos.xlsx"');
        await workbook.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Error exporting users to Excel:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

userController.getUser = async (req, res) => {
    const email = req.query.email; 
    try {
        const user = await User.findOne({ email, isActive: true });
        if (!user) {
            return res.status(404).json({ error: "User not found or inactive" });
        }
        res.status(200).json(user);
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
};


userController.getUserToImpersonate = async (req, res) => {
    const id = req.query.id;
    const adminUser = req.user;
    try {
        if (!id) {
            return res.status(400).json({ error: "User ID is required" });
        }

        const user = await User.findOne({ _id: id, isActive: true });
        if (!user) {
            return res.status(404).json({ error: "User not found in DB or inactive" });
        }
        
        // Registrar impersonación si se proporciona adminEmail
        if (adminUser) {
            await auditLogger.logImpersonate(req, adminUser, user.email);
        }
        
        res.status(200).json(user);
    } catch (error) {
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
};

userController.getUserRoles = async (req, res) => {
    const email = req.query.email;
    try {
        const user = await User.findOne({ email, isActive: true });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const normalizedPosition = normalizePosition(user.position);
        const normalizedIdentification = normalizeIdentification(user.identification);

        // Buscar perfiles que contengan este cargo (y no la hayan excluido
        // individualmente) o que incluyan a la persona individualmente
        const profilesWithPosition = await AccessProfile.find({
            $or: [
                { individualMembers: normalizedIdentification },
                {
                    positions: normalizedPosition,
                    excludedMembers: { $ne: normalizedIdentification }
                }
            ]
        }).lean();

        // Recopilar todos los cargos: el del usuario + los de todos sus perfiles
        const profilePositionNames = profilesWithPosition.flatMap(p => normalizePositions(p.positions || []));
        const allPositionNames = Array.from(new Set([normalizedPosition, ...profilePositionNames]));

        // Buscar permisos de todos esos cargos
        const allPermissionDocs = await PositionViewPermission.find({ position: { $in: allPositionNames } });

        // Fusionar todos los permisos encontrados
        const mergedPermissions = allPermissionDocs.reduce((merged, doc) => {
            const perms = typeof doc.permissions.toObject === 'function' ? doc.permissions.toObject() : doc.permissions || {};
            Object.entries(perms).forEach(([key, levels]) => {
                if (!merged[key]) merged[key] = [];
                merged[key] = Array.from(new Set([...merged[key], ...(Array.isArray(levels) ? levels : [])]));
            });
            return merged;
        }, {});

        // Fusionar allowed_dependencies: [] = acceso a todos, lista = solo esos
        // Si algún cargo tiene [] (sin restricción) o no hay docs, el resultado es [] (sin restricción)
        // Si todos tienen listas específicas, el resultado es la unión
        const mergedAllowedDependencies = (allPermissionDocs.length === 0 || allPermissionDocs.some(doc => (doc.allowed_dependencies || []).length === 0))
            ? []
            : Array.from(new Set(allPermissionDocs.flatMap(doc => (doc.allowed_dependencies || []).map(id => String(id)))));

        const mergedAllowedDimensions = (allPermissionDocs.length === 0 || allPermissionDocs.some(doc => (doc.allowed_dimensions || []).length === 0))
            ? []
            : Array.from(new Set(allPermissionDocs.flatMap(doc => (doc.allowed_dimensions || []).map(id => String(id)))));

        console.log(`[getUserRoles] user=${email} position=${normalizedPosition} profiles=${profilesWithPosition.length} permDocs=${allPermissionDocs.length} keys=${Object.keys(mergedPermissions).join(',')}`);

        res.status(200).json({
            roles: user.roles,
            activeRole: user.activeRole,
            profiles: user.profiles || [],
            position: user.position,
            accessProfiles: profilesWithPosition.map(p => p._id.toString()),
            viewPermissions: normalizeViewPermissions(mergedPermissions),
            allowedDependencies: mergedAllowedDependencies,
            allowedDimensions: mergedAllowedDimensions
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

userController.getResponsibles = async (req, res) => {
    try {
      const responsibles = await User.find({ roles: "Responsable" });
      res.status(200).json(responsibles);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };
  
userController.getProducers = async (req, res) => {
    try {
        const producers = await User.find({ roles: "Productor" });
        res.status(200).json(producers);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
  };

userController.updateUserRoles = async (req, res) => {
    const email = req.body.email;
    const roles = Array.from(req.body.roles);
    const adminEmail = req.body.adminEmail;
    
    try {
        if(!validateRoles(roles)) {
            throw new Error("Invalid roles");
        }
        
        const adminUser = await User.findOne({ email: adminEmail });
        if (!adminUser) {
            return res.status(404).json({ error: "Admin user not found" });
        }
        
        const user = await User.findOneAndUpdate(
            { email },
            { roles },
            { new: true }
        );
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }
        
        // Audit log
        await auditLogger.logUpdate(req, adminUser, 'user', {
            userId: user._id,
            userEmail: email,
            newRoles: roles
        });
        
        res.status(200).json({ user });
    } catch (error){
        res.status(500).json({ error: error.message });
    }
    
}

userController.updateUserProfiles = async (req, res) => {
    const { email, profiles: userProfiles = [], adminEmail } = req.body;

    try {
        const normalizedProfiles = Array.isArray(userProfiles)
            ? userProfiles
            : [userProfiles].filter(Boolean);

        if (!validateProfiles(normalizedProfiles)) {
            return res.status(400).json({ error: "Invalid profiles" });
        }

        const adminUser = await User.findOne({ email: adminEmail });
        if (!adminUser) {
            return res.status(404).json({ error: "Admin user not found" });
        }

        const user = await User.findOneAndUpdate(
            { email },
            { profiles: normalizedProfiles },
            { new: true }
        );

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        await auditLogger.logUpdate(req, adminUser, 'user', {
            userId: user._id,
            userEmail: email,
            newProfiles: normalizedProfiles
        });

        res.status(200).json({ user });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

userController.updateUsersToProducer = async (req, res) => {
    const { users, adminEmail } = req.body;
    console.log('=== DEBUG updateUsersToProducer ===');
    console.log('users:', users);
    console.log('adminEmail:', adminEmail);
    
    try {
        if (!Array.isArray(users)) {
            throw new Error('Users must be an array');
        }
        
        const updatePromises = users.map(async ({ email, roles }) => {
        const user = await User.findOne({ email });

        if (!user) {
            throw new Error(`User not found: ${email}`);
        }

        const updatedRoles = new Set(user.roles);

        if (roles.includes("Productor")) {
            updatedRoles.add("Productor");
        } else {
            updatedRoles.delete("Productor");
        }

        user.roles = Array.from(updatedRoles);
        await user.save();

        return user;
        });

        const updatedUsers = await Promise.all(updatePromises);

        res.status(200).json({ message: "Roles updated successfully", users: updatedUsers });
    } catch (error) {
        console.error("Error updating roles:", error);
        res.status(500).json({ error: error.message });
    }
};

userController.updateUserActiveRole = async (req, res) => {
    const email = req.body.email;
    const activeRole = req.body.activeRole;

    try {
        const user = await User.findOneAndUpdate(
            { email },
            { activeRole },
            { new: true }
        );
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }
        res.status(200).json({ user });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

userController.updateUserStatus = async (req, res) => {
    const { userId, isActive, adminEmail } = req.body;

    try {
        const adminUser = await User.findOne({ email: adminEmail });
        if (!adminUser) {
            return res.status(404).json({ error: "Admin user not found" });
        }
        
        const user = await User.findByIdAndUpdate(
            userId,
            { isActive },
            { new: true }
        );
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }
        
        // Audit log
        await auditLogger.logUpdate(req, adminUser, 'user', {
            userId: user._id,
            userEmail: user.email,
            statusChange: isActive ? 'activated' : 'deactivated'
        });
        
        res.status(200).json({ user });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

userController.getUsersByDependency = async (req, res) => {
    const { dep_code } = req.params;
    try {
        // Traer TODOS los usuarios que tienen esta dep_code (activos e inactivos)
        const users = await User.find({ dep_code }).sort({ full_name: 1 });
        
        console.log(`getUsersByDependency: Found ${users.length} users for dep_code: ${dep_code}`);
        res.status(200).json(users);
    } catch (error) {
        console.error('Error fetching users by dependency:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

userController.migrateUserDependecy = async (req, res) => {
  const { email, dep_code, new_dep_code } = req.body;
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const user = await User.findOne({ email });
    if (!user) {
      throw new Error("User not found");
    }
    if (user.dep_code !== dep_code) {
      throw new Error("User dependency mismatch");
    }
    user.dep_code = new_dep_code;
    user.migrated = true;
    await user.save(session);
    const dependency = await Dependency.findOne({ dep_code });
    dependency.members = dependency.members.filter(member => member !== email);
    await dependency.save(session);

    const newDependency = await Dependency.findOne({ dep_code: new_dep_code });
    newDependency.members.push(email);
    await newDependency.save(session);
    
    await session.commitTransaction();
    res.status(200).json({ user });
  } catch (error) {
    await session.abortTransaction();
    res.status(500).json({ error: error.message });
  } finally {
    session.endSession();
  }
}

// Obtener todos los roles disponibles
userController.getAvailableRoles = async (req, res) => {
    try {
        res.status(200).json({ roles });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

userController.getAvailableProfiles = async (req, res) => {
    try {
        res.status(200).json({ profiles });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

userController.getAccessProfiles = async (req, res) => {
    try {
        const accessProfiles = await AccessProfile.find().sort({ name: 1 }).lean();
        res.status(200).json({ profiles: accessProfiles });
    } catch (error) {
        console.error('Error fetching access profiles:', error);
        res.status(500).json({ error: error.message });
    }
};

userController.createAccessProfile = async (req, res) => {
    const { name, positions = [], adminEmail } = req.body;

    try {
        const normalizedName = normalizeProfileName(name);
        const normalizedPositions = normalizePositions(positions);

        if (!normalizedName) {
            return res.status(400).json({ error: "Profile name is required" });
        }

        if (normalizedPositions.length === 0) {
            return res.status(400).json({ error: "At least one position is required" });
        }

        const adminUser = await User.findOne({ email: adminEmail, isActive: true });
        if (!adminUser) {
            return res.status(404).json({ error: "Admin user not found" });
        }

        const existingProfile = await AccessProfile.findOne({
            name: { $regex: `^${escapeRegex(normalizedName)}$`, $options: 'i' }
        });

        if (existingProfile) {
            return res.status(409).json({ error: "A profile with that name already exists" });
        }

        const accessProfile = await AccessProfile.create({
            name: normalizedName,
            positions: normalizedPositions,
            createdBy: adminEmail,
            updatedBy: adminEmail
        });

        await auditLogger.logCreate(req, adminUser, 'user', {
            sectionTitle: `Perfil ${normalizedName}`,
            positions: normalizedPositions
        });

        res.status(201).json({ profile: accessProfile });
    } catch (error) {
        console.error('Error creating access profile:', error);
        res.status(500).json({ error: error.message });
    }
};

userController.updateAccessProfile = async (req, res) => {
    const { id } = req.params;
    const { name, positions = [], adminEmail } = req.body;

    try {
        const normalizedName = normalizeProfileName(name);
        const normalizedPositions = normalizePositions(positions);

        if (!normalizedName) {
            return res.status(400).json({ error: "Profile name is required" });
        }

        if (normalizedPositions.length === 0) {
            return res.status(400).json({ error: "At least one position is required" });
        }

        const adminUser = await User.findOne({ email: adminEmail, isActive: true });
        if (!adminUser) {
            return res.status(404).json({ error: "Admin user not found" });
        }

        const existingProfile = await AccessProfile.findOne({
            _id: { $ne: id },
            name: { $regex: `^${escapeRegex(normalizedName)}$`, $options: 'i' }
        });

        if (existingProfile) {
            return res.status(409).json({ error: "A profile with that name already exists" });
        }

        const accessProfile = await AccessProfile.findByIdAndUpdate(
            id,
            {
                name: normalizedName,
                positions: normalizedPositions,
                updatedBy: adminEmail
            },
            { new: true }
        );

        if (!accessProfile) {
            return res.status(404).json({ error: "Profile not found" });
        }

        await auditLogger.logUpdate(req, adminUser, 'user', {
            sectionTitle: `Perfil ${normalizedName}`,
            positions: normalizedPositions
        });

        res.status(200).json({ profile: accessProfile });
    } catch (error) {
        console.error('Error updating access profile:', error);
        res.status(500).json({ error: error.message });
    }
};

userController.deleteAccessProfile = async (req, res) => {
    const { id } = req.params;
    const { adminEmail } = req.body;

    try {
        const adminUser = await User.findOne({ email: adminEmail, isActive: true });
        if (!adminUser) {
            return res.status(404).json({ error: "Admin user not found" });
        }

        const accessProfile = await AccessProfile.findByIdAndDelete(id);

        if (!accessProfile) {
            return res.status(404).json({ error: "Profile not found" });
        }

        await auditLogger.logDelete(req, adminUser, 'user', {
            sectionTitle: `Perfil ${accessProfile.name}`,
            positions: accessProfile.positions || []
        });

        res.status(200).json({ deleted: true });
    } catch (error) {
        console.error('Error deleting access profile:', error);
        res.status(500).json({ error: error.message });
    }
};

userController.getPositionViewPermissions = async (req, res) => {
    try {
        const requestedProfileId = req.query.profileId ? String(req.query.profileId).trim() : null;
        let requestedProfile = null;
        let requestedPositions = [];

        if (requestedProfileId) {
            if (!mongoose.Types.ObjectId.isValid(requestedProfileId)) {
                return res.status(400).json({ error: "Invalid profile id" });
            }

            requestedProfile = await AccessProfile.findById(requestedProfileId).lean();
            if (!requestedProfile) {
                return res.status(404).json({ error: "Profile not found" });
            }

            requestedPositions = normalizePositions(requestedProfile.positions || []);
        } else if (req.query.position) {
            requestedPositions = [normalizePosition(req.query.position)];
        }

        const users = await User.find(
            { isActive: true },
            { identification: 1, full_name: 1, email: 1, position: 1, dep_code: 1, isActive: 1 }
        )
            .sort({ position: 1, full_name: 1 })
            .lean();
        const depCodes = Array.from(new Set(users.map((user) => user.dep_code).filter(Boolean)));
        const dependencies = await Dependency.find(
            { dep_code: { $in: depCodes } },
            { dep_code: 1, name: 1 }
        ).lean();
        const dependencyByCode = new Map(
            dependencies.map((dependency) => [dependency.dep_code, dependency.name])
        );

        // Personas agregadas individualmente al perfil (sin vincular su cargo
        // completo). Se resuelven aparte de positionsByName para no mezclarlas
        // con "Cargos asociados" del perfil.
        const requestedIndividualMembers = Array.isArray(requestedProfile?.individualMembers)
            ? requestedProfile.individualMembers
            : [];
        const individualMembersSet = new Set(requestedIndividualMembers);
        const individualUsers = users
            .filter((user) => individualMembersSet.has(user.identification))
            .map((user) => ({
                _id: user._id,
                identification: user.identification,
                full_name: user.full_name,
                email: user.email,
                dep_code: user.dep_code,
                dependencyName: dependencyByCode.get(user.dep_code) || user.dep_code || "Sin dependencia",
                position: normalizePosition(user.position),
                isActive: user.isActive
            }));

        const positionsByName = users.reduce((groupedPositions, user) => {
            const positionName = normalizePosition(user.position);

            if (!groupedPositions.has(positionName)) {
                groupedPositions.set(positionName, {
                    position: positionName,
                    usersCount: 0,
                    users: []
                });
            }

            const position = groupedPositions.get(positionName);
            position.usersCount += 1;
            position.users.push({
                _id: user._id,
                identification: user.identification,
                full_name: user.full_name,
                email: user.email,
                dep_code: user.dep_code,
                dependencyName: dependencyByCode.get(user.dep_code) || user.dep_code || "Sin dependencia",
                isActive: user.isActive
            });

            return groupedPositions;
        }, new Map());

        const positions = Array.from(positionsByName.values())
            .sort((firstPosition, secondPosition) => firstPosition.position.localeCompare(secondPosition.position));
        requestedPositions.forEach((requestedPosition) => {
            if (!positions.some((position) => normalizePosition(position.position) === requestedPosition)) {
                positions.push({
                    position: requestedPosition,
                    usersCount: 0,
                    users: []
                });
            }
        });

        // Solo se listan todos los cargos cuando no se pidio un perfil/cargo
        // especifico. Si se pidio un perfil y este quedo sin cargos asociados,
        // el resultado debe ser vacio (no "todos"), a diferencia de la
        // convencion de ambitos/dependencias donde vacio significa "todos".
        const hasExplicitFilter = Boolean(requestedProfileId || req.query.position);
        const requestedPositionsSet = new Set(requestedPositions);
        const filteredPositions = !hasExplicitFilter
            ? positions
            : positions
                .filter((position) => requestedPositionsSet.has(normalizePosition(position.position)))
                .sort(
                    (firstPosition, secondPosition) =>
                        requestedPositions.indexOf(normalizePosition(firstPosition.position)) -
                        requestedPositions.indexOf(normalizePosition(secondPosition.position))
                );
        const positionNames = filteredPositions.map((position) => position.position);
        const savedPermissions = await PositionViewPermission.find({
            position: { $in: positionNames }
        });
        const permissionsByPosition = new Map(
            savedPermissions.map((permission) => [permission.position, permission])
        );

        // Cargar listas de ámbitos y dependencias disponibles
        const [allDimensions, allDependencies] = await Promise.all([
            Dimension.find({}, '_id name').sort({ name: 1 }).lean(),
            Dependency.find({}, '_id dep_code name').sort({ name: 1 }).lean()
        ]);

        // Obtener restricciones guardadas (tomar del primer cargo del perfil)
        const firstSaved = filteredPositions.length > 0
            ? permissionsByPosition.get(normalizePosition(filteredPositions[0].position))
            : null;

        // Personas excluidas individualmente del perfil aunque su cargo siga
        // vinculado (ver removeUserFromPosition). Se quitan de la lista de
        // "Personas activas" sin desvincular el cargo completo.
        const requestedExcludedMembers = Array.isArray(requestedProfile?.excludedMembers)
            ? requestedProfile.excludedMembers
            : [];
        const excludedMembersSet = new Set(requestedExcludedMembers);

        res.status(200).json({
            levels: profiles,
            views: viewPermissionOptions,
            allDimensions,
            allDependencies,
            profile: requestedProfile
                ? {
                    _id: requestedProfile._id,
                    name: requestedProfile.name,
                    positions: requestedPositions,
                    individualMembers: requestedIndividualMembers,
                    excludedMembers: requestedExcludedMembers,
                    createdBy: requestedProfile.createdBy || null,
                    updatedBy: requestedProfile.updatedBy || null,
                    createdAt: requestedProfile.createdAt || null,
                    updatedAt: requestedProfile.updatedAt || null
                }
                : null,
            positions: filteredPositions.map((position) => {
                const positionName = normalizePosition(position.position);
                const saved = permissionsByPosition.get(positionName);
                const visibleUsers = excludedMembersSet.size > 0
                    ? position.users.filter((positionUser) => !excludedMembersSet.has(positionUser.identification))
                    : position.users;

                return {
                    position: positionName,
                    usersCount: visibleUsers.length,
                    users: visibleUsers,
                    permissions: normalizeViewPermissions(saved?.permissions || {}),
                    allowed_dimensions: (saved?.allowed_dimensions || []).map(id => String(id)),
                    allowed_dependencies: (saved?.allowed_dependencies || []).map(id => String(id)),
                    updatedBy: saved?.updatedBy || null,
                    updatedAt: saved?.updatedAt || null
                };
            }),
            individualUsers
        });
    } catch (error) {
        console.error('Error fetching position view permissions:', error);
        res.status(500).json({ error: error.message });
    }
};

userController.addUserToPosition = async (req, res) => {
    const { position, profileId, identification, adminEmail } = req.body;

    try {
        const normalizedIdentification = normalizeIdentification(identification);

        if (!normalizedIdentification) {
            return res.status(400).json({ error: "Identification is required" });
        }

        const adminUser = await User.findOne({ email: adminEmail, isActive: true });
        if (!adminUser) {
            return res.status(404).json({ error: "Admin user not found" });
        }

        const user = await User.findOne({ identification: normalizedIdentification, isActive: true });
        if (!user) {
            return res.status(404).json({ error: "No active user was found with that identification" });
        }

        if (profileId) {
            const normalizedProfileId = String(profileId).trim();
            if (!mongoose.Types.ObjectId.isValid(normalizedProfileId)) {
                return res.status(400).json({ error: "Invalid profile id" });
            }

            const accessProfile = await AccessProfile.findById(normalizedProfileId);
            if (!accessProfile) {
                return res.status(404).json({ error: "Profile not found" });
            }

            const currentPosition = normalizePosition(user.position);
            const currentPositions = normalizePositions(accessProfile.positions || []);
            const currentIndividualMembers = Array.isArray(accessProfile.individualMembers)
                ? accessProfile.individualMembers
                : [];
            const currentExcludedMembers = Array.isArray(accessProfile.excludedMembers)
                ? accessProfile.excludedMembers
                : [];
            const coveredByPosition = currentPositions.includes(currentPosition);
            const wasExcluded = currentExcludedMembers.includes(normalizedIdentification);
            const alreadyIndividualMember = currentIndividualMembers.includes(normalizedIdentification);
            const wasAlreadyLinked = (coveredByPosition && !wasExcluded) || alreadyIndividualMember;

            if (coveredByPosition && wasExcluded) {
                // Su cargo esta vinculado pero se la habia excluido individualmente
                // (p.ej. al "Quitar"la antes): se re-incluye.
                accessProfile.excludedMembers = currentExcludedMembers.filter(
                    (memberId) => memberId !== normalizedIdentification
                );
                accessProfile.updatedBy = adminEmail;
                await accessProfile.save();
            } else if (!coveredByPosition && !alreadyIndividualMember) {
                // No pertenece a ningun cargo vinculado al perfil: se agrega
                // unicamente a esta persona (individualMembers), sin vincular todo
                // su cargo (eso daria acceso a todos los que lo comparten).
                accessProfile.individualMembers = [...currentIndividualMembers, normalizedIdentification];
                accessProfile.updatedBy = adminEmail;
                await accessProfile.save();
            }

            await auditLogger.logUpdate(req, adminUser, 'user', {
                sectionTitle: `Persona agregada al perfil ${accessProfile.name}`,
                userId: user._id,
                userEmail: user.email,
                identification: user.identification,
                profileId: accessProfile._id,
                profileName: accessProfile.name,
                position: currentPosition,
                wasAlreadyLinked
            });

            return res.status(200).json({
                user: formatPositionUser(user),
                profile: {
                    _id: accessProfile._id,
                    name: accessProfile.name,
                    positions: accessProfile.positions || [],
                    individualMembers: accessProfile.individualMembers || [],
                    excludedMembers: accessProfile.excludedMembers || []
                },
                position: currentPosition,
                wasAlreadyLinked
            });
        }

        const normalizedPosition = normalizePosition(position);
        if (!position) {
            return res.status(400).json({ error: "Position is required" });
        }

        const previousPosition = user.position;
        user.position = normalizedPosition;
        await user.save();

        await auditLogger.logUpdate(req, adminUser, 'user', {
            sectionTitle: `Usuario agregado al cargo ${normalizedPosition}`,
            userId: user._id,
            userEmail: user.email,
            identification: user.identification,
            previousPosition,
            position: normalizedPosition
        });

        res.status(200).json({
            user: formatPositionUser(user),
            previousPosition,
            position: normalizedPosition
        });
    } catch (error) {
        console.error('Error adding user to position:', error);
        res.status(500).json({ error: error.message });
    }
};

userController.removeUserFromPosition = async (req, res) => {
    const { position, profileId, identification, adminEmail } = req.body;

    try {
        const normalizedIdentification = normalizeIdentification(identification);

        if (!normalizedIdentification) {
            return res.status(400).json({ error: "Identification is required" });
        }

        const adminUser = await User.findOne({ email: adminEmail, isActive: true });
        if (!adminUser) {
            return res.status(404).json({ error: "Admin user not found" });
        }

        const user = await User.findOne({ identification: normalizedIdentification, isActive: true });
        if (!user) {
            return res.status(404).json({ error: "No active user was found with that identification" });
        }

        if (profileId) {
            const normalizedProfileId = String(profileId).trim();
            if (!mongoose.Types.ObjectId.isValid(normalizedProfileId)) {
                return res.status(400).json({ error: "Invalid profile id" });
            }

            const accessProfile = await AccessProfile.findById(normalizedProfileId);
            if (!accessProfile) {
                return res.status(404).json({ error: "Profile not found" });
            }

            const currentPosition = normalizePosition(user.position);
            const currentIndividualMembers = Array.isArray(accessProfile.individualMembers)
                ? accessProfile.individualMembers
                : [];
            const isIndividualMember = currentIndividualMembers.includes(normalizedIdentification);

            if (isIndividualMember) {
                // La persona fue agregada individualmente (no via cargo): se retira
                // solo a ella, sin afectar a nadie mas.
                accessProfile.individualMembers = currentIndividualMembers.filter(
                    (memberId) => memberId !== normalizedIdentification
                );
                accessProfile.updatedBy = adminEmail;
                await accessProfile.save();

                await auditLogger.logUpdate(req, adminUser, 'user', {
                    sectionTitle: `Persona removida del perfil ${accessProfile.name}`,
                    userId: user._id,
                    userEmail: user.email,
                    identification: user.identification,
                    profileId: accessProfile._id,
                    profileName: accessProfile.name,
                    position: currentPosition
                });

                return res.status(200).json({
                    user: formatPositionUser(user),
                    profile: {
                        _id: accessProfile._id,
                        name: accessProfile.name,
                        positions: accessProfile.positions || [],
                        individualMembers: accessProfile.individualMembers || [],
                        excludedMembers: accessProfile.excludedMembers || []
                    },
                    position: currentPosition,
                    removedIndividually: true
                });
            }

            // La persona pertenece al perfil via un cargo vinculado: se excluye
            // solo a ella (excludedMembers), sin desvincular el cargo completo,
            // que seguiria dando acceso a todos los demas que lo comparten. Para
            // desvincular el cargo por completo se usa "Editar perfil".
            const currentExcludedMembers = Array.isArray(accessProfile.excludedMembers)
                ? accessProfile.excludedMembers
                : [];
            if (!currentExcludedMembers.includes(normalizedIdentification)) {
                accessProfile.excludedMembers = [...currentExcludedMembers, normalizedIdentification];
                accessProfile.updatedBy = adminEmail;
                await accessProfile.save();
            }

            await auditLogger.logUpdate(req, adminUser, 'user', {
                sectionTitle: `Persona excluida del perfil ${accessProfile.name}`,
                userId: user._id,
                userEmail: user.email,
                identification: user.identification,
                profileId: accessProfile._id,
                profileName: accessProfile.name,
                position: currentPosition
            });

            return res.status(200).json({
                user: formatPositionUser(user),
                profile: {
                    _id: accessProfile._id,
                    name: accessProfile.name,
                    positions: accessProfile.positions || [],
                    individualMembers: accessProfile.individualMembers || [],
                    excludedMembers: accessProfile.excludedMembers || []
                },
                position: currentPosition,
                excludedFromPosition: true
            });
        }

        const normalizedPosition = normalizePosition(position);
        if (!position) {
            return res.status(400).json({ error: "Position is required" });
        }

        if (normalizePosition(user.position) !== normalizedPosition) {
            return res.status(400).json({ error: "The user does not belong to this position" });
        }

        const previousPosition = user.position;
        user.position = "N/A";
        await user.save();

        await auditLogger.logUpdate(req, adminUser, 'user', {
            sectionTitle: `Usuario removido del cargo ${normalizedPosition}`,
            userId: user._id,
            userEmail: user.email,
            identification: user.identification,
            previousPosition,
            position: user.position
        });

        res.status(200).json({
            user: formatPositionUser(user),
            previousPosition,
            position: normalizedPosition
        });
    } catch (error) {
        console.error('Error removing user from position:', error);
        res.status(500).json({ error: error.message });
    }
};

userController.updatePositionViewPermissions = async (req, res) => {
    const { position, positions = [], profileId, permissions = {}, adminEmail, allowed_dimensions = [], allowed_dependencies = [] } = req.body;

    try {
        let accessProfile = null;
        let normalizedPositions = [];

        if (profileId) {
            const normalizedProfileId = String(profileId).trim();
            if (!mongoose.Types.ObjectId.isValid(normalizedProfileId)) {
                return res.status(400).json({ error: "Invalid profile id" });
            }

            accessProfile = await AccessProfile.findById(normalizedProfileId).lean();
            if (!accessProfile) {
                return res.status(404).json({ error: "Profile not found" });
            }

            normalizedPositions = normalizePositions(accessProfile.positions || []);
        } else {
            normalizedPositions = normalizePositions(
                Array.isArray(positions) && positions.length > 0 ? positions : position ? [position] : []
            );
        }

        if (normalizedPositions.length === 0) {
            return res.status(400).json({ error: "At least one position is required" });
        }

        const adminUser = await User.findOne({ email: adminEmail });
        if (!adminUser) {
            return res.status(404).json({ error: "Admin user not found" });
        }

        const normalizedPermissions = normalizeViewPermissions(permissions);

        // Validar que al menos un permiso esté seleccionado
        const totalPermissions = Object.values(normalizedPermissions).reduce((count, profiles) => count + profiles.length, 0);
        if (totalPermissions === 0) {
            return res.status(400).json({ error: "Debe seleccionar al menos un permiso de vista antes de guardar" });
        }

        const permissionConfigs = await Promise.all(
            normalizedPositions.map((normalizedPosition) =>
                PositionViewPermission.findOneAndUpdate(
                    { position: normalizedPosition },
                    {
                        position: normalizedPosition,
                        permissions: normalizedPermissions,
                        allowed_dimensions: allowed_dimensions.filter(id => mongoose.Types.ObjectId.isValid(id)),
                        allowed_dependencies: allowed_dependencies.filter(id => mongoose.Types.ObjectId.isValid(id)),
                        updatedBy: adminEmail
                    },
                    { new: true, upsert: true, setDefaultsOnInsert: true }
                )
            )
        );

        await auditLogger.logUpdate(req, adminUser, 'user', {
            sectionTitle: accessProfile
                ? `Permisos perfil ${accessProfile.name}`
                : normalizedPositions.length === 1
                    ? `Permisos cargo ${normalizedPositions[0]}`
                    : `Permisos cargos ${normalizedPositions.length}`,
            userEmail: adminEmail,
            profile: accessProfile
                ? {
                    id: accessProfile._id,
                    name: accessProfile.name
                }
                : null,
            positions: normalizedPositions,
            viewPermissions: normalizedPermissions
        });

        const formattedPositions = permissionConfigs.map((permissionConfig) => ({
            position: permissionConfig.position,
            permissions: normalizeViewPermissions(permissionConfig.permissions || {}),
            allowed_dimensions: (permissionConfig.allowed_dimensions || []).map(id => String(id)),
            allowed_dependencies: (permissionConfig.allowed_dependencies || []).map(id => String(id)),
            updatedBy: permissionConfig.updatedBy,
            updatedAt: permissionConfig.updatedAt
        }));
        const primaryPermissionConfig = formattedPositions[0];

        res.status(200).json({
            profile: accessProfile
                ? {
                    _id: accessProfile._id,
                    name: accessProfile.name,
                    positions: normalizedPositions
                }
                : null,
            positions: formattedPositions,
            position: primaryPermissionConfig?.position,
            permissions: primaryPermissionConfig?.permissions || normalizedPermissions,
            updatedBy: primaryPermissionConfig?.updatedBy || adminEmail,
            updatedAt: primaryPermissionConfig?.updatedAt || null
        });
    } catch (error) {
        console.error('Error updating position view permissions:', error);
        res.status(500).json({ error: error.message });
    }
};

const validateRoles = (userRoles) => {
    return userRoles.every(role => roles.includes(role));
}

const validateProfiles = (userProfiles) => {
    return userProfiles.every(profile => profiles.includes(profile));
}

const normalizePosition = (position) => {
    return typeof position === "string" && position.trim()
        ? position.trim()
        : "Sin cargo";
}

const normalizeIdentification = (identification) => {
    if (identification === undefined || identification === null) return null;

    const normalized = Number(String(identification).trim());
    return Number.isFinite(normalized) ? normalized : null;
}

const normalizeProfileName = (name) => {
    return typeof name === "string" ? name.trim() : "";
}

const normalizePositions = (positions) => {
    const source = Array.isArray(positions) ? positions : [positions].filter(Boolean);
    return Array.from(new Set(source.map(normalizePosition).filter(Boolean)));
}

const escapeRegex = (value) => {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const formatPositionUser = (user) => ({
    _id: user._id,
    identification: user.identification,
    full_name: user.full_name,
    email: user.email,
    dep_code: user.dep_code,
    position: user.position,
    isActive: user.isActive
});

const normalizeViewPermissions = (rawPermissions) => {
    const validViews = new Set(viewPermissionOptions.map((view) => view.key));
    const validProfiles = new Set(profiles);
    const source = rawPermissions && typeof rawPermissions.toObject === "function"
        ? rawPermissions.toObject()
        : rawPermissions || {};

    return Object.entries(source).reduce((normalized, [viewKey, values]) => {
        if (!validViews.has(viewKey)) {
            return normalized;
        }

        const permissionValues = Array.isArray(values) ? values : [];
        const cleanValues = Array.from(new Set(permissionValues))
            .filter((profile) => validProfiles.has(profile));

        if (cleanValues.length > 0) {
            normalized[viewKey] = cleanValues;
        }

        return normalized;
    }, {});
}

module.exports = userController
