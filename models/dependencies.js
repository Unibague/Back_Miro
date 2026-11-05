const mongoose = require('mongoose');
const User = require('./users');
// Registra el modelo del historial de sincronizaciones (lo usa upsertDependencies)
require('./dependencySyncLogs');

const dependencySchema = new mongoose.Schema({
    dep_code: {
        type: String,
        required: true,
        unique: true
    },
    // No es único: si el sistema externo cambia el código de una dependencia
    // y conserva el nombre, la anterior queda inactiva con el mismo nombre.
    name: {
        type: String,
        required: true,
        index: true
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
    },
    active: {
        type: Boolean,
        default: true
    },
    // Fecha en que quedó inactiva (sincronización o desactivación manual)
    inactive_since: {
        type: Date,
        default: null
    },
    // Código de la dependencia que la reemplazó (mismo nombre, código nuevo)
    replaced_by: {
        type: String,
        default: null
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
const normalizarNombre = (texto = '') => String(texto)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();

// Las bases creadas con la versión anterior del esquema tienen un índice único
// en "name"; se cambia por uno normal para que una dependencia inactiva y la
// que la reemplazó (código nuevo) puedan tener el mismo nombre.
let nameIndexChecked = false;
dependencySchema.statics.ensureNameIndexNotUnique = async function() {
    if (nameIndexChecked) return;
    const indexes = await this.collection.indexes();
    const nameIndex = indexes.find((idx) => idx.key && idx.key.name === 1 && Object.keys(idx.key).length === 1);
    if (nameIndex?.unique) {
        await this.collection.dropIndex(nameIndex.name);
        await this.collection.createIndex({ name: 1 });
        console.log('Índice único de nombre de dependencias reemplazado por uno no único');
    }
    nameIndexChecked = true;
};

dependencySchema.statics.upsertDependencies = async function(dependencies, { origen = 'dependencias', ejecutado_por = '' } = {}) {
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

    await this.ensureNameIndexNotUnique();

    // ── Diferencias contra lo que hay en la base ──
    const recibidas = new Map(normalizedDependencies.map((dep) => [dep.dep_code, dep]));
    const existentes = await this.find({}, 'dep_code name dep_father active').lean();
    const porCodigo = new Map(existentes.map((dep) => [dep.dep_code, dep]));

    const cambios = [];
    const creadas = [];
    for (const dep of recibidas.values()) {
      const previa = porCodigo.get(dep.dep_code);
      if (!previa) {
        creadas.push(dep);
        cambios.push({ tipo: 'creada', dep_code: dep.dep_code, nombre: dep.name });
        continue;
      }
      if (previa.active === false) {
        cambios.push({ tipo: 'reactivada', dep_code: dep.dep_code, nombre: dep.name });
      }
      if ((previa.name || '') !== dep.name) {
        cambios.push({ tipo: 'modificada', dep_code: dep.dep_code, nombre: dep.name, campo: 'Nombre', antes: previa.name || null, despues: dep.name });
      }
      if ((previa.dep_father || null) !== dep.dep_father) {
        cambios.push({ tipo: 'modificada', dep_code: dep.dep_code, nombre: dep.name, campo: 'Dependencia padre', antes: previa.dep_father || null, despues: dep.dep_father });
      }
    }

    // Las dependencias nunca se eliminan de la base de datos: si el sistema
    // externo deja de reportar un dep_code, se marca como inactiva (active:
    // false) en vez de borrarla, para que los históricos (envíos, reportes,
    // tableros) puedan seguir resolviendo su nombre. Si vuelve a aparecer en
    // una sincronización futura, se reactiva automáticamente. Si en su lugar
    // aparece un código nuevo con el mismo nombre, se registra el reemplazo.
    const nuevasPorNombre = new Map(creadas.map((dep) => [normalizarNombre(dep.name), dep]));
    const reemplazos = [];
    for (const dep of existentes) {
      if (recibidas.has(dep.dep_code)) continue;
      const nueva = nuevasPorNombre.get(normalizarNombre(dep.name));
      if (nueva) {
        reemplazos.push({ dep_code: dep.dep_code, replaced_by: nueva.dep_code });
        cambios.push({
          tipo: 'reemplazada', dep_code: dep.dep_code, nombre: dep.name,
          reemplazada_por: nueva.dep_code, reemplazada_por_nombre: nueva.name,
        });
      } else if (dep.active !== false) {
        cambios.push({ tipo: 'desactivada', dep_code: dep.dep_code, nombre: dep.name });
      }
    }

    // ── Escritura ──
    const bulkOps = [...recibidas.values()].map(dep => ({
        updateOne: {
            filter: { dep_code: dep.dep_code },
            update: { $set: { ...dep, active: true, inactive_since: null, replaced_by: null } },
            upsert: true
        }
    }));
    await this.bulkWrite(bulkOps);

    const newDepCodes = [...recibidas.keys()];
    const deactivateResult = await this.updateMany(
      { dep_code: { $nin: newDepCodes }, active: { $ne: false } },
      { $set: { active: false, inactive_since: new Date() } }
    );

    if (reemplazos.length > 0) {
      await this.bulkWrite(reemplazos.map((r) => ({
        updateOne: { filter: { dep_code: r.dep_code }, update: { $set: { replaced_by: r.replaced_by } } },
      })));
    }

    const contar = (tipo) => cambios.filter((c) => c.tipo === tipo).length;
    const resumen = {
      creadas: contar('creada'),
      reactivadas: contar('reactivada'),
      modificadas: new Set(cambios.filter((c) => c.tipo === 'modificada').map((c) => c.dep_code)).size,
      desactivadas: contar('desactivada'),
      reemplazadas: contar('reemplazada'),
    };

    // Historial: solo se guarda cuando hubo cambios
    let logId = null;
    if (cambios.length > 0) {
      const DependencySyncLog = mongoose.model('dependencySyncLogs');
      const log = await DependencySyncLog.create({
        origen,
        ejecutado_por,
        total_recibidas: recibidas.size,
        resumen,
        cambios,
      });
      logId = log._id;
    }

    return {
      syncedCount: recibidas.size,
      deactivatedCount: deactivateResult.modifiedCount || 0,
      depCodes: newDepCodes,
      resumen,
      cambios,
      logId,
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
