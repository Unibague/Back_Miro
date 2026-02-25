const PublishedTemplate = require('../models/publishedTemplates.js');
const Template = require('../models/templates.js')
const Period = require('../models/periods.js')
const Dimension = require('../models/dimensions.js')
const Dependency = require('../models/dependencies.js')
const User = require('../models/users.js')
const ValidatorModel = require('../models/validators');
const Validator = require('./validators.js');
const Log = require('../models/logs');
const UserService = require('../services/users.js');
const Category = require('../models/categories.js');  
const ExcelJS = require("exceljs");
const auditLogger = require('../services/auditLogger');

const axios = require('axios');

const publTempController = {};

// Mapeo de códigos alfa-2 de países a IDs numéricos
const countryCodeToId = {
  'AD': '20', 'AE': '784', 'AF': '4', 'AG': '28', 'AI': '660', 'AL': '8', 'AM': '51', 'AN': '530',
  'AO': '24', 'AQ': '10', 'AR': '32', 'AS': '16', 'AT': '40', 'AU': '36', 'AW': '533', 'AX': '248',
  'AZ': '31', 'BA': '70', 'BB': '52', 'BD': '50', 'BE': '56', 'BF': '854', 'BG': '100', 'BH': '48',
  'BI': '108', 'BJ': '204', 'BL': '652', 'BM': '60', 'BN': '96', 'BO': '68', 'BR': '76', 'BS': '44',
  'BT': '64', 'BV': '74', 'BW': '72', 'BY': '112', 'BZ': '84', 'CA': '124', 'CC': '166', 'CD': '180',
  'CF': '140', 'CG': '178', 'CH': '756', 'CI': '384', 'CK': '184', 'CL': '152', 'CM': '120', 'CN': '156',
  'CO': '170', 'CR': '188', 'CU': '192', 'CV': '132', 'CW': '531', 'CX': '162', 'CY': '196', 'CZ': '203',
  'DE': '276', 'DJ': '262', 'DK': '208', 'DM': '212', 'DO': '214', 'DZ': '12', 'EC': '218', 'EE': '233',
  'EG': '818', 'EH': '732', 'ER': '232', 'ES': '724', 'ET': '231', 'FI': '246', 'FJ': '242', 'FK': '238',
  'FM': '583', 'FO': '234', 'FR': '250', 'GA': '266', 'GB': '826', 'GD': '308', 'GE': '268', 'GF': '254',
  'GG': '831', 'GH': '288', 'GI': '292', 'GL': '304', 'GM': '270', 'GN': '324', 'GP': '312', 'GQ': '226',
  'GR': '300', 'GS': '239', 'GT': '320', 'GU': '316', 'GW': '624', 'GY': '328', 'HK': '344', 'HM': '334',
  'HN': '340', 'HR': '191', 'HT': '332', 'HU': '348', 'ID': '360', 'IE': '372', 'IL': '376', 'IM': '833',
  'IN': '356', 'IO': '86', 'IQ': '368', 'IR': '364', 'IS': '352', 'IT': '380', 'JE': '832', 'JM': '388',
  'JO': '400', 'JP': '392', 'KE': '404', 'KG': '417', 'KH': '116', 'KI': '296', 'KM': '174', 'KN': '659',
  'KP': '408', 'KR': '410', 'KW': '414', 'KY': '136', 'KZ': '398', 'LA': '418', 'LB': '422', 'LC': '662',
  'LI': '438', 'LK': '144', 'LR': '430', 'LS': '426', 'LT': '440', 'LU': '442', 'LV': '428', 'LY': '434',
  'MA': '504', 'MC': '492', 'MD': '498', 'ME': '499', 'MF': '663', 'MG': '450', 'MH': '584', 'MK': '807',
  'ML': '466', 'MM': '104', 'MN': '496', 'MO': '446', 'MP': '580', 'MQ': '474', 'MR': '478', 'MS': '500',
  'MT': '470', 'MU': '480', 'MV': '462', 'MW': '454', 'MX': '484', 'MY': '458', 'MZ': '508', 'NA': '516',
  'NC': '540', 'NE': '562', 'NF': '574', 'NG': '566', 'NI': '558', 'NL': '528', 'NO': '578', 'NP': '524',
  'NR': '520', 'NU': '570', 'NZ': '554', 'OM': '512', 'PA': '591', 'PE': '604', 'PF': '258', 'PG': '598',
  'PH': '608', 'PK': '586', 'PL': '616', 'PM': '666', 'PN': '612', 'PR': '630', 'PS': '275', 'PT': '620',
  'PW': '585', 'PY': '600', 'QA': '634', 'RE': '638', 'RO': '642', 'RS': '688', 'RU': '643', 'RW': '646',
  'SA': '682', 'SB': '90', 'SC': '690', 'SD': '729', 'SE': '752', 'SG': '702', 'SH': '654', 'SI': '705',
  'SJ': '744', 'SK': '703', 'SL': '694', 'SM': '674', 'SN': '686', 'SO': '706', 'SR': '740', 'SS': '728',
  'ST': '678', 'SV': '222', 'SX': '534', 'SY': '760', 'SZ': '748', 'TC': '796', 'TD': '148', 'TF': '260',
  'TG': '768', 'TH': '764', 'TJ': '762', 'TK': '772', 'TL': '626', 'TM': '795', 'TN': '788', 'TO': '776',
  'TR': '792', 'TT': '780', 'TV': '798', 'TW': '158', 'TZ': '834', 'UA': '804', 'UG': '800', 'UM': '581',
  'US': '840', 'UY': '858', 'UZ': '860', 'VA': '336', 'VC': '670', 'VE': '862', 'VG': '92', 'VI': '850',
  'VN': '704', 'VU': '548', 'WF': '876', 'WS': '882', 'YE': '887', 'YT': '175', 'ZA': '710', 'ZM': '894',
  'ZW': '716', 'NA': '0'
};

// Función para convertir códigos de país a IDs
const convertCountryCodeToId = (value) => {
  if (typeof value === 'string') {
    const upperValue = value.toUpperCase().trim();
    return countryCodeToId[upperValue] || value;
  }
  return value;
};

// Mapeo de IDs a valores descriptivos
const idToDescriptiveValue = {
  // Sexo biológico
  'sexo_biologico': { '1': 'Masculino', '2': 'Femenino' },
  'genero': { '1': 'Masculino', '2': 'Femenino', '3': 'Otro', '4': 'Prefiero no decir' },
  'estado_civil': { '1': 'Soltero', '2': 'Casado', '3': 'Divorciado', '4': 'Viudo', '5': 'Unión libre' },
  'tipo_documento': { '1': 'Cédula de ciudadanía', '2': 'Tarjeta de identidad', '3': 'Cédula de extranjería', '4': 'Pasaporte' },
  'nivel_educativo': { '1': 'Primaria', '2': 'Secundaria', '3': 'Técnico', '4': 'Tecnológico', '5': 'Universitario', '6': 'Especialización', '7': 'Maestría', '8': 'Doctorado' },
  'estrato': { '1': 'Estrato 1', '2': 'Estrato 2', '3': 'Estrato 3', '4': 'Estrato 4', '5': 'Estrato 5', '6': 'Estrato 6' },
  'tipo_vinculacion': { '1': 'Planta', '2': 'Contrato', '3': 'Cátedra', '4': 'Ocasional' },
  'modalidad': { '1': 'Presencial', '2': 'Virtual', '3': 'Mixta' },
  'jornada': { '1': 'Diurna', '2': 'Nocturna', '3': 'Fin de semana' },
  'semestre': { '1': 'I', '2': 'II', '3': 'III', '4': 'IV', '5': 'V', '6': 'VI', '7': 'VII', '8': 'VIII', '9': 'IX', '10': 'X' },
  'si_no': { '1': 'Sí', '2': 'No', '0': 'No', 'true': 'Sí', 'false': 'No' },
  'activo_inactivo': { '1': 'Activo', '2': 'Inactivo', '0': 'Inactivo' },
  'aprobado_reprobado': { '1': 'Aprobado', '2': 'Reprobado', '0': 'Reprobado' },
  // Campos específicos con ID_
  'id_sexo_biologico': { '1': 'Masculino', '2': 'Femenino' },
  'id_estado_civil': { '1': 'Soltero', '2': 'Casado', '3': 'Divorciado', '4': 'Viudo', '5': 'Unión libre' },
  'id_tipo_documento': { '1': 'Cédula de ciudadanía', '2': 'Tarjeta de identidad', '3': 'Cédula de extranjería', '4': 'Pasaporte' },
  'nacional_internacional': { '1': 'Nacional', '2': 'Internacional' },
  'tipo_movilidad': { '1': 'Entrante', '2': 'Saliente' },
  'movilidad_por_convenio': { 'S': 'Sí', 'N': 'No' },
  'id_fuente_nacional_investig': { '1': 'Colciencias', '2': 'Universidad', '3': 'Empresa privada', '4': 'Otro', '20': 'Otra fuente' },
  'id_fuente_internacional': { '1': 'Gobierno extranjero', '2': 'Organización internacional', '3': 'Universidad extranjera', '4': 'Otro', '9': 'Fundación internacional' },
  'estrategia': { '1': 'Opción 1', '2': 'Opción 2', '15': 'Estrategia específica' },
  'enfoques': { '1': 'Enfoque 1', '2': 'Enfoque 2', '4': 'Enfoque interdisciplinario' },
  'impacto': { '1': 'Alto', '2': 'Medio', '3': 'Bajo', '15': 'Impacto significativo' },
  'nacional': { '1': 'Nacional', '2': 'Internacional' },
  'internacional': { '1': 'Nacional', '2': 'Internacional' },
  'promueve': { 'S': 'Sí', 'N': 'No' },
  'desarrolla': { 'S': 'Sí', 'N': 'No' }
};

