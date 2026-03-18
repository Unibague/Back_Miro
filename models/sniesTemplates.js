const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const sniesTemplateSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    file_name: {
      type: String,
      required: true,
      trim: true,
    },
    created_by: {
      type: {},
      required: true,
    },
    period: {
      type: Schema.Types.ObjectId,
      ref: "periods",
      required: false,
    },
    source_published_template_id: {
      type: Schema.Types.ObjectId,
      ref: "publishedTemplates",
      required: false,
    },
    source_published_template_name: {
      type: String,
      required: false,
      trim: true,
    },
    source_published_templates: {
      type: [
        {
          _id: false,
          template_id: {
            type: Schema.Types.ObjectId,
            ref: "publishedTemplates",
            required: true,
          },
          template_name: {
            type: String,
            required: true,
            trim: true,
          },
        },
      ],
      default: [],
    },
    drive_file_id: {
      type: String,
      required: true,
    },
    drive_file_link: {
      type: String,
      required: false,
    },
    drive_file_download: {
      type: String,
      required: false,
    },
    active: {
      type: Boolean,
      default: true,
      required: true,
    },
  },
  {
    versionKey: false,
    timestamps: true,
  }
);

module.exports = mongoose.model("sniesTemplates", sniesTemplateSchema);
