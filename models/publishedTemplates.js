const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const User = require('./users.js')
const Template = require('./templates.js')
const Dependency = require('./dependencies.js')

const filled_fields = new Schema({
    sheet_name: {
        type: Schema.Types.String,
        required: false
    },
    field_name: {
        type: Schema.Types.String,
        ref: 'templates.fields',
        required: true
    },
    values: {
        type: [{}],
        required: true
    }
}, {
    _id: false
})

// FIX

const producersData = new Schema({
    dependency: {
        type: Schema.Types.String,
        ref: 'dependencies',
        required: true
    },
    send_by: {
        type: {},
        required: true
    },
    loaded_date: {
        type: Date,
        required: true
    },
    filled_data: {
      type: [filled_fields]
    },
    source: {
        type: String,
        enum: ['excel', 'qr', 'online', 'manual'],
        default: 'manual'
    }
}, {
    _id: false
})

const publishedTemplateSchema = new Schema({
  name: String,
  published_by: {
    type: User.schema,
    required: true
  },
  template: {},
  period: {
    type: Schema.Types.ObjectId,
    ref: 'periods',
    required: true
  },
  loaded_data: {
    type: [producersData],
    validate: {
      validator: function (v) {
        const uniqueDependencies = new Set(v.map(ld => ld.dependency));
        return uniqueDependencies.size === v.length;
      },
      message: props => `Dependency already uploaded data: ${props.value.map(ld => ld.dependency).join(', ')}`
    }
  },
  qr_draft_data: {
    type: [producersData],
    default: []
  },
  deadline: {
    type: Date,
    required: false
  },
  fecha_inicio: {
    type: Date,
    required: false
  },
  fecha_final_productores: {
    type: Date,
    required: false
  },
  fecha_final_responsables: {
    type: Date,
    required: false
  },
  fecha_final: {
    type: Date,
    required: false
  },
  responsible_producers: {
    type: [Schema.Types.ObjectId],
    ref: 'dependencies',
    default: []
  },
  notify_producers: {
    type: Boolean,
    default: false
  },
  published_date: {
    type: Date,
    required: true
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'categories'
  },
  final_submitted: {
    type: Boolean,
    default: false
  },
  final_submitted_by: {
    type: {},
    required: false
  },
  final_submitted_date: {
    type: Date,
    required: false
  },
}, {
  versionKey: false,
  timestamps: true
});

publishedTemplateSchema.index({ period: 1, name: 1 }, { unique: true });

publishedTemplateSchema.pre('validate', async function (next) {
  if (this.isNew) {
    const existingTemplate = await mongoose.models.publishedTemplates.findOne({
      period: this.period,
      name: this.name
    });

    if (existingTemplate) {
      return next(new Error('A template with the same name has already been published for this period.'));
    }
  }

  next();
});


module.exports = mongoose.model('publishedTemplates', publishedTemplateSchema);
