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
    allowed_dimensions: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'dimensions',
      default: []
    },
    allowed_dependencies: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: 'dependencies',
      default: []
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