// Función para convertir IDs a valores descriptivos
const convertIdToDescriptive = async (fieldName, value, templateField = null) => {
  if (!fieldName || !value) return value;
  
  const fieldNameLower = fieldName.toLowerCase();
  const stringValue = String(value).trim();
  

  
  // 1. PRIMERO buscar en mapeos estáticos (más rápido y confiable)
  // Solo convertir si el campo es exactamente uno de los campos conocidos o tiene patrón específico
  for (const [key, mapping] of Object.entries(idToDescriptiveValue)) {
    // Verificar coincidencia exacta o patrones específicos
    const isExactMatch = fieldNameLower === key;
    const isIdPattern = fieldNameLower.startsWith('id_') && fieldNameLower.includes(key.replace('id_', ''));
    const isSpecificPattern = (
      (key === 'modalidad' && fieldNameLower === 'modalidad') ||
      (key === 'tipo_movilidad' && fieldNameLower === 'tipo_movilidad') ||
      (key === 'nacional_internacional' && fieldNameLower === 'nacional_internacional') ||
      (key === 'movilidad_por_convenio' && fieldNameLower === 'movilidad_por_convenio') ||
      (key === 'promueve' && fieldNameLower.startsWith('promueve_')) ||
      (key === 'desarrolla' && fieldNameLower.startsWith('desarrolla_')) ||
      (key === 'impacto' && fieldNameLower.includes('impacto_de_la_movilidad'))
    );
    
    if (isExactMatch || isIdPattern || isSpecificPattern) {
      const result = mapping[stringValue];
      if (result && result !== value) {
        return result;
      }
    }
  }
  
  // 2. Si no encuentra en mapeos estáticos, verificar validador externo
  if (templateField && templateField.validate_with) {
    try {
      const [validatorName, columnName] = templateField.validate_with.split(' - ');
      const validator = await ValidatorModel.findOne({ name: validatorName });
      
      if (validator) {
        const column = validator.columns.find(col => col.name === columnName);
        if (column && column.values) {
          const foundValue = column.values.find(val => 
            String(val.id || val.value || val).trim() === stringValue
          );
          if (foundValue) {
            const result = foundValue.name || foundValue.label || foundValue.text || foundValue;

            return result;
          }
        }
      }
    } catch (error) {
      console.warn('Error al buscar validador:', error.message);
    }
  }
  

  return value;
};

// Función para enriquecer datos de beneficiarios desde API externa
const enrichBeneficiariosData = async (data) => {
  try {
    console.log('🔍 Consultando API de roles para enriquecer datos...');
    
    // Obtener datos de la API externa
    const response = await axios.get(process.env.ROLES_ENDPOINT);
    if (!response.data.success) {
      console.warn('⚠️ API de roles no disponible, continuando sin enriquecimiento');
      return data;
    }

    const rolesData = response.data.roles;
    console.log(`📊 API devolvió ${rolesData.length} registros de roles`);
    
    // Crear mapa de identificación -> datos del usuario
    const userMap = {};
    rolesData.forEach(role => {
      if (!userMap[role.identification]) {
        userMap[role.identification] = {
          user_name: role.user_name,
          email: role.email,
          username: role.username,
          roles: []
        };
      }
      userMap[role.identification].roles.push(role.profile_name);
    });

    console.log(`👥 Procesados ${Object.keys(userMap).length} usuarios únicos`);
    
    // DEBUG: Mostrar algunas cédulas de ejemplo de la API
    const sampleIds = Object.keys(userMap).slice(0, 10);
    console.log('🔍 Ejemplos de cédulas en la API:', sampleIds);

    // DEBUG: Mostrar estructura de la primera fila para debugging
    if (data.length > 0) {
      console.log('🔍 DEBUG - Campos disponibles en la primera fila:');
      console.log('Campos:', Object.keys(data[0]));
      console.log('Primera fila completa:', data[0]);
    }

    // Enriquecer cada fila de datos
    const enrichedData = data.map((row, index) => {
      // Buscar identificación en diferentes posibles nombres de campo
      const possibleIdFields = [
        'NUM_DOCUMENTO', 'IDENTIFICACION', 'CEDULA', 'ID', 'NUMERO_IDENTIFICACION', 'DOCUMENTO',
        'num_documento', 'identificacion', 'cedula', 'id', 'numero_identificacion', 'documento',
        'Num_Documento', 'Identificacion', 'Cedula', 'Id', 'Numero_Identificacion', 'Documento'
      ];
      
      let identification = null;
      let fieldUsed = null;
      
      // Buscar en todos los posibles campos
      for (const field of possibleIdFields) {
        if (row[field] && row[field] !== '') {
          identification = String(row[field]).trim();
          fieldUsed = field;
          break;
        }
      }
      
      // Si no encuentra en campos específicos, buscar en cualquier campo que contenga números
      if (!identification) {
        for (const [key, value] of Object.entries(row)) {
          if (value && typeof value === 'string' && /^\d{6,12}$/.test(value.trim())) {
            identification = value.trim();
            fieldUsed = key;
            break;
          }
        }
      }
      
      if (index < 5) { // Solo mostrar debug para las primeras 5 filas
        console.log(`🔍 Fila ${index + 1}: Campo usado: ${fieldUsed}, Cédula: ${identification}`);
      }
      
      if (identification && userMap[identification]) {
        const userData = userMap[identification];
        if (index < 5) {
          console.log(`✅ Enriqueciendo datos para cédula: ${identification}`);
        }
        
        return {
          ...row,
          ROLES_DISPONIBLES: userData.roles.join(', ')
        };
      } else {
        if (index < 5) {
          console.log(`❌ No se encontraron datos para cédula: ${identification}`);
        }
        return {
          ...row,
          ROLES_DISPONIBLES: 'Externo' // Valor por defecto si no se encuentra
        };
      }
    });

    console.log(`🎉 Enriquecimiento completado para ${enrichedData.length} filas`);
    return enrichedData;
    
  } catch (error) {
    console.error('❌ Error enriqueciendo datos de beneficiarios:', error.message);
    return data; // Devolver datos originales si hay erro
  }
};

