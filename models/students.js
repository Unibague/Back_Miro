const mongoose = require('mongoose')

const studentsSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  email: {
    type: String,
    required: true,
    index: true,
  },
  code_student: {
    type: String,
    index: true,
  },
  identification: {
    type: String,
    required: true,
    index: true,
  },
  program_code: {
    type: String,
  },
  program: {
    type: String
  },
  status: {
    type: String,
    required: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  }
},
{
    versionKey: false,
    timestamps: true
}
);

//Perform an upsert operation
studentsSchema.statics.syncUsers = async function (externalUsers) {
  const Student = this;

  // Use bulkWrite to perform upsert operations
  const updateOps = externalUsers.map(externalUser => ({
    updateOne: {
      filter: { email: externalUser.email },
      update: { $set: { ...externalUser, isActive: true } },
      upsert: true
    }
  }));

  await Student.bulkWrite(updateOps);
}

module.exports = mongoose.model('students', studentsSchema);