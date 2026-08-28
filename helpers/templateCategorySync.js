const Category = require("../models/categories");
const Template = require("../models/templates");

const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Switches del formulario de plantillas que tienen una categoría propia.
// El orden define la prioridad al momento de asignar la referencia única
// `template.category` cuando hay más de un switch activo.
const CATEGORY_FLAGS = [
  { flag: "is_snies", name: "SNIES" },
  { flag: "is_cna", name: "CNA" },
  { flag: "is_otra", name: "Otra" },
];

const findCategoryByName = (name) =>
  Category.findOne({ name: new RegExp(`^${escapeRegExp(name)}$`, "i") });

/**
 * Mantiene sincronizadas las categorías SNIES / CNA / Otra con los switches de
 * la plantilla: agrega la plantilla a la categoría de cada switch encendido
 * (creándola si aún no existe) y la retira de la categoría de los switches
 * apagados. Las categorías creadas manualmente no se tocan.
 */
const syncTemplateCategories = async (template) => {
  if (!template?._id) return;

  const templateId = template._id;
  const managed = [];

  for (const { flag, name } of CATEGORY_FLAGS) {
    const isActive = template[flag] === true;
    let category = await findCategoryByName(name);

    if (!category) {
      // Solo se crea la categoría cuando el switch está encendido, para no
      // llenar el listado con categorías vacías.
      if (!isActive) continue;
      category = await Category.create({ name, templates: [] });
    }

    const hasTemplate = category.templates.some(
      (t) => String(t.templateId) === String(templateId)
    );

    if (isActive && !hasTemplate) {
      category.templates.push({ templateId });
      await category.save();
    } else if (!isActive && hasTemplate) {
      category.templates = category.templates.filter(
        (t) => String(t.templateId) !== String(templateId)
      );
      await category.save();
    }

    managed.push({ isActive, categoryId: String(category._id) });
  }

  if (managed.length === 0) return;

  // `template.category` es una referencia única, así que se apunta a la
  // categoría activa de mayor prioridad. Si la plantilla está en una categoría
  // creada manualmente, esa asignación se respeta.
  const managedIds = managed.map((m) => m.categoryId);
  const currentId = template.category ? String(template.category) : null;
  const preferred = managed.find((m) => m.isActive);

  if (preferred) {
    if ((!currentId || managedIds.includes(currentId)) && currentId !== preferred.categoryId) {
      await Template.findByIdAndUpdate(templateId, { category: preferred.categoryId });
    }
  } else if (currentId && managedIds.includes(currentId)) {
    await Template.findByIdAndUpdate(templateId, { $unset: { category: "" } });
  }
};

module.exports = { syncTemplateCategories, CATEGORY_FLAGS };