// Función para normalizar nombres de campos para Excel
const normalizeFieldName = (fieldName) => {
  return fieldName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_') // Reemplazar caracteres especiales con guión bajo
    .replace(/_+/g, '_') // Reemplazar múltiples guiones bajos con uno solo
    .replace(/^_|_$/g, ''); // Eliminar guiones bajos al inicio y final
};

// Función para convertir hipervínculos de Excel a texto
const convertHyperlinkToText = (value) => {
  let result;
  
  // Manejar valores null, undefined o proxy revocados
  if (value === null || value === undefined) {
    return '';
  }
  
  // Detectar proxy revocado
  try {
    if (typeof value === 'object' && value.toString() === '[object Object]') {
      // Intentar acceder a una propiedad para detectar proxy revocado
      Object.keys(value);
    }
  } catch (e) {
    console.log('   ⚠️ Detected revoked proxy, returning empty string');
    return '';
  }
  
  if (value && typeof value === 'object') {
    // Si es un array, manejar arrays anidados
    if (Array.isArray(value)) {
      // Si es un array anidado como [['15']], aplanar
      const flattened = value.flat(Infinity);
      result = flattened.length > 0 ? String(flattened[0]) : '';
    }
    // Si es un hipervínculo de Excel
    else if (value.hyperlink || value.text) {
      result = value.text || value.hyperlink || String(value);
    }
    // Si es un objeto MongoDB
    else if ('$numberInt' in value || '$numberDouble' in value) {
      result = value.$numberInt || value.$numberDouble;
    }
    // Si tiene propiedades como richText, formula, etc. (objetos de Excel)
    else if (value.richText) {
      result = value.richText.map(rt => rt.text || '').join('');
    }
    else if (value.formula) {
      result = value.result || value.formula;
    }
    else if (value.result !== undefined) {
      result = value.result;
    }
    // Si es un objeto con valor directo
    else if (value.value !== undefined) {
      result = value.value;
    }
    else {
      // Intentar extraer cualquier propiedad que parezca texto
      const possibleTextProps = ['text', 'value', 'result', 'displayText', 'content'];
      for (const prop of possibleTextProps) {
        if (value[prop] !== undefined) {
          result = value[prop];
          break;
        }
      }
      // Si es otro tipo de objeto, convertir a string
      if (result === undefined) {
        result = String(value);
      }
    }
  } else {
    result = value ?? '';
  }
  
  // Limpiar saltos de línea y caracteres especiales que rompen Excel
  if (typeof result === 'string') {
    // Eliminar comillas que rodean todo el contenido
    result = result.replace(/^"(.*)"$/g, '$1');
    
    // Reemplazar múltiples saltos de línea con punto y coma para separar URLs/valores
    result = result.replace(/[\r\n]+/g, '; ')
                   .replace(/[\t]/g, ' ')
                   .replace(/""/g, '"') // Desescapar comillas dobles
                   .replace(/;\s*;/g, ';') // Eliminar punto y coma duplicados
                   .replace(/^;\s*|\s*;$/g, '') // Eliminar punto y coma al inicio/final
                   .replace(/\s+/g, ' ') // Reemplazar múltiples espacios con uno solo
                   .trim();
  }
  
  return result;
};

datetime_now = () => {
  const now = new Date();

  const offset = -5; // GMT-5
  return new Date(now.getTime() + offset * 60 * 60 * 1000);
}

publTempController.publishTemplate = async (req, res) => {
  const template_id = req.body.template_id
  const email = req.body.user_email

  try {
    const template = await Template.findById(template_id)
    if (!template) {
      return res.status(404).json({ status: 'Template not found' })
    }

    const user = await UserService.findUserByEmailAndRole(email, 'Administrador');

    // Ensure user has all required fields
    const userForPublish = {
      ...user.toObject(),
      position: user.position || 'Administrador',
      identification: user.identification || 0
    };

    const category = template.category;  
    const sequence = template.sequence;  

    const newPublTemp = new PublishedTemplate({
      name: req.body.name || template.name,
      published_by: userForPublish,
      template: template,
      period: req.body.period_id,
      deadline: req.body.deadline,
      published_date: datetime_now(),
      category: category,  
      sequence: sequence   
    })

    await newPublTemp.save()

    // Audit log
    await auditLogger.logCreate(req, user, 'publishedTemplate', {
      publishedTemplateId: newPublTemp._id,
      templateName: newPublTemp.name,
      templateId: template_id,
      periodId: req.body.period_id
    });

    return res.status(201).json({ status: 'Template published successfully' })
  } catch (error) {
    console.error('Error in publishTemplate:', error);
    return res.status(500).json({ status: error.message })
  }
}


