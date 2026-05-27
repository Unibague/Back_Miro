const mongoose = require('mongoose');

const pdiRazonRechazoSchema = new mongoose.Schema({
    texto:  { type: String, required: true, trim: true },
    activo: { type: Boolean, default: true },
    orden:  { type: Number, default: 0 },
}, {
    versionKey: false,
    timestamps: true,
});

module.exports = mongoose.model('pdiRazonRechazo', pdiRazonRechazoSchema);
