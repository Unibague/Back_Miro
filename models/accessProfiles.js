const mongoose = require('mongoose');

const accessProfileSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true
    },
    positions: {
      type: [String],
      default: []
    },
    createdBy: {
      type: String,
      default: null
    },
    updatedBy: {
      type: String,
      default: null
    }
  },
  {
    versionKey: false,
    timestamps: true
  }
);

module.exports = mongoose.model('accessProfiles', accessProfileSchema);