publTempController.getPublishedTemplatesDimension = async (req, res) => {
  const email = req.query.email;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || '';
  const periodId = req.query.periodId || null;
  const filterByUserScope = req.query.filterByUserScope;
  const userRole = req.query.userRole;
  const skip = (page - 1) * limit;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ status: 'User not found' });
    }

    const activeRole = user.activeRole;

    let query = {
      name: { $regex: search, $options: 'i' },
      ...(periodId && { period: periodId }),
    };
    
    // Filtrado específico cuando filterByUserScope=true
    if (filterByUserScope === 'true') {
      if (userRole === 'Productor') {
        const userDependency = await Dependency.findOne({
          members: { $elemMatch: { email: email } }
        });
        
        const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
        const dependenciesByCode = await Dependency.find({ dep_code: { $in: allUserDependencies } });
        
        if (userDependency) {
          query['template.producers'] = userDependency._id;
        } else if (dependenciesByCode.length > 0) {
          const dependencyIds = dependenciesByCode.map(dep => dep._id);
          query['template.producers'] = { $in: dependencyIds };
        } else {
          return res.status(200).json({ templates: [], total: 0, page, pages: 0 });
        }
      } else if (userRole === 'Responsable') {
        const orConditions = [];
        
        const userDependencies = await Dependency.find({ responsible: email });
        const userDependencyIds = userDependencies.map(dep => dep._id);
        const dimensions = await Dimension.find({ responsible: { $in: userDependencyIds } });
        
        if (dimensions.length > 0) {
          const dimensionIds = dimensions.map(dim => dim._id);
          orConditions.push({ 'template.dimensions': { $in: dimensionIds } });
        }
        
        const allUserDependencies = await Dependency.find({
          $or: [{ responsible: email }, { visualizers: email }]
        });
        
        if (allUserDependencies.length > 0) {
          const dependencyIds = allUserDependencies.map(dep => dep._id);
          orConditions.push({ 'template.producers': { $in: dependencyIds } });
        }
        
        if (orConditions.length > 0) {
          query.$or = orConditions;
        } else {
          return res.status(200).json({ templates: [], total: 0, page, pages: 0 });
        }
      }
    }
    else if (activeRole !== 'Administrador') {
      const orConditions = [];
      
      const userDependencies = await Dependency.find({ responsible: email });
      const userDependencyIds = userDependencies.map(dep => dep._id);
      
      const dimensions = await Dimension.find({ responsible: { $in: userDependencyIds } });
      if (dimensions.length > 0) {
        const dimensionIds = dimensions.map(dim => dim._id);
        orConditions.push({ 'template.dimensions': { $in: dimensionIds } });
      }
      
      const allUserDependencies = await Dependency.find({
        $or: [{ responsible: email }, { visualizers: email }]
      });
      
      if (allUserDependencies.length > 0) {
        const dependencyIds = allUserDependencies.map(dep => dep._id);
        orConditions.push({ 'template.producers': { $in: dependencyIds } });
      }
      
      if (orConditions.length > 0) {
        query.$or = orConditions;
      }
    }

    const published_templates = await PublishedTemplate.find(query)
      .skip(skip)
      .limit(limit)
      .populate('period')
      .populate({
        path: 'template',
        populate: 
        [
          { path: 'dimensions', model: 'dimensions' },
        ]
      });


    const total = await PublishedTemplate.countDocuments(query);
    
    const updated_templates = await Promise.all(published_templates.map(async template => {
      const validators = await Promise.all(
        template.template.fields.map(async (field) => {
          return Validator.giveValidatorToExcel(field.validate_with);
        })
      );

      template = template.toObject();
      validatorsFiltered = validators.filter(v => v !== undefined)
      template.validators = validatorsFiltered // Añadir validators al objeto

      const dependencies = await Dependency.find(
        { dep_code: { $in: template.producers_dep_code } },
        'name -_id'
      );
      template.producers_dep_code = dependencies.map(dep => dep.name);
      
      template.loaded_data = await Promise.all(template.loaded_data.map(async data => {
        const loadedDependency = await Dependency.findOne(
          { dep_code: data.dependency },
          'name -_id'
        );
        data.dependency = loadedDependency ? loadedDependency.name : data.dependency;
        
        // Aplicar conversión de hipervínculos y códigos de país a los datos cargados
        if (data.filled_data) {
          data.filled_data = await Promise.all(data.filled_data.map(async fieldData => {
            // Verificar si el campo es de país
            const isCountryField = fieldData.field_name && 
              (fieldData.field_name.toLowerCase().includes('pais') || 
               fieldData.field_name.toLowerCase().includes('país') ||
               fieldData.field_name.toLowerCase().includes('country'));
            
            const processedValues = await Promise.all(fieldData.values.map(async value => {
              let processedValue = convertHyperlinkToText(value);
              if (isCountryField) {
                processedValue = convertCountryCodeToId(processedValue);
              }
              // Convertir IDs a valores descriptivos
              processedValue = await convertIdToDescriptive(fieldData.field_name, processedValue);
              return processedValue;
            }));
            
            return {
              ...fieldData,
              values: processedValues
            };
          }));
        }
        
        return data;
      }));
      
      return template;
    }));
    
    res.status(200).json({
      templates: updated_templates,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};


publTempController.getAssignedTemplatesToProductor = async (req, res) => {
  const email = req.query.email;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || '';
  const skip = (page - 1) * limit;

  try {
    const user = await User.findOne({ email });
    if (!user || !user.activeRole === 'Productor') {
      return res.status(404).json({ status: 'User not found' });
    }

    const query = {
      name: { $regex: search, $options: 'i' }
    };

    let templates = await PublishedTemplate.find(query)
      .skip(skip)
      .limit(limit)
      .populate('period')
      .populate({
        path: 'template',
        populate: {
          path: 'dimension',
          model: 'dimensions'
        }
      })
      .populate({
        path: 'template.producers',
        model: 'dependencies',
        match: { members: user.email } 
      })
      

    console.log(templates)

    templates = templates.filter(t => t.template.producers.length > 0);

    const total = await PublishedTemplate.countDocuments(query);

    const updatedTemplatesPromises = templates.map(async t => {
      
      const validators = await Promise.all(
        t.template.fields.map(async (field) => {
          return Validator.giveValidatorToExcel(field.validate_with);
        })
      );

      t = t.toObject();
      validatorsFiltered = validators.filter(v => v !== undefined)
      t.validators = validatorsFiltered // Añadir validators al objeto
  
      let uploaded = false;
    
      // Filtrar loaded_data según dep_code
      const filteredLoadedData = t.loaded_data.filter(ld => {
        if (ld.send_by.dep_code === user.dep_code) {
          uploaded = true;
        }
        return ld.dependency === user.dep_code;
      });

      // Transformar filteredLoadedData en un formato similar al método getFilledDataMergedForResponsible
      const transformedLoadedData = filteredLoadedData.map(ld => {
        const filledData = ld.filled_data.reduce((acc, item) => {
          item.values.forEach((value, index) => {
            if (!acc[index]) {
              acc[index] = { Dependencia: ld.dependency };
            }
            // Fix para datos existentes con '[object Object]'
            if (typeof value === 'string' && value === '[object Object]') {
              acc[index][item.field_name] = '';
            } else {
              let processedValue = convertHyperlinkToText(value);
              
              // Verificar si el campo es de país y convertir código a ID
              const isCountryField = item.field_name && 
                (item.field_name.toLowerCase().includes('pais') || 
                 item.field_name.toLowerCase().includes('país') ||
                 item.field_name.toLowerCase().includes('country'));
              
              if (isCountryField) {
                processedValue = convertCountryCodeToId(processedValue);
              }
              
              // Convertir IDs a valores descriptivos (sin await aquí para mantener compatibilidad)
              // processedValue = await convertIdToDescriptive(item.field_name, processedValue);
              
              acc[index][item.field_name] = processedValue;
            }
          });
          return acc;
        }, []);
    
        return filledData;
      }).flat();



      return {
        ...t,
        loaded_data: transformedLoadedData,
        uploaded
      };
    });

    const updatedTemplates = await Promise.all(updatedTemplatesPromises);

    res.status(200).json({
      templates: updatedTemplates,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

publTempController.feedOptionsToPublishTemplate = async (req, res) => {
  const email = req.query.email;

  try {
      await UserService.findUserByEmailAndRole(email, 'Administrador');

      // Get active periods
      const periods = await Period.find({
        is_active: true,
        producer_end_date: { $gte: datetime_now() }
      })
      .sort({ updatedAt: -1 })

      // Get dependencie producers
      const producers = await Dependency.find();

      res.status(200).json({ periods, producers });

  } catch (error) {
      console.log(error.message);
      res.status(500).json({ status: 'Internal server error', details: error.message });
  }
}


publTempController.exportPendingTemplates = async (req, res) => {
  const {periodId} = req.params

  try{

    const templates = await PublishedTemplate.find({period: periodId})

    const allPending = [];

    for (const template of templates){
      const producers = template.template?.producers || []

      const loadedDependencyCode = (template.loaded_data || []).
      filter(d => d?.dependency).map(d => d.dependency) 

      // Buscar nombres de dependencias
      const dependencies = await Dependency.find({ _id: { $in: producers } });

      dependencies.forEach ( dep => {
        const depCode = dep.dep_code;
        const hasLoaded = loadedDependencyCode.includes(depCode)
        if (!hasLoaded){
          allPending.push({
            template: template.name,
            dependency: dep.name
          })
        }
      })

    }

 // Generar Excel con ExcelJS
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Pendientes');

    worksheet.columns = [
      { header: 'Dependencia', key: 'dependency', width: 40 },
      { header: 'Nombre de la Plantilla', key: 'template', width: 40 },
    ];

    worksheet.addRows(
  allPending.sort((a, b) => a.dependency.localeCompare(b.dependency))
);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=pendientes_templates.xlsx");

    // Audit log para exportación de pendientes
    const user = await User.findOne({ email: req.query.email || 'system' });
    if (user) {
      await auditLogger.logRead(req, user, 'exportPendingTemplates', {
        periodId: periodId,
        totalPending: allPending.length
      });
    }

    await workbook.xlsx.write(res);
    

  } catch (error) {
    console.error("Error al exportar pendientes:", error);
    res.status(500).json({ message: error.message || "Error interno al exportar pendientes." });
  }

}

publTempController.loadProducerData = async (req, res) => {
  const { email, pubTem_id, data, edit } = req.body;



  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ status: 'User not found' });
    }

    const pubTem = await PublishedTemplate.findById(pubTem_id)
      .populate('period')
      .populate({
        path: 'template',
        populate: { path: 'producers', model: 'dependencies' }
      });

    if (!pubTem) {
      return res.status(404).json({ status: 'Published template not found' });
    }

    const now = new Date(datetime_now().toDateString());
    const endDate = new Date(pubTem.deadline).toDateString();
    if (endDate < now) {
      return res.status(403).json({ status: 'The period is closed' });
    }

    // Verificar si el usuario puede enviar datos desde alguna de sus dependencias
    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
    const userDependencies = await Dependency.find({ dep_code: { $in: allUserDependencies } });
    const userDependencyIds = userDependencies.map(dep => dep._id.toString());
    
    const canSubmit = pubTem.template?.producers.some(p => userDependencyIds.includes(p._id.toString()));
    if (!canSubmit) {
      return res.status(403).json({ status: 'User is not assigned to this published template' });
    }

    if (!pubTem.published_date) {
      pubTem.published_date = datetime_now();
    }

    // VALIDACIÓN PREVIA: Verificar que las columnas del Excel coincidan
    if (data && data.length > 0) {
      const excelColumns = Object.keys(data[0]);
      const templateColumns = pubTem.template.fields.map(f => f.name);
      
      // Solo considerar como faltantes las columnas que son obligatorias (required = true)
      const missingColumns = pubTem.template.fields
        .filter(field => field.required && !excelColumns.includes(field.name))
        .map(field => field.name);
      const extraColumns = excelColumns.filter(col => !templateColumns.includes(col));
      
      if (missingColumns.length > 0 || extraColumns.length > 0) {
        const errorDetails = [];
        
        if (missingColumns.length > 0) {
          errorDetails.push({
            column: "Columnas faltantes",
            errors: missingColumns.map(col => ({
              register: 1,
              value: "No encontrada",
              message: `La columna '${col}' no se encontró en el archivo Excel. Sus columnas actuales: [${excelColumns.join(', ')}]. Debe ser exactamente: '${col}'`
            }))
          });
        }
        
        if (extraColumns.length > 0) {
          extraColumns.forEach(col => {
            errorDetails.push({
              column: `Columna desconocida (${col})`,
              errors: [{
                register: 1,
                value: col,
                message: `La columna '${col}' no pertenece a esta plantilla. Elimine esta columna. Columnas válidas: [${templateColumns.join(', ')}]`
              }]
            });
          });
        }
        
        return res.status(400).json({ 
          status: 'Column mismatch error', 
          details: errorDetails,
          message: 'Las columnas del archivo Excel no coinciden con la plantilla esperada'
        });
      }
    }

// Construcción robusta de `result` considerando `multiple
const result = pubTem.template.fields.map((field) => {
  const values = data.map(row => {
    let val = row[field.name];
    
    // FIX: Manejar objetos de Excel (hipervínculos, etc.)
    if (typeof val === 'object' && val !== null) {
      val = convertHyperlinkToText(val);
    }
    
    // FIX TEMPORAL: Detectar [object Object] strings del frontend
    if (typeof val === 'string' && val === '[object Object]') {
      console.warn(`⚠️  Campo ${field.name} contiene '[object Object]' - problema en el frontend`);
      val = null; // Convertir a null para que se maneje como valor vacío
    }
    
    // FIX: Manejar arrays que vienen del frontend (incluyendo arrays anidados)
    if (Array.isArray(val)) {
      console.log(`DEBUG - Campo ${field.name}: Array detectado:`, val);
      
      // Normalizar arrays anidados
      let normalizedVal = val;
      while (Array.isArray(normalizedVal) && normalizedVal.length === 1) {
        normalizedVal = normalizedVal[0];
      }
      
      // Si después de normalizar es un string JSON, parsearlo
      if (typeof normalizedVal === 'string' && normalizedVal.startsWith('[') && normalizedVal.endsWith(']')) {
        try {
          const parsed = JSON.parse(normalizedVal);
          if (Array.isArray(parsed) && parsed.length === 1) {
            normalizedVal = parsed[0];
          }
        } catch (e) {
          // Si no se puede parsear, mantener el valor
        }
      }
      
      val = normalizedVal;
      console.log(`DEBUG - Campo ${field.name}: Valor final normalizado:`, val);
    }
    
    // Limpiar valores: convertir string "null" a null real
    if (typeof val === 'string' && val.trim() === 'null') {
      val = null;
    }
    
    // Limpiar valores vacíos para campos no obligatorios
    if (!field.required && (val === null || val === undefined || (typeof val === 'string' && val.trim() === ''))) {
      val = null;
    }

if (field.multiple) {
  if (val === null || val === undefined) return [];

  // Forzamos a string y separamos por coma
  const rawString = val.toString();

  // Si no hay coma, igual devolvemos el valor como único
  if (!rawString.includes(',')) {
    return [rawString.trim()];
  }

  return rawString.split(',').map(v => v.trim());
}

    return val;
  });

  return {
    field_name: field.name,
    values
  };
});




    // Validación con valores externos si hay validate_with
    const validations = result.map(async field => {
      const templateField = pubTem.template.fields.find(f => f.name === field.field_name);
      if (!templateField) {
        throw new Error(`Field ${field.field_name} not found in template`);
      }

      // 🚀 NUEVO: si tiene validate_with, traer valores válidos
      if (templateField.validate_with) {
        const [validatorName, columnName] = templateField.validate_with.split(" - ");
        const validator = await ValidatorModel.findOne({ name: validatorName });

        if (validator) {
          const validatorColumn = validator.columns.find(c => c.name === columnName);
          if (validatorColumn) {
            templateField.validator_values = validatorColumn.values;
            templateField.validator_type = validatorColumn.type;
          }
        }
      }

      templateField.values = field.values;

      const validationResult = await Validator.validateColumn(templateField);
      return validationResult;
    });

    const validationResults = await Promise.all(validations);
    const validationErrors = validationResults.filter(v => v.status === false);



    if (validationErrors.length > 0) {
      const sanitizedErrors = validationErrors.map(err => ({
        column: err.column ?? "Campo desconocido",
        errors: (err.errors ?? []).map(e => ({
          register: e.register ?? 1,
          value: e.value ?? "Sin valor",
          message: e.message ?? "Error desconocido"
        }))
      }));

      // Guardar el log
      await Log.create({
        user: user,
        published_template: pubTem._id,
        date: datetime_now(),
        errors: sanitizedErrors
      });

      // Enviar al frontend
      return res.status(400).json({ status: 'Validation error', details: sanitizedErrors });
    }

    const producersData = {
      dependency: user.dep_code,
      send_by: user,
      filled_data: result,
      loaded_date: datetime_now()
    };

    // Verificar si ya existe data para esta dependencia
    const existingDataIndex = pubTem.loaded_data.findIndex(d => d.dependency === user.dep_code);
    
    if (existingDataIndex > -1) {
      // Si ya existe, actualizar los datos existentes
      pubTem.loaded_data[existingDataIndex] = producersData;
    } else {
      // Si no existe, agregar nuevos datos
      pubTem.loaded_data.push(producersData);
    }

    await pubTem.save();

    // Audit log
    await auditLogger.logCreate(req, user, 'publishedTemplateData', {
      publishedTemplateId: pubTem_id,
      templateName: pubTem.name,
      dependency: user.dep_code,
      recordsLoaded: data.length
    });

    return res.status(200).json({ 
      status: 'Data loaded successfully', 
      recordsLoaded: data.length
    });

  } catch (error) {
    console.log(error.message);
    return res.status(500).json({ status: 'Internal server error', details: error.message });
  }
};


publTempController.submitEmptyData = async (req, res) => {
  const { pubTemId, email } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      throw new Error('User not found');
    }
    const pubTem = await PublishedTemplate
      .findById(pubTemId)
      .populate('period')
      .populate({
        path: 'template',
        populate: {
          path: 'producers',
          model: 'dependencies'
        }
      })

    if (!pubTem) {
      throw new Error('Published template not found');
    }
        
    const producersData = {
      dependency: user.dep_code,
      send_by: user,
      loaded_date: datetime_now(),  // Agregar la fecha de carga
      filled_data: []
    };

    const existingDataIndex = pubTem.loaded_data.findIndex(
      data => data.dependency === user.dep_code
    );

    if (existingDataIndex > -1) {
      throw new Error('Data already exists');
    } else {
      pubTem.loaded_data.push(producersData);
    }

    await pubTem.save();
    
    // Audit log
    await auditLogger.logCreate(req, user, 'publishedTemplateEmptyData', {
      publishedTemplateId: pubTemId,
      templateName: pubTem.name,
      dependency: user.dep_code
    });
    
    return res.status(200).json({ status: 'Data loaded successfully' });
  } catch (error) {
    console.log(error.message);
    return res.status(500).json({ status: 'Internal server error', details: error.message });
  }
}

