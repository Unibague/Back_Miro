const mongoose = require('mongoose');
const User = require('./users');

const dependencySchema = new mongoose.Schema({
    dep_code: {
        type: String,
        required: true,
        unique: true
    },
    name: {
        type: String,
        required: true,
        unique: true
    },
    members: {
        type: [String]
    },
    responsible: {
        type: String
    },
    dep_father: {
        type: String
    },
    visualizers: {
        type: [String], 
        default: []
    }
},
{
    versionKey: false,
    timestamps: true
});

// Middleware pre-save para validar el email
dependencySchema.pre('save', async function(next) {
    if (this.isModified('responsible')) { // Verifica si el campo 'responsible' ha sido modificado
        try {
            const user = await User.findOne({ email: this.responsible });
            if (!user) {
              this.responsible = undefined;
            }
        } catch (error) {
            return next(error);
        }
    }
    next();
});

// udpdate visualizers
dependencySchema.statics.updateVisualizers = async function(dep_code, visualizers) {
    try {
        const dependency = await this.findOne({ dep_code });
        if (!dependency) {
            throw new Error('Dependency not found');
        }

        dependency.visualizers = visualizers;
        await dependency.save();
        return dependency;
    } catch (error) {
        console.error("Error updating visualizers:", error);
        throw error;
    }
};
dependencySchema.statics.upsertDependencies = async function(dependencies) {
    const normalizedDependencies = dependencies
      .map((dep) => ({
        ...dep,
        dep_code: String(dep.dep_code ?? '').trim(),
        name: String(dep.name ?? '').trim(),
        dep_father: dep.dep_father === null || dep.dep_father === undefined || String(dep.dep_father).trim() === ''
          ? null
          : String(dep.dep_father).trim(),
      }))
      .filter((dep) => dep.dep_code && dep.name);

    if (normalizedDependencies.length === 0) {
      throw new Error('El sistema externo no devolvió dependencias válidas; se canceló la sincronización para evitar eliminar toda la colección.');
    }

    const bulkOps = normalizedDependencies.map(dep => ({
        updateOne: {
            filter: { dep_code: dep.dep_code },
            update: { $set: dep },
            upsert: true
        }
    }));

    await this.bulkWrite(bulkOps);

    const newDepCodes = [...new Set(normalizedDependencies.map(dep => dep.dep_code))];
    const deleteResult = await this.deleteMany({ dep_code: { $nin: newDepCodes } });

    return {
      syncedCount: normalizedDependencies.length,
      deletedCount: deleteResult.deletedCount || 0,
      depCodes: newDepCodes,
    };
};

dependencySchema.statics.addUserToDependency = async function(dep_code, user) {
    try {
        console.log(`=== DEBUG addUserToDependency: ${user} -> ${dep_code} ===`);
        
        // Buscar si el usuario ya está en la dependencia especificada
        const currentDependency = await this.findOne({ dep_code, members: user });
        console.log('User already in target dependency:', currentDependency ? 'YES' : 'NO');

        if (currentDependency) {
            console.log('User already in dependency, skipping...');
            return;
        }

        // Eliminar al usuario de cualquier otra dependencia en la que se encuentre actualmente
        const removeResult = await this.updateMany(
            { members: user },
            { $pull: { members: user } }
        );
        console.log('Removed from other dependencies:', removeResult.modifiedCount);

        // Añadir al usuario a la nueva dependencia
        const newDependency = await this.findOne({ dep_code });
        if (!newDependency) {
            console.log("Specified dependency not found:", dep_code);
            return;
        }
        
        console.log('Target dependency found:', newDependency.name);
        console.log('Current members count:', newDependency.members.length);

        newDependency.members.push(user);
        await newDependency.save();
        console.log(`User ${user} added to dependency ${newDependency.name}`);
        console.log('New members count:', newDependency.members.length);

    } catch (error) {
        console.error('Error in addUserToDependency:', error);
    }
};

dependencySchema.statics.getMembersWithFather = async function(dep_code) {
    return this.aggregate([
        // Filtra las dependencias por el código de dependencia especificado
        { $match: { dep_code } },
        {
            $lookup: {
                from: "users",
                localField: "members",
                foreignField: "email",
                as: "members"
            }
        },
        {
            $lookup: {
                from: "dependencies",
                localField: "dep_father",
                foreignField: "dep_code",
                as: "father"
            }
        },
        // Desenreda la dependencia padre, si existe
        { $unwind: { path: "$father", preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: "users",
                let: { fatherMembers: "$father.members" },
                pipeline: [
                    { $match: { $expr: { $in: ["$email", "$$fatherMembers"] } } }
                ],
                as: "fatherMembers"
            }
        },
        {
            $project: {
                members: 1,
                fatherMembers: 1
            }
        }
    ]);
};

dependencySchema.statics.getWithChildren = async function(dep_code) {
    return this.findOne({ dep_code })
        .populate("childDependencies") // Fetch child dependencies
        .exec();
};


module.exports = mongoose.model('dependencies', dependencySchema);
