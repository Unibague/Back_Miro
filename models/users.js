    const mongoose = require('mongoose')

    const userSchema = new mongoose.Schema({

        identification: {
            type: Number,
            index: true,
            required: true
        },
        full_name: {
            type: String,
            required: true
        },
        position: {
            type: String,
            required: true
        },              
        roles: {
            type: [String],
            default: ["Usuario"]
        },
        activeRole: {
            type: String,   
            default: "Usuario",
        },
        email: {
            type: String,
            required: true,
            index: true
        },
        isActive: {
          type: Boolean,
          default: true,
        },
        migrated: {
          type: Boolean,
          default: false,
        },
        dep_code: String,
        additional_dependencies: {
            type: [String],
            default: []
        }
        
    },
    {
        versionKey: false,
        timestamps: true
    }
    );

    userSchema.statics.syncUsers = async function (externalUsers) {
        const User = this;

        // Create a set of emails from external users for efficient look-up
        const emailSet = new Set(externalUsers.map(user => user.email));

        // Use bulkWrite to perform upsert operations
        const updateOps = externalUsers.map(externalUser => ({
          updateOne: {
            filter: { email: externalUser.email, migrated: { $ne: true } },
            update: { $set: { ...externalUser, isActive: true } },
            upsert: true
          }
        }));

        // Perform bulkWrite for upserting users
        await User.bulkWrite(updateOps);

        // // Deactivate users not in the external users list, but only if they are not migrated
        // await User.updateMany(
        //   { email: { $nin: Array.from(emailSet) }, migrated: { $ne: true } },
        //   { $set: { isActive: false } }
        // );
    };

    userSchema.statics.updateAdditionalDependencies = async function(email, dependencies) {
        return this.findOneAndUpdate(
            { email },
            { $set: { additional_dependencies: dependencies } },
            { new: true }
        );
    };

    userSchema.statics.getUsersWithAllDependencies = async function() {
        return this.aggregate([
            {
                $lookup: {
                    from: "dependencies",
                    localField: "dep_code",
                    foreignField: "dep_code",
                    as: "primary_dependency"
                }
            },
            {
                $lookup: {
                    from: "dependencies",
                    localField: "additional_dependencies",
                    foreignField: "dep_code",
                    as: "additional_deps"
                }
            },
            {
                $project: {
                    identification: 1,
                    full_name: 1,
                    email: 1,
                    dep_code: 1,
                    additional_dependencies: 1,
                    primary_dependency: { $arrayElemAt: ["$primary_dependency", 0] },
                    additional_deps: 1
                }
            }
        ]);
    };

    module.exports = mongoose.model('users', userSchema);