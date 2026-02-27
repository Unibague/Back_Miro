const mongoose = require('mongoose');

const phaseDocumentSchema = new mongoose.Schema(
  {
    phase_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'phases',
      required: true,
    },
    process_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'processes',
      required: false,
    },
    name: {
      type: String,
      required: true,
    },
    drive_id: {
      type: String,
      required: true,
    },
    view_link: {
      type: String,
      required: true,
    },
    download_link: {
      type: String,
      required: true,
    },
    mime_type: {
      type: String,
      default: null,
    },
    size: {
      type: Number,
      default: null,
    },
  },
  {
    versionKey: false,
    timestamps: true,
  }
);

module.exports = mongoose.model('phaseDocuments', phaseDocumentSchema);

