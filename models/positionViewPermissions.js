const mongoose = require('mongoose');

const positionViewPermissionSchema = new mongoose.Schema(
  {
    position: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true
    },
    permissions: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
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

module.exports = mongoose.model('positionViewPermissions', positionViewPermissionSchema);
