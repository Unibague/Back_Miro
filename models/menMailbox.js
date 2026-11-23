const mongoose = require('mongoose');

/** Historial de mensajes enviados desde el Buzón del módulo MEN. */
const menMailboxSchema = new mongoose.Schema(
  {
    /** general = recordatorio general; responsables = fechas a cada programa;
     *  administradores = aviso al administrador antes de la fecha de inicio. */
    tipo: { type: String, enum: ['general', 'administradores', 'responsables'], default: 'general' },
    asunto: { type: String, required: true, trim: true },
    cuerpo: { type: String, required: true },
    destinatarios: { type: [String], default: [] },
    /** Administradores del MEN (según su perfil) que recibieron copia. */
    copia: { type: [String], default: [] },
    /** Programas a los que se dirigió (general: todos; responsables: los elegidos). */
    programas: { type: [String], default: [] },
    /** Unidades de la línea que no recibieron el mensaje por no tener correo en el organigrama. */
    sin_correo: { type: [String], default: [] },
    /** Mensajes antiguos enviados en modo prueba (solo llegaron a quien los envió). Ya no se usa al enviar. */
    modo_prueba: { type: Boolean, default: false },
    /** Enviado por la tarea diaria (aviso al administrador o recordatorio del día de inicio). */
    automatico: { type: Boolean, default: false },
    /** Evita repetir un envío automático: evento:proceso:fecha_inicio */
    clave_automatico: { type: String, default: null, index: true },
    enviado_por: { type: String, default: '' },
    estado: { type: String, enum: ['enviado', 'error'], default: 'enviado' },
    error: { type: String, default: null },
  },
  { timestamps: true, versionKey: false }
);

module.exports = mongoose.model('menmailbox', menMailboxSchema);
