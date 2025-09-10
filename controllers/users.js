//const { loadEnvFile } = require("process");
const axios = require('axios');
const User = require('../models/users');
const Dependency = require('../models/dependencies');
const dependencyController = require('./dependencies.js');
const { default: mongoose } = require('mongoose');
const periodController = require('./periods.js');
const PendingUserChanges = require('../models/pendingUserChanges');

const userController = {}

USERS_ENDPOINT = process.env.USERS_ENDPOINT;

const roles = ["Administrador", "Responsable", "Productor","Usuario"];

userController.addExternalUser = async (req, res) => {
    const dep_code = req.body.dep_code;

    const email = req.body.email;

    await dependencyController.addUserToDependency(dep_code, email);
    const user = new User( req.body )
    await user.save();
    res.status(200).json({status: "User created"});
}

userController.loadUsers = async (req, res) => {
    try {
        dependencyController.loadDependencies();

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
                    { roles: { $regex: search, $options: 'i' } }
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
    try {
        const user = await User.findOne({ _id: id });
        if (!user) {
            return res.status(404).json({ error: "User not found in DB" });
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
        if (user) {
            res.status(200).json({ roles: user.roles, activeRole: user.activeRole });
        } else {
            res.status(404).json({ error: "User not found" });
        }
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
    try {
        if(!validateRoles(roles)) {
            throw new Error("Invalid roles");
        }
        const user = await User.findOneAndUpdate(
            { email },
            { roles },
            { new: true }
        );
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }
        res.status(200).json({ user });
    } catch (error){
        res.status(500).json({ error: error.message });
    }
    
}

userController.updateUsersToProducer = async (req, res) => {
    const rolesToUpdate = req.body;
    try {
        const updatePromises = rolesToUpdate.map(async ({ email, roles }) => {
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
    const { userId, isActive } = req.body;

    try {
        const user = await User.findByIdAndUpdate(
            userId,
            { isActive },
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

userController.getUsersByDependency = async (req, res) => {
    const { dep_code } = req.params;
    try {
        const users = await User.find({ dep_code });
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

const validateRoles = (userRoles) => {
    return userRoles.every(role => roles.includes(role));
}

module.exports = userController
