const Template = require("../models/templates");
const PubTemplate = require("../models/publishedTemplates");
const PublishedTemplate = require('../models/publishedTemplates');
const Period = require("../models/periods");
const User = require("../models/users");
const Dimension = require("../models/dimensions");
const Validator = require("./validators");
const mongoose = require("mongoose");
const UserService = require("../services/users");
const Dependency = require('../models/dependencies');
const AuditLogger = require('../services/auditLogger');
const { sanitizeTemplateDropdownPayload } = require('../helpers/workbookDropdownSanitizer');

const { ObjectId } = mongoose.Types;

const escapeRegExp = (value = "") => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const validateWithToText = (validateWith) => {
  if (!validateWith) return '';
  if (typeof validateWith === 'string') return validateWith;
  if (typeof validateWith === 'object') return validateWith.name || validateWith.id || '';
  return String(validateWith);
};

const getFieldValidatorReference = (field = {}) =>
  validateWithToText(field.validate_with).trim() || String(field.name || '').trim();

const collectValidatorsForTemplate = async (template, periodId) => {
  const topFields = template.fields || [];
  const sheetFields = (template.workbook_sheets || []).flatMap(s => s.fields || []);
  const allFields = [...topFields, ...sheetFields];
  const seen = new Set();
  const unique = allFields.filter(f => {
    const reference = getFieldValidatorReference(f);
    const key = reference.split(' - ')[0].trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const results = await Promise.all(
    unique.map(f => Validator.giveValidatorToExcel(getFieldValidatorReference(f), periodId))
  );
  return results.filter(Boolean);
};

const datetime_now = () => {
  const now = new Date();

  const offset = -5; // GMT-5
  const dateWithOffset = new Date(now.getTime() + offset * 60 * 60 * 1000);

  return new Date(dateWithOffset.setMilliseconds(now.getMilliseconds()));
};

const templateController = {};


templateController.getTemplatesWithoutPagination = async (req,res) => {
  const search = req.query.search || "";
  const periodId = req.query.periodId;
  const onlyPublishedInPeriod = req.query.onlyPublishedInPeriod === "true";

  try {
    const query = search
      ? {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { file_name: { $regex: search, $options: "i" } },
            { file_description: { $regex: search, $options: "i" } },
          ],
        }
      : {};

    if (periodId && onlyPublishedInPeriod) {
      const publishedTemplates = await PubTemplate.find(
        { period: periodId },
        { "template._id": 1 }
      ).lean();

      const publishedTemplateIds = [
        ...new Set(
          publishedTemplates
            .map((pt) => String(pt.template?._id || ""))
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
        ),
      ].map((id) => new ObjectId(id));

      if (!query.$and) query.$and = [];
      query.$and.push({ _id: { $in: publishedTemplateIds } });
    }

    const templates = await Template.find(query)
      .collation({ locale: 'es', strength: 1 })
      .populate("dimensions")
      .sort({ name: 1 })

    const templatesWithValidators = await Promise.all(
      templates.map(async (template) => {
        template = await sanitizeTemplateDropdownPayload(template);
        if (periodId) {
          const publishedTemplate = await PubTemplate.findOne({
            "template._id": template._id,
            period: periodId,
          });
          template.published = !!publishedTemplate;
        }
        template.validators = await collectValidatorsForTemplate(template, periodId);
        return template;
      })
    );

    res.status(200).json({ templates: templatesWithValidators });
  } catch (error) {
    console.error("Error fetching templates:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
}

templateController.getPlantillas = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const skip = (page - 1) * limit;
  const periodId = req.query.periodId;
  const onlyPublishedInPeriod = req.query.onlyPublishedInPeriod === "true";

  try {
    const query = search
      ? {
          $and: [
            {
              $or: [
                { name: { $regex: search, $options: "i" } },
                { file_name: { $regex: search, $options: "i" } },
                { file_description: { $regex: search, $options: "i" } },
              ],
            },
          ],
        }
      : {};

    if (periodId && onlyPublishedInPeriod) {
      const publishedTemplates = await PubTemplate.find(
        { period: periodId },
        { "template._id": 1 }
      ).lean();

      const publishedTemplateIds = [
        ...new Set(
          publishedTemplates
            .map((publishedTemplate) => String(publishedTemplate.template?._id || ""))
            .filter((id) => mongoose.Types.ObjectId.isValid(id))
        ),
      ].map((id) => new ObjectId(id));

      const periodFilters = [{ _id: { $in: publishedTemplateIds } }];
      if (mongoose.Types.ObjectId.isValid(periodId)) {
        periodFilters.push({ period: new ObjectId(periodId) });
      }

      if (!query.$and) query.$and = [];
      query.$and.push({ $or: periodFilters });
    }

    const templates = await Template.find(query)
      .collation({ locale: 'es', strength: 1 })
      .populate('dimensions')
      .skip(skip)
      .limit(limit);

    const total = await Template.countDocuments(query);

    const templatesWithValidators = await Promise.all(
      templates.map(async (template) => {
        template = await sanitizeTemplateDropdownPayload(template);
        if (periodId) {
          const publishedTemplate = await PubTemplate.findOne({
            'template._id': template._id,
            'period': periodId
          });
          template.published = !!publishedTemplate;
        }
        template.validators = await collectValidatorsForTemplate(template, periodId);
        return template;
      })
    );

    res.status(200).json({
      templates: templatesWithValidators,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Error fetching templates:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

templateController.getPlantillasByCreator = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const search = req.query.search || "";
  const email = req.query.email;
  const periodId = req.query.periodId;
  const skip = (page - 1) * limit;

  try {
    console.log('=== DEBUG getPlantillasByCreator ===');
    console.log('Email:', email);
    
    // Obtener usuario con dependencias adicionales
    const user = await User.findOne({ email }).select('dep_code additional_dependencies');
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }
    
    console.log('User dep_code:', user.dep_code);
    console.log('User additional_dependencies:', user.additional_dependencies);

    // Crear array con todas las dependencias del usuario
    const allUserDependencies = [user.dep_code, ...(user.additional_dependencies || [])].filter(Boolean);
    console.log('All user dependencies:', allUserDependencies);
    
    // Obtener IDs de las dependencias
    const dependencies = await Dependency.find({ dep_code: { $in: allUserDependencies } }).select('_id dep_code name');
    console.log('Found dependencies:', dependencies);
    const dependencyIds = dependencies.map(dep => dep._id);
    console.log('Dependency IDs:', dependencyIds);
    
    // Buscar dimensiones donde las dependencias del usuario son responsables
    const dimensions = await Dimension.find({
      responsible: { $in: dependencyIds }
    });
    console.log('Found dimensions:', dimensions);

    const query = {
      dimension: { $in: dimensions.map((dimension) => dimension._id) },
      $or: [
        { name: { $regex: search, $options: "i" } },
        { file_name: { $regex: search, $options: "i" } },
        { file_description: { $regex: search, $options: "i" } },
      ],
    };
    console.log('Template query:', JSON.stringify(query, null, 2));
    
    const templates = await Template.find(query)
      .collation({ locale: 'es', strength: 1 })
      .skip(skip)
      .limit(limit);
    console.log('Found templates count:', templates.length);
    const total = await Template.countDocuments(query);

    const templatesWithValidators = await Promise.all(
      templates.map(async (template) => {
        template = await sanitizeTemplateDropdownPayload(template);
        template.validators = await collectValidatorsForTemplate(template, periodId);
        return template;
      })
    );

    res.status(200).json({
      templates: templatesWithValidators,
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error("Error fetching templates by creator:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

templateController.getPlantilla = async (req, res) => {
  try {
    const { id } = req.params;
    const { periodId, withValidators } = req.query;
    const plantilla = await Template.findById(id).populate("category", "name");
    if (!plantilla) {
      return res.status(404).json({ mensaje: "Plantilla no encontrada" });
    }
    const result = await sanitizeTemplateDropdownPayload(plantilla);
    if (withValidators === 'true' || withValidators === '1') {
      result.validators = await collectValidatorsForTemplate(result, periodId || null);
    }
    res.status(200).json(result);
  } catch (error) {
    res.status(500).json({ mensaje: "Error al obtener la plantilla", error });
  }
};

templateController.createPlantilla = async (req, res) => {
  try {
    const sanitizedBody = await sanitizeTemplateDropdownPayload(req.body);
    const autoRename = sanitizedBody.auto_rename === true || sanitizedBody.auto_rename === "true";
    const requestedName = String(sanitizedBody.name || "").trim();
    let templateName = requestedName;
    let existingTemplate = await Template.findOne({
      name: new RegExp(`^${escapeRegExp(templateName)}$`, "i"),
    });

    if (existingTemplate && autoRename) {
      const baseName = requestedName || "Plantilla base";
      let counter = 2;
      do {
        templateName = `${baseName} (${counter})`;
        existingTemplate = await Template.findOne({
          name: new RegExp(`^${escapeRegExp(templateName)}$`, "i"),
        });
        counter += 1;
      } while (existingTemplate);

      sanitizedBody.name = templateName;
    }

    if (existingTemplate) {
      return res
        .status(400)
        .json({
          mensaje:
            "El nombre de la plantilla ya existe. Por favor, elija otro nombre.",
        });
    }

    const invalidFileNameChars = /[<>:"/\\|?*]/;
  if (sanitizedBody.file_name && invalidFileNameChars.test(sanitizedBody.file_name)) {
    return res.status(400).json({
      error: "El nombre del archivo contiene caracteres no permitidos: <>:\"/\\|?*"
    });
  }
    
    console.log('Body ', sanitizedBody);
    const user = await UserService.findUserByEmailAndRole(sanitizedBody.email, "Administrador");
    const plantilla = new Template({ ...sanitizedBody, created_by: user });
    await plantilla.save();

    // Registrar en auditoría (non-blocking)
    try {
      await AuditLogger.logCreate(req, user, 'template', {
        templateId: plantilla._id.toString(),
        templateName: plantilla.name,
        fileName: plantilla.file_name
      });
    } catch (auditError) {
      console.warn('Audit logging failed (non-critical):', auditError.message);
    }

    // Crear validadores automáticamente para campos con opciones desplegables
    try {
      await Validator.createValidatorsFromDropdownOptions(sanitizedBody.fields, sanitizedBody.period);
    } catch (autoValidatorError) {
      console.warn('Auto-validator creation failed (non-critical):', autoValidatorError.message);
    }

    res.status(200).json({ status: "Plantilla creada", _id: plantilla._id, template: plantilla });
  } catch (error) {
    console.error("Error al crear la plantilla:", error);
    if (error.name === "ValidationError") {
      const mensajesErrores = {};
      for (let campo in error.errors) {
        mensajesErrores[campo] = error.errors[campo].message;
      }
      res
        .status(400)
        .json({
          mensaje: "Error al crear la plantilla",
          errores: mensajesErrores,
        });
    } else {
      res.status(500).json({ mensaje: "Error interno del servidor", error });
    }
  }
};

templateController.updatePlantilla = async (req, res) => {
  const { id } = req.params;
  const updatedFields = await sanitizeTemplateDropdownPayload(req.body);

  const invalidFileNameChars = /[<>:"/\\|?*]/;
  if (updatedFields.file_name && invalidFileNameChars.test(updatedFields.file_name)) {
    return res.status(400).json({
      error: "El nombre del archivo contiene caracteres no permitidos: <>:\"/\\|?*"
    });
  }

  // ✅ Validación de campos requeridos en los fields
  if (Array.isArray(updatedFields.fields)) {
    const invalidField = updatedFields.fields.find(field => 
      !field.name?.trim() || !field.datatype?.trim()
    );
    if (invalidField) {
      return res.status(400).json({
        error: "Todos los campos deben tener un nombre y un tipo de dato definidos."
      });
    }
  }

  try {
    const originalTemplate = await Template.findById(id).populate('producers');
    if (!originalTemplate) {
      return res.status(404).json({ error: "Plantilla no encontrada" });
    }

    if (!updatedFields.producers) {
      const updatedTemplate = await Template.findByIdAndUpdate(id, updatedFields, { new: true });
      if (Array.isArray(updatedFields.fields)) {
        try {
          await Validator.createValidatorsFromDropdownOptions(
            updatedFields.fields,
            updatedFields.period || originalTemplate.period
          );
        } catch (autoValidatorError) {
          console.warn('Auto-validator update failed (non-critical):', autoValidatorError.message);
        }
      }
      return res.status(200).json(updatedTemplate);
    }

    const oldProducers = originalTemplate.producers.map(p => p._id.toString());
    const newProducers = updatedFields.producers.map(p => p.toString());
    const removedProducers = oldProducers.filter(p => !newProducers.includes(p));

    const removedDependencies = await Dependency.find({ _id: { $in: removedProducers } });
    const removedDepCodes = removedDependencies.map(dep => dep.dep_code);

    const publishedTemplates = await PublishedTemplate.find({ "template._id": id });

    const bloqueadas = [];

    for (const pub of publishedTemplates) {
      for (const depCode of removedDepCodes) {
        const yaEnvio = pub.loaded_data.some(ld => ld.dependency === depCode);
        if (yaEnvio) {
          bloqueadas.push(depCode);
        }
      }
    }

    if (bloqueadas.length > 0) {
      const deps = await Dependency.find({ dep_code: { $in: bloqueadas } });
      const nombres = deps.map(d => d.name).join(', ');
      return res.status(403).json({
        error: `No puedes eliminar las siguientes dependencias porque ya han enviado datos (aunque sea vacío): ${nombres}`
      });
    }

    const updatedTemplate = await Template.findByIdAndUpdate(id, updatedFields, { new: true });
    if (Array.isArray(updatedFields.fields)) {
      try {
        await Validator.createValidatorsFromDropdownOptions(
          updatedFields.fields,
          updatedFields.period || originalTemplate.period
        );
      } catch (autoValidatorError) {
        console.warn('Auto-validator update failed (non-critical):', autoValidatorError.message);
      }
    }

    // 🔁 Se sincronizan los producers embebidos en publishedTemplates
    const objectId = new mongoose.Types.ObjectId(id);
    const newProducersAsObjectIds = updatedFields.producers.map(id => new mongoose.Types.ObjectId(id));

    const camposASincronizar = {
      name: updatedTemplate.name,
      "template.name": updatedTemplate.name,
      "template.file_name": updatedTemplate.file_name,
      "template.file_description": updatedTemplate.file_description,
      "template.fields": updatedTemplate.fields,
      "template.workbook_sheets": updatedTemplate.workbook_sheets,
      "template.original_workbook_base64": updatedTemplate.original_workbook_base64,
      "template.producers": newProducersAsObjectIds,
      "template.dimensions": updatedTemplate.dimensions,
      "template.active": updatedTemplate.active,
      "template.shared": updatedTemplate.shared ?? false,
      "template.allows_qr": updatedTemplate.allows_qr ?? false,
      "template.notify_producers": updatedTemplate.notify_producers ?? false,
      "template.fecha_inicio": updatedTemplate.fecha_inicio ?? null,
      "template.fecha_final_productores": updatedTemplate.fecha_final_productores ?? null,
      "template.fecha_final_responsables": updatedTemplate.fecha_final_responsables ?? null,
      "template.fecha_final": updatedTemplate.fecha_final ?? null,
      "template.responsible_producers": updatedTemplate.responsible_producers ?? [],
      // Sincronizar también al nivel raíz de publishedTemplate para que el frontend lo lea sin fallback profundo
      responsible_producers: updatedTemplate.responsible_producers ?? [],
      notify_producers: updatedTemplate.notify_producers ?? false,
      ...(updatedTemplate.fecha_final_productores != null && { fecha_final_productores: updatedTemplate.fecha_final_productores }),
      ...(updatedTemplate.fecha_final_responsables != null && { fecha_final_responsables: updatedTemplate.fecha_final_responsables }),
      ...(updatedTemplate.fecha_final != null && { fecha_final: updatedTemplate.fecha_final, deadline: updatedTemplate.fecha_final }),
      ...(updatedTemplate.fecha_inicio != null && { fecha_inicio: updatedTemplate.fecha_inicio }),
    };

    const updatedPublishedTemplates = await PublishedTemplate.updateMany(
      { "template._id": objectId },
      { $set: camposASincronizar }
    );

    console.log(`Sincronizados ${updatedPublishedTemplates.modifiedCount} publishedTemplates con los nuevos datos`);
    
    // Registrar en auditoría (non-blocking)
    try {
      const userEmail = updatedFields.email || 'user';
      const user = await User.findOne({ email: userEmail });
      if (user) {
        await AuditLogger.logUpdate(req, user, 'template', {
          templateId: id,
          templateName: updatedTemplate.name,
          fileName: updatedTemplate.file_name
        });
      }
    } catch (auditError) {
      console.warn('Audit logging failed (non-critical):', auditError.message);
    }
    
    return res.status(200).json(updatedTemplate);

  } catch (error) {
    console.error("Error al actualizar la plantilla:", error);
    return res.status(500).json({ error: error.message });
  }
};

templateController.syncAllPublishedTemplates = async (req, res) => {
  try {
    const templates = await Template.find({}, "_id name file_name file_description fields workbook_sheets original_workbook_base64 producers dimensions active notify_producers");

    let totalUpdated = 0;
    const logs = [];

    for (const template of templates) {
      const templateId = new mongoose.Types.ObjectId(template._id);

      // Construir snapshot completo
      const templateSnapshot = await sanitizeTemplateDropdownPayload({
        _id: template._id,
        name: template.name,
        file_name: template.file_name,
        file_description: template.file_description,
        fields: template.fields,
        workbook_sheets: template.workbook_sheets,
        original_workbook_base64: template.original_workbook_base64,
        producers: template.producers,
        dimensions: template.dimensions,
        active: template.active,
        notify_producers: template.notify_producers ?? false,
      });

      const result = await PublishedTemplate.updateMany(
        { "template._id": templateId },
        {
          $set: {
            template: templateSnapshot,
            notify_producers: template.notify_producers ?? false,
            name: template.name, // <- actualiza el nombre del publishedTemplate también
          },
        }
      );

      if (result.modifiedCount > 0) {
        logs.push({
          templateId: template._id,
          updatedCount: result.modifiedCount,
        });
        totalUpdated += result.modifiedCount;
      }
    }

    return res.status(200).json({
      message: "Sincronización completada",
      totalTemplates: templates.length,
      totalPublishedTemplatesActualizados: totalUpdated,
      detalles: logs,
    });
  } catch (err) {
    console.error("Error sincronizando publishedTemplates:", err);
    return res.status(500).json({ error: err.message });
  }
};


templateController.deletePlantilla = async (req, res) => {
  try {
    const { id } = req.body;
    
    // Obtener la plantilla antes de eliminarla para la auditoría
    const template = await Template.findById(id);
    if (!template) {
      return res.status(404).json({ mensaje: "Plantilla no encontrada" });
    }
    
    const publishedTemplate = await PubTemplate.find({
      'template._id': new ObjectId(id)
    });

    console.log(id, publishedTemplate)

    if (publishedTemplate.length > 0) {
      return res.status(400).json({ mensaje: "No se puede eliminar la plantilla porque ya está publicada" });
    }
    
    const plantillaEliminada = await Template.findByIdAndDelete(id);
    
    // Registrar en auditoría (non-blocking)
    try {
      const userEmail = req.body.userEmail || req.query.email || 'user';
      const user = await User.findOne({ email: userEmail });
      if (user) {
        await AuditLogger.logDelete(req, user, 'template', {
          templateId: id,
          templateName: template.name,
          fileName: template.file_name
        });
      }
    } catch (auditError) {
      console.warn('Audit logging failed (non-critical):', auditError.message);
    }
    
    res.status(200).json({ status: "Plantilla eliminada" });
  } catch (error) {
    console.error("Error al eliminar la plantilla:", error);
    res.status(500).json({ mensaje: "Error al eliminar la plantilla", error });
  }
};

module.exports = templateController;