publTempController.deleteLoadedDataDependency = async (req, res) => {
  const { pubTem_id, email } = req.query

  try {
    const user = await User.findOne({ email })
    if (!user) { return res.status(404).json({ status: 'User not found' }) }

    const pubTem = await PublishedTemplate.findById(pubTem_id)
      .populate({
        path: 'template',
        populate: { path: 'producers', model: 'dependencies' }
      })

    if (!pubTem) { return res.status(404).json({ status: 'Published template not found' }) }

    // Verificar si el usuario puede eliminar datos desde alguna de sus dependencias
    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
    const userDependencies = await Dependency.find({ dep_code: { $in: allUserDependencies } });
    const userDependencyIds = userDependencies.map(dep => dep._id.toString());
    
    const canDelete = pubTem.template?.producers.some(p => userDependencyIds.includes(p._id.toString()));
    if (!canDelete) {
      return res.status(403).json({ status: 'User is not assigned to this published template' })
    }

    // Buscar datos de cualquiera de las dependencias del usuario
    const index = pubTem.loaded_data.findIndex(data => allUserDependencies.includes(data.dependency))
    if (index === -1) { return res.status(404).json({ status: 'Data not found' }) }
  
    const deletedData = pubTem.loaded_data[index];
    pubTem.loaded_data.splice(index, 1);
    await pubTem.save();
    
    // Audit log
    console.log('🔍 Executing audit log for publishedTemplateData deletion');
    await auditLogger.logDelete(req, user, 'publishedTemplateData', {
      publishedTemplateId: pubTem_id,
      templateName: pubTem.name,
      dependency: deletedData.dependency
    });
    console.log('✅ Audit log completed for publishedTemplateData deletion');
    
    return res.status(200).json({ status: 'Data deleted successfully' })
  } catch (error) {
    console.log(error.message)
    return res.status(500).json({ status: 'Internal server error', details: error.message })
  }
};


