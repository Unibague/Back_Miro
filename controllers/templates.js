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

const { ObjectId } = mongoose.Types;

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

    const templates = await Template.find(query).populate("dimensions").sort({ name: 1 })

    const templatesWithValidators = await Promise.all(
      templates.map(async (template) => {
        const validators = await Promise.all(
          template.fields.map(async (field) => {
            return Validator.giveValidatorToExcel(field.validate_with);
          })
        );

        template = template.toObject();
        if (periodId) {
          const publishedTemplate = await PubTemplate.findOne({
            "template._id": template._id,
            period: periodId,
          });
          template.published = !!publishedTemplate;
        }
        validatorsFiltered = validators.filter((v) => v !== undefined);
        template.validators = validatorsFiltered; // Add validators to object

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
    const templates = await Template.find(query).populate('dimensions').skip(skip).limit(limit);

    const total = await Template.countDocuments(query);

    const templatesWithValidators = await Promise.all(
      templates.map(async (template) => {
        const validators = await Promise.all(
          template.fields.map(async (field) => {
            return Validator.giveValidatorToExcel(field.validate_with);
          })
        );

        
        template = template.toObject();
        if (periodId) {
          const publishedTemplate = await PubTemplate.findOne({
            'template._id': template._id,
            'period': periodId
          });
          if (publishedTemplate) {
            template.published = true;
          } else {
            template.published = false;
          }
        }
        validatorsFiltered = validators.filter((v) => v !== undefined);
        template.validators = validatorsFiltered; // Añadir validators al objeto

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
    
    const templates = await Template.find(query).skip(skip).limit(limit);
    console.log('Found templates count:', templates.length);
    const total = await Template.countDocuments(query);

    const templatesWithValidators = await Promise.all(
      templates.map(async (template) => {
        const validators = await Promise.all(
          template.fields.map(async (field) => {
            return Validator.giveValidatorToExcel(field.validate_with);
          })
        );

        template = template.toObject();
        validatorsFiltered = validators.filter((v) => v !== undefined);
        template.validators = validatorsFiltered; // Añadir validators al objeto

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
    const plantilla = await Template.findById(id);
    if (!plantilla) {
      return res.status(404).json({ mensaje: "Plantilla no encontrada" });
    }
    res.status(200).json(plantilla);
  } catch (error) {
    res.status(500).json({ mensaje: "Error al obtener la plantilla", error });
  }
};

templateController.createPlantilla = async (req, res) => {
  try {
    const existingTemplate = await Template.findOne({
      name: new RegExp(`^${req.body.name}$`, "i"),
    });
    if (existingTemplate) {
      return res
        .status(400)
        .json({
          mensaje:
            "El nombre de la plantilla ya existe. Por favor, elija otro nombre.",
        });
    }

    const invalidFileNameChars = /[<>:"/\\|?*]/;
  if (req.body.file_name && invalidFileNameChars.test(req.body.file_name)) {
    return res.status(400).json({
      error: "El nombre del archivo contiene caracteres no permitidos: <>:\"/\\|?*"
    });
  }
    
    console.log('Body ', req.body);
    const user = await UserService.findUserByEmailAndRole(req.body.email, "Administrador");
    const plantilla = new Template({ ...req.body, created_by: user });
    await plantilla.save();
    res.status(200).json({ status: "Plantilla creada" });
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
  const updatedFields = req.body;

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

    // 🔁 Se sincronizan los producers embebidos en publishedTemplates
    const objectId = new mongoose.Types.ObjectId(id);
    const newProducersAsObjectIds = updatedFields.producers.map(id => new mongoose.Types.ObjectId(id));

    const camposASincronizar = {
      name: updatedTemplate.name,
      "template.name": updatedTemplate.name,
      "template.file_name": updatedTemplate.file_name,
      "template.file_description": updatedTemplate.file_description,
      "template.fields": updatedTemplate.fields,
      "template.producers": newProducersAsObjectIds,
      "template.dimensions": updatedTemplate.dimensions,
      "template.active": updatedTemplate.active,
    };

    const updatedPublishedTemplates = await PublishedTemplate.updateMany(
      { "template._id": objectId },
      { $set: camposASincronizar }
    );

    console.log(`Sincronizados ${updatedPublishedTemplates.modifiedCount} publishedTemplates con los nuevos datos`);
    return res.status(200).json(updatedTemplate);

  } catch (error) {
    console.error("Error al actualizar la plantilla:", error);
    return res.status(500).json({ error: error.message });
  }
};

templateController.syncAllPublishedTemplates = async (req, res) => {
  try {
    const templates = await Template.find({}, "_id name file_name file_description fields producers dimensions active");

    let totalUpdated = 0;
    const logs = [];

    for (const template of templates) {
      const templateId = new mongoose.Types.ObjectId(template._id);

      // Construir snapshot completo
      const templateSnapshot = {
        _id: template._id,
        name: template.name,
        file_name: template.file_name,
        file_description: template.file_description,
        fields: template.fields,
        producers: template.producers,
        dimensions: template.dimensions,
        active: template.active,
      };

      const result = await PublishedTemplate.updateMany(
        { "template._id": templateId },
        {
          $set: {
            template: templateSnapshot,
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
    const publishedTemplate = await PubTemplate.find({
      'template._id': new ObjectId(id)
    });

    console.log(id, publishedTemplate)

    if (publishedTemplate.length > 0) {
      return res.status(400).json({ mensaje: "No se puede eliminar la plantilla porque ya está publicada" });
    }
    const plantillaEliminada = await Template.findByIdAndDelete(id);
    if (!plantillaEliminada) {
      return res.status(404).json({ mensaje: "Plantilla no encontrada" });
    }
    res.status(200).json({ status: "Plantilla eliminada" });
  } catch (error) {
    console.error("Error al eliminar la plantilla:", error);
    res.status(500).json({ mensaje: "Error al eliminar la plantilla", error });
  }
};

module.exports = templateController;
