const mongoose = require('mongoose');

// Tipos de cambio permitidos en el PDI
const TIPOS_CAMBIO = ['alcance', 'meta', 'cronograma', 'presupuesto', 'responsable', 'otro'];
// Entidades sobre las que se puede solicitar un cambio
const TIPOS_ENTIDAD = ['macroproyecto', 'proyecto', 'accion', 'indicador'];
// Estados del flujo de aprobación
const ESTADOS = ['Pendiente', 'En Revisión', 'Aprobado', 'Rechazado'];

const pdiSolicitudCambioSchema = new mongoose.Schema({
    // Entidad afectada
    entidad_tipo:       { type: String, enum: TIPOS_ENTIDAD, required: true },
    entidad_id:         { type: mongoose.Schema.Types.ObjectId, required: true },
    entidad_codigo:     { type: String, default: '' },  // código legible de la entidad
    entidad_nombre:     { type: String, default: '' },  // nombre legible de la entidad

    // Tipo y descripción del cambio solicitado
    tipo_cambio:        { type: String, enum: TIPOS_CAMBIO, required: true },
    descripcion:        { type: String, required: true },   // Descripción detallada del cambio
    justificacion:      { type: String, default: '' },      // Por qué se solicita
    valor_anterior:     { type: mongoose.Schema.Types.Mixed, default: null }, // Valor actual
    valor_propuesto:    { type: mongoose.Schema.Types.Mixed, default: null }, // Valor nuevo propuesto
    campo_afectado:     { type: String, default: '' },      // Campo específico (ej: fecha_fin, presupuesto)

    // Flujo de aprobación
    estado:             { type: String, enum: ESTADOS, default: 'Pendiente' },
    solicitado_por:     { type: String, required: true },
    solicitado_email:   { type: String, default: '' },
    revisado_por:       { type: String, default: '' },
    revisado_email:     { type: String, default: '' },
    comentario_revision: { type: String, default: '' },
    fecha_solicitud:    { type: Date, default: Date.now },
    fecha_revision:     { type: Date, default: null },

    // Trazabilidad: periodo al que aplica el cambio (opcional)
    periodo:            { type: String, default: '' },
}, {
    versionKey: false,
    timestamps: true,
});

module.exports = mongoose.model('pdiSolicitudCambio', pdiSolicitudCambioSchema);
module.exports.TIPOS_CAMBIO  = TIPOS_CAMBIO;
module.exports.TIPOS_ENTIDAD = TIPOS_ENTIDAD;
module.exports.ESTADOS       = ESTADOS;
