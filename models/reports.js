const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const reportSchema = new Schema({
    name: {
        type: String,
        required: true,
        unique: true
    },
    description: {
        type: String,
        required: false
    },
    report_example_id: {
        type: String
    },
    report_example_link: {
        type: String
    },
    report_example_download: {
        type: String
    },
    requires_attachment: {
        type: Boolean,
        required: true
    },
    file_name: {
        type: String,
        required: true
    },
    created_by: {
        type: {},
        required: true
    },
    dimensions: {
      type: [Schema.Types.ObjectId],
      ref: "dimensions",
      validate: [
        {
          validator: function (v) {
            return v.length > 0;
          },
          message: "At least one dimension is required",
        },
      ],
      required: true,
    },
    ai_generation: {
      type: Schema.Types.Mixed,
      required: false,
    }
}, {
    versionKey: false,
    timestamps: true
})

module.exports = mongoose.model('reports', reportSchema)