publTempController.getFilledDataMergedForDimension = async (req, res) => {
  const { pubTem_id, email, filterByUserDependency, userRole } = req.query;

  const user = await User.findOne({ email });

  if(!user) {
    return res.status(404).json({status: 'User not available'});
  }
  
  if (!pubTem_id) {
    return res.status(400).json({ status: 'Missing pubTem_id' });
  }

  try {
    const template = await PublishedTemplate.findById(pubTem_id).populate('template');

    if (!template) {
      return res.status(404).json({ status: 'Published template not found' });
    }
    
    // Audit log para descarga de datos combinados
    await auditLogger.logRead(req, user, 'publishedTemplateMergedData', {
      publishedTemplateId: pubTem_id,
      templateName: template.name
    });

    // Filtrar datos por dependencia del usuario si se solicita
    let filteredLoadedData = template.loaded_data;
    
    if (filterByUserDependency === 'true' && (userRole === 'Productor' || userRole === 'Responsable')) {
      // Obtener todas las dependencias del usuario
      const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
      
      // Filtrar solo los datos de las dependencias del usuario
      filteredLoadedData = template.loaded_data.filter(data => 
        allUserDependencies.includes(data.dependency)
      );
    }

    const dependencies = await Dependency.find({ dep_code: { $in: filteredLoadedData.map(data => data.dependency) } });

    const depCodeToNameMap = dependencies.reduce((acc, dep) => {
      acc[dep.dep_code] = dep.name;
      return acc;
    }, {});

    let data = await Promise.all(filteredLoadedData.map(async data => {

      // Detectar si no hay datos cargados
      if (!Array.isArray(data.filled_data) || data.filled_data.length === 0) {
  const emptyRow = {
    Dependencia: depCodeToNameMap[data.dependency] || data.dependency,
  };

  // Añadir todas las columnas vacías según template.fields
  template.template.fields.forEach(field => {
    const cleanFieldName = normalizeFieldName(field.name);
    emptyRow[cleanFieldName] = "";
  });

  return [emptyRow];
      }

      const filledData = await Promise.all(
        data.filled_data.map(async (item) => {
          const processedValues = await Promise.all(
            item.values.map(async (value, index) => {
              // Aplicar conversión de hipervínculos
              let cleanValue = convertHyperlinkToText(value);
              
              // Verificar si el campo es de país y convertir código a ID
              const isCountryField = item.field_name && 
                (item.field_name.toLowerCase().includes('pais') || 
                 item.field_name.toLowerCase().includes('país') ||
                 item.field_name.toLowerCase().includes('country'));
              
              if (isCountryField) {
                cleanValue = convertCountryCodeToId(cleanValue);
              }
              
              // Convertir IDs a valores descriptivos (buscar campo en template para validadores)
              const templateField = template.template.fields ? 
                template.template.fields.find(f => f.name === item.field_name) : null;
              cleanValue = await convertIdToDescriptive(item.field_name, cleanValue, templateField);
              
              return { value: cleanValue, index };
            })
          );
          
          return { item, processedValues };
        })
      );
      
      // Reconstruir el formato original
      const finalData = [];
      filledData.forEach(({ item, processedValues }) => {
        processedValues.forEach(({ value, index }) => {
          if (!finalData[index]) {
            finalData[index] = { Dependencia: depCodeToNameMap[data.dependency] || data.dependency };
          }
          const fieldName = normalizeFieldName(item.field_name);
          finalData[index][fieldName] = value || "";
        });
      });


       console.log('INFO CARGADA', finalData);
    
      return finalData;
    }));
    
    data = data.flat();

    // Detectar si es plantilla de beneficiarios y enriquecer datos
    const templateName = template.name ? template.name.toUpperCase().replace(/\s+/g, '_') : '';
    const isBeneficiariosTemplate = templateName.includes('BENEFICIARIO_BIENESTAR_CULTURAL');
    
    if (isBeneficiariosTemplate) {
      console.log(`🎆 Detectada plantilla de beneficiarios: "${template.name}"`);
      console.log('🔄 Iniciando enriquecimiento de datos con API externa...');
      data = await enrichBeneficiariosData(data);
      console.log('✅ Datos de beneficiarios enriquecidos exitosamente');
    } else {
      console.log(`📄 Plantilla regular: "${template.name}" - sin enriquecimiento`);
    }

    res.status(200).json({ data });
  } catch (error) {
     console.log('LA PLANTILLA', error);
    res.status(500).json({ error: 'Error al obtener los datos de la plantilla' });
  }
}


