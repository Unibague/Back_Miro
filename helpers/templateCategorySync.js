const Category = require("../models/categories");
const Template = require("../models/templates");

const escapeRegExp = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Switches del formulario de plantillas que tienen una categoría propia.
// El orden define la prioridad al momento de asignar la referencia única
// `template.category` cuando hay más de un switch activo. Las demás
// categorías (p. ej. "Gestión interna") se eligen en el selector de
// categoría del formulario.
const CATEGORY_FLAGS = [
  { flag: "is_snies", name: "SNIES" },
  { flag: "is_cna", name: "CNA" },
];

const findCategoryByName = (name) =>
  Category.findOne({ name: new RegExp(`^${escapeRegExp(name)}$`, "i") });

const isManagedCategoryName = (name = "") =>
  CATEGORY_FLAGS.some((c) => c.name.toUpperCase() === String(name).trim().toUpperCase());

/**
 * Deja la plantilla únicamente en la categoría elegida en el selector
 * (`categoryId`, o ninguna si es null), sin tocar SNIES / CNA, que se
 * manejan con los switches.
 */
const syncSelectedCategory = async (templateId, categoryId) => {
  const categories = await Category.find({ "templates.templateId": templateId });
  for (const category of categories) {
    if (isManagedCategoryName(category.name) || String(category._id) === String(categoryId)) continue;
    category.templates = category.templates.filter(
      (t) => String(t.templateId) !== String(templateId)
    );
    await category.save();
  }

  if (!categoryId) return;
  const selected = await Category.findById(categoryId);
  if (!selected || isManagedCategoryName(selected.name)) return;
  if (!selected.templates.some((t) => String(t.templateId) === String(templateId))) {
    selected.templates.push({ templateId });
    await selected.save();
  }
};

/**
 * Mantiene sincronizadas las categorías SNIES / CNA con los switches de la
 * plantilla: agrega la plantilla a la categoría de cada switch encendido
 * (creándola si aún no existe) y la retira de la categoría de los switches
 * apagados. Si se pasa `selectedCategoryId` (incluido null), también deja la
 * plantilla en esa categoría del selector; si se omite, las demás categorías
 * no se tocan.
 */
const syncTemplateCategories = async (template, selectedCategoryId) => {
  if (!template?._id) return;

  const templateId = template._id;

  if (selectedCategoryId !== undefined) {
    await syncSelectedCategory(templateId, selectedCategoryId);
  }

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

  // `template.category` es una referencia única: si se eligió una categoría
  // en el selector, esa manda; si no, se apunta a la categoría activa de
  // mayor prioridad entre SNIES / CNA.
  const currentId = template.category ? String(template.category) : null;
  if (selectedCategoryId) {
    if (currentId !== String(selectedCategoryId)) {
      await Template.findByIdAndUpdate(templateId, { category: selectedCategoryId });
    }
    return;
  }

  if (managed.length === 0) return;

  // Si la plantilla está en una categoría creada manualmente (y no se envió
  // selector), esa asignación se respeta.
  const managedIds = managed.map((m) => m.categoryId);
  const preferred = managed.find((m) => m.isActive);
  const currentIsManual = currentId && !managedIds.includes(currentId) && selectedCategoryId === undefined;

  if (preferred) {
    if (!currentIsManual && currentId !== preferred.categoryId) {
      await Template.findByIdAndUpdate(templateId, { category: preferred.categoryId });
    }
  } else if (currentId && !currentIsManual) {
    await Template.findByIdAndUpdate(templateId, { $unset: { category: "" } });
  }
};

module.exports = { syncTemplateCategories, CATEGORY_FLAGS, isManagedCategoryName };
