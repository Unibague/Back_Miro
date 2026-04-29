const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const allowedDataTypes = [
  "Entero",
  "Decimal",
  "Porcentaje",
  "Texto Corto",
  "Texto Largo",
  "True/False",
  "Fecha",
  "Fecha Inicial / Fecha Final",
  "Link",
];

const fieldSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    worksheet_name: {
      type: String,
      required: false,
      trim: true,
      default: "",
    },
    insert_after: {
      type: String,
      required: false,
      trim: true,
      default: "",
    },
    datatype: {
      type: String,
      required: true,
      enum: allowedDataTypes,
    },
    required: {
      type: Boolean,
      required: true,
      default: true,
    },
    validate_with: {
      type: String,
      required: false,
      default: "",
    },
    comment: {
      type: String,
      required: false,
      default: "",
    },
    field_origin: {
      type: String,
      required: true,
      enum: ["snies_original", "snies_extra"],
      default: "snies_extra",
    },
    visible_for_producer: {
      type: Boolean,
      required: true,
      default: true,
    },
    export_to_snies: {
      type: Boolean,
      required: true,
      default: false,
    },
    multiple: {
      type: Boolean,
      required: true,
      default: false,
    },
  },
  {
    _id: false,
    versionKey: false,
  }
);

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
    file_description: {
      type: String,
      required: false,
      trim: true,
      default: "",
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
    fields: {
      type: [fieldSchema],
      default: [],
      required: false,
    },
    dimensions: {
      type: [Schema.Types.ObjectId],
      ref: "dimensions",
      default: [],
      required: false,
    },
    producers: {
      type: [Schema.Types.ObjectId],
      ref: "dependencies",
      default: [],
      required: false,
    },
    field_equivalences: {
      type: Schema.Types.Mixed,
      default: {},
      required: false,
    },
  },
  {
    versionKey: false,
    timestamps: true,
  }
);

module.exports = mongoose.model("sniesTemplates", sniesTemplateSchema);