publTempController.getUploadedTemplatesByProducer = async (req, res) => {
  const email = req.query.email;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || '';
  const periodId = req.query.periodId;
  const filterByDependency = req.query.filterByDependency;
  const skip = (page - 1) * limit;

  try {
    console.log('== DEBUG getUploadedTemplatesByProducer ===');
    console.log('Email:', email);
    console.log('FilterByDependency:', filterByDependency);
    console.log('All query params:', req.query);
    
    const user = await User.findOne({ email });
    console.log('User found:', user ? 'YES' : 'NO');
    
    if (!user) {
      console.log('ERROR: User not found');
      return res.status(404).json({ status: 'User not found' });
    }

    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
    console.log('All user dependencies:', allUserDependencies);
    
    // Si hay filtro por dependencia, convertir nombre a dep_code si es necesario
    let dependenciesToQuery = allUserDependencies;
    if (filterByDependency) {
      console.log('FilterByDependency received:', filterByDependency);
      
      const dependencyByCode = await Dependency.findOne({ dep_code: filterByDependency });
      const dependencyByName = await Dependency.findOne({ name: { $regex: new RegExp(`^${filterByDependency}$`, 'i') } });
      
      if (dependencyByCode) {
        dependenciesToQuery = [filterByDependency];
        console.log('Filtering by dep_code:', filterByDependency);
      } else if (dependencyByName) {
        dependenciesToQuery = [dependencyByName.dep_code];
        console.log('Filtering by name, converted to dep_code:', dependencyByName.dep_code);
      } else {
        console.log('Dependency not found, using all user dependencies');
      }
    }
    console.log('Dependencies to query:', dependenciesToQuery);
    console.log('🔍 CRITICAL: Is filterByDependency being processed?', !!filterByDependency);
    
    // Obtener IDs de las dependencias para filtrar por template.producers
    const dependencies = await Dependency.find({ dep_code: { $in: dependenciesToQuery } });
    const dependencyIds = dependencies.map(dep => dep._id);
    console.log('Dependency IDs for producers filter:', dependencyIds);
    
    const query = {
      'template.producers': { $in: dependencyIds },
      name: { $regex: search, $options: 'i' }
    };
    
    if (periodId) {
      query.period = periodId;
    }

    const templates = await PublishedTemplate.find(query)
      .skip(skip)
      .limit(limit)
      .populate('period')
      .populate({
        path: 'template',
        populate: [
          { path: 'dimensions', model: 'dimensions' },
          { path: 'producers', model: 'dependencies' }
        ]
      });

    // Filtrar solo plantillas asignadas que tienen información cargada
    const templatesWithData = templates.filter(template => {
      const hasDataForDependencies = template.loaded_data.some(data => 
        dependenciesToQuery.includes(data.dependency) && 
        data.filled_data !== undefined
      );
      console.log(`\n🔍 Template '${template.name}':`);
      console.log('  - loaded_data dependencies:', template.loaded_data.map(ld => ld.dependency));
      console.log('  - dependenciesToQuery:', dependenciesToQuery);
      console.log('  - hasDataForDependencies:', hasDataForDependencies);
      return hasDataForDependencies;
    });

    const templatesWithValidators = await Promise.all(
      templatesWithData.map(async (template) => {
        const validators = await Promise.all(
          template.template.fields.map(async (field) => {
            return Validator.giveValidatorToExcel(field.validate_with);
          })
        );

        template = template.toObject();
        template.validators = validators.filter(v => v !== undefined);
        return template;
      })
    );

    // Contar total real después del filtrado
    const allTemplatesForCount = await PublishedTemplate.find(query);
    const totalWithData = allTemplatesForCount.filter(template => {
      return template.loaded_data.some(data => 
        dependenciesToQuery.includes(data.dependency) && 
        data.filled_data !== undefined
      );
    }).length;

    res.status(200).json({
      templates: templatesWithValidators,
      total: totalWithData,
      page,
      pages: Math.ceil(totalWithData / limit),
    });
  } catch (error) {
    console.error('=== ERROR in getUploadedTemplatesByProducer ===');
    console.error('Error message:', error.message);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};

publTempController.getAvailableTemplatesToProductor = async (req, res) => {
  const { email, periodId, page = 1, limit = 10, search = '', filterByDependency = '' } = req.query;
  const skip = (page - 1) * limit;

  try {
    console.log('=== DEBUG getAvailableTemplatesToProductor ===');
    console.log('Email:', email);
    
    // Find user productor
    const user = await UserService.findUserByEmailAndRole(email, 'Productor');
    if (!user) {
      return res.status(404).json({ error: 'User not found or not a producer' });
    }
    
    console.log('User dep_code:', user.dep_code);
    console.log('User additional_dependencies:', user.additional_dependencies);

    // Obtener todas las dependencias del usuario (principal + adicionales)l + adicionales)
    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
    console.log('All user dependencies:', allUserDependencies);
    
    // Si hay filtro por dependencia, usar solo esa dependencia
    const dependenciesToQuery = filterByDependency ? [filterByDependency] : allUserDependencies;
    console.log('Dependencies to query:', dependenciesToQuery);
    
    // Obtener IDs de las dependencias a consulta
    const dependencies = await Dependency.find({ dep_code: { $in: dependenciesToQuery } });
    console.log('Found dependencies:', dependencies.map(d => ({ code: d.dep_code, name: d.name })));
    const dependencyIds = dependencies.map(dep => dep._id);
    console.log('Dependency IDs:', dependencyIds);

    // Build query for PublishedTemplates
    const query = { 
      name: { $regex: search, $options: 'i' },
      'template.producers': { $in: dependencyIds },
      'template.active': true
    };

    if (periodId) query.period = periodId;

    console.log('Query for templates:', JSON.stringify(query, null, 2));
    
    // Count total documents without pagination
    const total = await PublishedTemplate.countDocuments(query);
    console.log('Total templates found:', total);

    // Fetch templates with initial population
    const templates = await PublishedTemplate.find(query)
      .skip(skip)
      .limit(limit)
      .populate('period')
      .populate({
        path: 'template',
        populate: [
          { path: 'dimensions', model: 'dimensions' },
          { path: 'producers', model: 'dependencies' }
        ]
      }).lean();

    // Manually fetch categories
    const templatesWithCategories = await Promise.all(templates.map(async (template) => {
      // Find the category directly from the original template
      const originalTemplate = await Template.findById(template.template._id)
        .populate({
          path: 'category',
          model: 'categories',
          select: 'name templates' // Select specific fields if needed
        }).lean();
      
        // Find the sequence for this template within the category
        let sequence = null;
        if (originalTemplate.category) {
          const sequenceObj = originalTemplate.category.templates.find(
            t => t.templateId.toString() === template.template._id.toString()
          );
          sequence = sequenceObj ? sequenceObj.sequence : null;
        }
  
        return {
          ...template,
          template: {
            ...template.template,
            category: {
              ...originalTemplate.category,
              templateSequence: sequence
            }
          }
        };
      }));

      // Custom sorting logic
      const sortedTemplates = templatesWithCategories.sort((a, b) => {
        // First, prioritize templates with categories
        const hasCategA = !!a.template.category.name && a.template.category.name !== 'Sin categoría';
        const hasCategB = !!b.template.category.name && b.template.category.name !== 'Sin categoría';
        
        // If one template has a category and the other doesn't, prioritize the one with category
        if (hasCategA !== hasCategB) {
          return hasCategB - hasCategA;
        }
        
        // If both have categories, sort by category name
        const categoryComparison = (a.template.category.name || '').localeCompare(
          b.template.category.name || ''
        );
        
        // If categories are the same, sort by sequence
        if (categoryComparison === 0) {
          // Handle cases where sequence might be null
          const seqA = a.template.category.templateSequence ?? Infinity;
          const seqB = b.template.category.templateSequence ?? Infinity;
          return seqA - seqB;
        }
        
        return categoryComparison;
      });

    // Paginate the sorted templates
    const paginatedTemplates = sortedTemplates.slice(skip, skip + limit);

    // Filter templates without loaded data for queried dependencies
    const filteredTemplates = paginatedTemplates.filter(
      (template) => {
        const hasLoadedData = template.loaded_data?.some((data) => dependenciesToQuery.includes(data.dependency));
        if (hasLoadedData) {
          console.log(`Template '${template.name}' filtered out - already has data from dependencies:`, 
            template.loaded_data.filter(d => dependenciesToQuery.includes(d.dependency)).map(d => d.dependency)
          );
        }
        return !hasLoadedData;
      }
    );
    
    console.log(`Templates after filtering: ${filteredTemplates.length} of ${paginatedTemplates.length}`);

    // Get validators for filtered templates
    const templatesWithValidators = await Promise.all(
      filteredTemplates.map(async (template) => {
        const validators = (
          await Promise.all(
            template.template.fields.map(async (field) => 
              Validator.giveValidatorToExcel(field.validate_with)
            )
          )
        ).filter(Boolean);

        return { ...template, validators };
      })
    );

    res.status(200).json({
      templates: templatesWithValidators,
      total,
      page: Number(page),
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Error fetching available templates:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};


publTempController.getTemplateById = async (req, res) => {
  const templateId = req.params.id;

  try {
    const publishedTemplate = await PublishedTemplate.findById(templateId)
      .populate({
        path: 'template',
        populate: [
          { path: 'dimensions', model: 'dimensions' },
          { path: 'producers', model: 'dependencies' },
        ]
      })


    if (!publishedTemplate) {
      return res.status(404).json({ status: 'Template not found' });
    }

    const validatorsMap = new Map();

    const fieldsWithValidatorIds = await Promise.all(publishedTemplate.template.fields.map(async (field) => {
      if (field.validate_with) {
        try {
          // Extraer el nombre del template y el nombre de la columna desde field.validate_with
          const [templateName, columnName] = field.validate_with.split(' - ');

          // Buscar en la base de datos por el templateName y luego encontrar la columna correspondiente
          const validator = await ValidatorModel.findOne({ name: templateName });

          if (validator) {
            // Encontrar la columna que es validadora
            const column = validator.columns.find(col => col.name === columnName && col.is_validator);

            if (column) {
              field.validate_with = {
                id: validator._id.toString(),
                name: `${validator.name} - ${column.name}`,
              };

              // Recolectar datos del validator para incluirlos en la respuesta
              if (!validatorsMap.has(validator.name)) {
                const values = validator.columns.reduce((acc, col) => {
                  col.values.forEach((value, index) => {
                    if (!acc[index]) acc[index] = {};
                    acc[index][col.name] = value.$numberInt !== undefined ? value.$numberInt : value;
                  });
                  return acc;
                }, []);
                validatorsMap.set(validator.name, { name: validator.name, values });
              }
            } else {
              console.error(`Validator column not found for: ${columnName}`);
            }
          } else {
            console.error(`Validator not found for template: ${templateName}`);
          }
        } catch (err) {
          console.error(`Error during ValidatorModel.findOne: ${err.message}`);
        }
      }
      return field;
    }));

    const response = {
      name: publishedTemplate.name,
      template: {
        ...publishedTemplate.template._doc,
        fields: fieldsWithValidatorIds,
        validators: Array.from(validatorsMap.values()),
      },
      publishedTemplate: publishedTemplate
    };

    res.status(200).json(response);
  } catch (error) {
    console.error('Error fetching template by ID:', error);
    res.status(500).json({ status: 'Internal Server Error', error: error.message });
  }
};

publTempController.getUploadedTemplateDataByProducer = async (req, res) => {
  const { id_template } = req.params;
  const { email } = req.query;

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ status: 'User not found' });
    }

    // Obtener todas las dependencias del usuario
    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);

    // Busca la plantilla publicada donde alguna de las dependencias del usuario haya enviado datos
    const template = await PublishedTemplate.findOne({
      _id: id_template,
      'loaded_data.dependency': { $in: allUserDependencies },
    });

    if (!template) {
      return res.status(404).json({ status: 'Template not found' });
    }

    // Encuentra los datos enviados por cualquiera de las dependencias del usuario
    const producerData = template.loaded_data.find(
      (data) => allUserDependencies.includes(data.dependency)
    );

    if (!producerData) {
      return res.status(404).json({ status: 'No data found for dependency' });
    }

    // Aplicar conversión de hipervínculos y códigos de país a los datos
    const processedData = await Promise.all(producerData.filled_data.map(async item => {
      // Verificar si el campo es de país
      const isCountryField = item.field_name && 
        (item.field_name.toLowerCase().includes('pais') || 
         item.field_name.toLowerCase().includes('país') ||
         item.field_name.toLowerCase().includes('country'));
      
      const processedValues = await Promise.all(item.values.map(async value => {
        let processedValue = convertHyperlinkToText(value);
        if (isCountryField) {
          processedValue = convertCountryCodeToId(processedValue);
        }
        // Convertir IDs a valores descriptivos
        processedValue = await convertIdToDescriptive(item.field_name, processedValue);
        return processedValue;
      }));
      
      return {
        ...item,
        values: processedValues
      };
    }));
    
    res.status(200).json({ data: processedData });
  } catch (error) {
    console.error('Error fetching template data:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

//Only deletes if there's no loaded data
publTempController.deletePublishedTemplate = async (req, res) => {
  const { id, email } = req.query;

  try {
    const user = await UserService.findUserByEmailAndRole(email, 'Administrador');

    const template = await PublishedTemplate.findById(id);
    if (!template) {
      throw new Error('Template not found');
    }

    if (template.loaded_data?.length > 0) {
      throw new Error('Template has loaded data');
    }

    await PublishedTemplate.findByIdAndDelete(id);
    
    // Audit log
    console.log('🔍 Executing audit log for publishedTemplate deletion');
    await auditLogger.logDelete(req, user, 'publishedTemplate', {
      templateId: id,
      templateName: template.name
    });
    console.log('✅ Audit log completed for publishedTemplate deletion');
    
    res.status(200).json({ status: 'Template deleted successfully' });
  } catch (error) {
    console.error('Error deleting template:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

publTempController.updateDeadlines = async (req, res) => {
  try {
    const { email, templateIds, deadline } = req.body;

    console.log(req.body);


    await UserService.findUserByEmailAndRoles(email, ["Administrador", "Responsable"]);

    const user = await User.findOne({ email });
    
    for (const id of templateIds) {
      const template = await PublishedTemplate.findByIdAndUpdate(id, { deadline });
      
      // Audit log para cada plantilla actualizada
      await auditLogger.logUpdate(req, user, 'publishedTemplateDeadline', {
        publishedTemplateId: id,
        templateName: template?.name || 'Unknown',
        newDeadline: deadline
      });
    }

    return res.status(200).json({ message: "Fechas actualizadas exitosamente." });
  } catch (error) {
    console.error("Error al actualizar deadlines:", error);
    return res.status(500).json({ error: error.message });
  }
};

publTempController.cleanObjectObjectData = async (req, res) => {
  try {
    const { email } = req.query;
    
    // Verificar que sea administrador
    await UserService.findUserByEmailAndRole(email, 'Administrador');
    
    const { cleanObjectObjectData } = require('../scripts/cleanObjectObjectData');
    const result = await cleanObjectObjectData();
    
    res.status(200).json(result);
  } catch (error) {
    console.error('Error cleaning object data:', error);
    res.status(500).json({ error: error.message });
  }
};

publTempController.cleanHyperlinkData = async (req, res) => {
  try {
    const { email } = req.query;
    
    // Verificar que sea administrador
    await UserService.findUserByEmailAndRole(email, 'Administrador');
    
    console.log('🧹 Iniciando limpieza de hipervínculos en todas las plantillas...');
    
    const templates = await PublishedTemplate.find({});
    let totalCleaned = 0;
    let templatesProcessed = 0;
    
    for (const template of templates) {
      let templateModified = false;
      
      for (const loadedData of template.loaded_data) {
        for (const fieldData of loadedData.filled_data) {
          for (let i = 0; i < fieldData.values.length; i++) {
            const originalValue = fieldData.values[i];
            const cleanedValue = convertHyperlinkToText(originalValue);
            
            if (originalValue !== cleanedValue) {
              fieldData.values[i] = cleanedValue;
              totalCleaned++;
              templateModified = true;
            }
          }
        }
      }
      
      if (templateModified) {
        await template.save();
        templatesProcessed++;
        console.log(`✅ Plantilla limpiada: ${template.name}`);
      }
    }
    
    console.log(`🎉 Limpieza completada: ${totalCleaned} valores limpiados en ${templatesProcessed} plantillas`);
    
    res.status(200).json({
      message: 'Limpieza de hipervínculos completada',
      totalCleaned,
      templatesProcessed,
      totalTemplates: templates.length
    });
  } catch (error) {
    console.error('Error cleaning hyperlink data:', error);
    res.status(500).json({ error: error.message });
  }
};




publTempController.hasData = async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.query;

    const pubTem = await PublishedTemplate.findById(id, 'loaded_data');
    if (!pubTem) {
      return res.status(404).json({ status: 'Published template not found' });
    }

    if (!email) {
      // Sin email, responder si hay algún dato cargado en la plantilla
      return res.json({ hasData: pubTem.loaded_data.length > 0 });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ status: 'User not found' });
    }

    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
    const hasData = pubTem.loaded_data.some(d => allUserDependencies.includes(d.dependency));

    return res.json({ hasData });
  } catch (error) {
    return res.status(500).json({ status: 'Internal server error', message: error.message });
  }
};

module.exports = publTempController;
