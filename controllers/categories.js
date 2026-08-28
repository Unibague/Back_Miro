const Category = require("../models/categories");
const Template = require("../models/templates");
const PublishedTemplate = require('../models/publishedTemplates');

const mongoose = require("mongoose");

const categoryController = {};

// Crear una nueva categoría
categoryController.createCategory = async (req, res) => {
  try {
    const { name, templates } = req.body;

    if (!name) {
      return res.status(400).json({ message: "El nombre de la categoría es requerido" });
    }

    // Create the new category with template references
    const category = new Category({
      name,
      templates: templates?.map(t => ({
        templateId: t.templateId // Reference to Template._id
      })) || []
    });

    await category.save();

        if (templates && templates.length > 0) {
          const isSniesCategory = name.toUpperCase().includes("SNIES");
          const isCnaCategory = name.toUpperCase().includes("CNA");
          const isOtraCategory = name.trim().toUpperCase() === "OTRA";
          await Promise.all(
            templates.map(t =>
              Template.findByIdAndUpdate(
                t.templateId,
                {
                  category: category._id,
                  ...(isSniesCategory ? { is_snies: true } : {}),
                  ...(isCnaCategory ? { is_cna: true } : {}),
                  ...(isOtraCategory ? { is_otra: true } : {}),
                },
                { new: true }
              )
            )
          );
        }


    res.status(201).json({ message: "Categoría creada exitosamente", category });
  } catch (error) {
    console.error("Error al crear la categoría:", error);
    res.status(500).json({ message: "Hubo un error al crear la categoría", error: error.message });
  }
};

// Obtener todas las categorías
categoryController.getCategories = async (req, res) => {
  try {
    const categories = await Category.find().populate("templates.templateId");
    res.status(200).json({ categories });
  } catch (error) {
    console.error("Error al obtener las categorías:", error);
    res.status(500).json({ message: "Error al obtener las categorías", error });
  }
};

// Obtener una categoría por ID
categoryController.getCategoryById = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const category = await Category.findById(categoryId).populate("templates.templateId");

    if (!category) return res.status(404).json({ message: "Categoría no encontrada" });

    res.status(200).json(category);
  } catch (error) {
    console.error("Error al obtener la categoría:", error);
    res.status(500).json({ message: "Error al obtener la categoría", error });
  }
};

// Asignar una plantilla a una categoría
// Asignar una plantilla a una categoría
categoryController.assignTemplateToCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const { templateId } = req.body;

    if (!templateId) {
      return res.status(400).json({ message: "Datos incompletos" });
    }

    const category = await Category.findById(categoryId);
    if (!category) return res.status(404).json({ message: "Categoría no encontrada" });

    const template = await Template.findById(templateId);
    if (!template) return res.status(404).json({ message: "Plantilla no encontrada" });

    if (category.templates.some(t => t.templateId.equals(templateId))) {
      return res.status(400).json({ message: "La plantilla ya está asignada a esta categoría" });
    }

    category.templates.push({ templateId });
    await category.save();
    await Template.findByIdAndUpdate(templateId, { category: categoryId });

    res.status(200).json({ message: "Plantilla asignada exitosamente", category });
  } catch (error) {
    console.error("Error al asignar plantilla:", error);
    res.status(500).json({ message: "Error interno del servidor" });
  }
};


categoryController.updateCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const { name, templates = [] } = req.body;
    
    if (!name) return res.status(400).json({ message: "El nombre es requerido" });

    const category = await Category.findById(categoryId);
    if (!category) return res.status(404).json({ message: "Categoría no encontrada" });

    const newTemplateIds = templates.map(t => t.templateId.toString());
    const oldTemplateIds = category.templates.map(t => t.templateId.toString());

    const templatesToRemove = oldTemplateIds.filter(id => !newTemplateIds.includes(id));
    const previousName = category.name || "";
    const removedFlags = {
      ...(previousName.toUpperCase().includes("SNIES") ? { is_snies: false } : {}),
      ...(previousName.toUpperCase().includes("CNA") ? { is_cna: false } : {}),
      ...(previousName.trim().toUpperCase() === "OTRA" ? { is_otra: false } : {}),
    };
    await Template.updateMany(
      { _id: { $in: templatesToRemove } },
      { $unset: { category: "" }, ...(Object.keys(removedFlags).length ? { $set: removedFlags } : {}) }
    );

    category.name = name;
    category.templates = templates.map(t => ({ templateId: t.templateId }));
    await category.save();

    const isSniesCategory = name.toUpperCase().includes("SNIES");
    const isCnaCategory = name.toUpperCase().includes("CNA");
    const isOtraCategory = name.trim().toUpperCase() === "OTRA";
    await Template.updateMany(
      { _id: { $in: newTemplateIds } },
      {
        category: categoryId,
        ...(isSniesCategory ? { is_snies: true } : {}),
        ...(isCnaCategory ? { is_cna: true } : {}),
        ...(isOtraCategory ? { is_otra: true } : {}),
      }
    );

    res.status(200).json({ message: "Categoría actualizada exitosamente", category });
  } catch (error) {
    console.error("Error al actualizar categoría:", error);
    res.status(500).json({ message: "Error interno del servidor" });
  }
};



// Eliminar una categoría y limpiar plantillas
categoryController.deleteCategory = async (req, res) => {
  try {
    const { categoryId } = req.params;
    const category = await Category.findById(categoryId);
    if (!category) return res.status(404).json({ message: "Categoría no encontrada" });

    const deletedName = category.name || "";
    const clearedFlags = {
      ...(deletedName.toUpperCase().includes("SNIES") ? { is_snies: false } : {}),
      ...(deletedName.toUpperCase().includes("CNA") ? { is_cna: false } : {}),
      ...(deletedName.trim().toUpperCase() === "OTRA" ? { is_otra: false } : {}),
    };
    await Template.updateMany(
      { category: categoryId },
      { $unset: { category: "" }, ...(Object.keys(clearedFlags).length ? { $set: clearedFlags } : {}) }
    );
    await Category.findByIdAndDelete(categoryId);

    res.status(200).json({ message: "Categoría eliminada exitosamente" });
  } catch (error) {
    console.error("Error al eliminar categoría:", error);
    res.status(500).json({ message: "Error interno del servidor" });
  }
};


module.exports = categoryController;
