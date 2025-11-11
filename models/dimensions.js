const mongoose = require('mongoose')
const User = require('./users');
const Dependency = require('./dependencies');
const Schema = mongoose.Schema;

const dimensionSchema = new mongoose.Schema({

    name: {
        type: String,
        required: true,
        unique: true
    },
    responsible: {
      type: Schema.Types.ObjectId,
      ref: 'dependencies',
      required: true
    }
},
{
    versionKey: false,
    timestamps: true
}
);

module.exports = mongoose.model('dimensions', dimensionSchema);