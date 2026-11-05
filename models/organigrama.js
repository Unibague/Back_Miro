const mongoose = require('mongoose');

// Tipos de unidad del organigrama institucional
const TIPOS = [
    'Órgano de gobierno',
    'Rectoría',
    'Vicerrectoría',
    'Dirección',
    'Gerencia',
    'Facultad',
    'Escuela',
    'Área',
    'Programa',
    'Unidad académica',
    'Unidad administrativa',
    'Otra',
];

// 'linea': cadena de mando (caja principal). 'staff': unidad de apoyo o asesora
// que cuelga al lado de su padre (cajas doradas del organigrama).
const RELACIONES = ['linea', 'staff'];

const NIVELES = ['Pregrado', 'Posgrado'];

const organigramaSchema = new mongoose.Schema({
    nombre:      { type: String, required: true, trim: true },
    tipo:        { type: String, enum: TIPOS, default: 'Otra' },
    relacion:    { type: String, enum: RELACIONES, default: 'linea' },
    // Solo para tipo Programa
    nivel:       { type: String, enum: [...NIVELES, null], default: null },
    // Nodo padre; null = raíz del organigrama
    parent:      { type: mongoose.Schema.Types.ObjectId, ref: 'organigrama', default: null },
    orden:       { type: Number, default: 0 },
    // Vínculo opcional con la dependencia sincronizada del sistema externo.
    // El organigrama NO modifica dep_father: la sincronización lo sobrescribiría.
    dep_code:    { type: String, default: null },
    descripcion: { type: String, default: '' },
    active:      { type: Boolean, default: true },
}, {
    versionKey: false,
    timestamps: true,
});

organigramaSchema.index({ parent: 1, orden: 1 });
organigramaSchema.index({ dep_code: 1 });

module.exports = mongoose.model('organigrama', organigramaSchema, 'organigrama');
module.exports.TIPOS = TIPOS;
module.exports.RELACIONES = RELACIONES;
module.exports.NIVELES = NIVELES;
