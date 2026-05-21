const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Define los tipos de datos permitidos
const allowedDataTypes = [
    "Entero",
    "Decimal",
    "Porcentaje",
    "Texto Corto",
    "Texto Largo",
    "True/False",
    "Fecha",
    "Fecha Inicial / Fecha Final",
    "Link"
];

// Define la función de validación personalizada
function validateDataType(value) {
    return allowedDataTypes.includes(value);
}

// Define el esquema para el campo
const fieldSchema = new Schema({
    name: { 
        type: String,
        required: true
    },
    datatype: { 
        type: String, 
        required: true,
        validate: [validateDataType, "Invalid datatype"] // Usa la función de validación
    },
    required: {
        type: Boolean,
        required: true
    },
    validate_with: {
        type: String,
        required: false
    }, // Referencia a otra colección para validación
    comment: {
        type: String,
        required: false
    }, // Campo para comentarios
    multiple: {
        type: Boolean,
        required: true,
        default: false
    },
    dropdown_options: {
        type: [String],
        required: false,
        default: []
    },
    header_row: {
        type: Number,
        required: false
    },
    column: {
        type: Number,
        required: false
    },
    locked: {
        type: Boolean,
        required: false,
        default: false
    }
}, {
    _id: false,
    versionKey: false
});

const workbookSheetSchema = new Schema({
    name: {
        type: String,
        required: true
    },
    fields: {
        type: [fieldSchema],
        default: []
    },
    preserveOriginalContent: {
        type: Boolean,
        required: false,
        default: false
    },
    rawRows: {
        type: [[Schema.Types.Mixed]],
        required: false,
        default: undefined
    },
    cellNotes: {
        type: [{
            row: Number,
            col: Number,
            note: String
        }],
        required: false,
        default: undefined
    },
    columnWidths: {
        type: [Number],
        required: false,
        default: undefined
    },
    producers: {
        type: [Schema.Types.ObjectId],
        ref: 'dependencies',
        default: []
    },
    shared: {
        type: Boolean,
        default: false
    }
}, {
    _id: false,
    versionKey: false
});

// Define el esquema para la plantilla principal
const templateSchema = new Schema({
    name: { 
        type: String, 
        required: true,
        unique: true  // Asegura que el nombre de la plantilla sea único
    },
    file_name: {
        type: String,
    },
    file_description: { 
        type: String,
    },
    fields: {
        type: [fieldSchema],
        required: true
    }, // Array de campos
    workbook_sheets: {
        type: [workbookSheetSchema],
        default: []
    },
    original_workbook_base64: {
        type: String,
        required: false
    },
    active: {
        type: Boolean,
        default: true,
        required: true
    },
    category: {  
        type: Schema.Types.ObjectId,
        ref: 'categories',
    },
    period: {
        type: Schema.Types.ObjectId,
        ref: 'periods',
        required: false
    },
    created_by: {
        type: {},
        required: true
    },
    dimensions: {
      type: [Schema.Types.ObjectId],
      ref: 'dimensions',
      required: true
    },
    producers: {
      type: [Schema.Types.ObjectId],
      ref: 'dependencies',
      required: true
    }
}, 
{
    versionKey: false,
    timestamps: true
}
); // Nombre de la colección en la base de datos

module.exports = mongoose.model('templates', templateSchema);
