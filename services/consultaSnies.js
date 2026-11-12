const PublishedTemplate = require("../models/publishedTemplates");
const Dependency = require("../models/dependencies");
const { forEachSheetRow } = require("./historicoStorage");

// Carga de Plantillas en Consulta de Información que corresponde a una
// plantilla SNIES publicada: la información del archivo queda directamente
// como el envío final de esa plantilla, sin que el productor encargado tenga
// que hacerlo (es el camino inverso de saveToConsultaInformacion).

// Una coincidencia de encabezados por debajo de esto no se considera la misma
// plantilla, salvo que el nombre del archivo sea el de la plantilla.
const MIN_HEADER_RATIO = 0.8;

const compact = (value = "") =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

// "Evento_cultural (4).xlsx" → "Evento_cultural" (el sufijo lo pone el
// navegador al descargar varias veces el mismo archivo)
const baseFileName = (fileName = "") =>
  String(fileName).replace(/\.(xlsx|xlsm|csv)$/i, "").replace(/\s*\(\d+\)\s*$/, "");

const idOf = (value) => String(value?._id || value);

// Las plantillas SNIES de varias hojas guardan su información con sheet_name
// aunque template.fields también traiga todos los campos juntos; por eso las
// hojas del libro van primero. Las hojas sin campos (INFO) no cuentan.
const templateSheetsOf = (template = {}) => {
  const workbookSheets = (template.workbook_sheets || [])
    .filter((sheet) => sheet?.name && sheet.fields?.length)
    .map((sheet) => ({ sheetName: sheet.name, fields: sheet.fields }));
  if (workbookSheets.length) return workbookSheets;
  return template.fields?.length ? [{ sheetName: null, fields: template.fields }] : [];
};

// Los Excel descargados de Miró traen una hoja INFO con "Nombre de la Plantilla"
const templateNameFromInfo = (sheets = []) => {
  const info = sheets.find((sheet) => compact(sheet.name) === "info");
  for (const row of info?.headerOptions || []) {
    if (compact(row[0]) === "nombredelaplantilla" && row[1]) return row[1];
  }
  return "";
};

// Empareja las hojas del archivo con las hojas de la plantilla. Cada hoja del
// archivo trae una o varias filas candidatas a encabezado (headerOptions).
const matchTemplate = (template, uploadedSheets) => {
  const templateSheets = templateSheetsOf(template);
  const used = new Set();
  const matches = [];

  templateSheets.forEach(({ sheetName, fields }) => {
    const byKey = new Map(fields.filter((field) => field?.name).map((field) => [compact(field.name), field]));
    let best = null;

    uploadedSheets.forEach((sheet, uploadedIndex) => {
      if (used.has(uploadedIndex)) return;
      const nameMatch = Boolean(sheetName) && compact(sheet.name) === compact(sheetName);

      (sheet.headerOptions || []).forEach((headers) => {
        const fieldMap = [];
        const seen = new Set();
        headers.forEach((header, index) => {
          const field = byKey.get(compact(header));
          if (field && !seen.has(field.name)) {
            seen.add(field.name);
            fieldMap.push({ index, field });
          }
        });
        if (!fieldMap.length) return;

        const score = (nameMatch ? 1000 : 0) + fieldMap.length;
        if (best && score <= best.score) return;
        best = {
          score,
          uploadedIndex,
          uploadedName: sheet.name,
          sheetName,
          fields,
          fieldMap,
          missing: fields.filter((field) => field?.name && !seen.has(field.name)).map((field) => field.name),
          depIndex: byKey.has("dependencia") ? -1 : headers.findIndex((header) => compact(header) === "dependencia"),
        };
      });
    });

    if (best) {
      used.add(best.uploadedIndex);
      matches.push(best);
    }
  });

  const matched = matches.reduce((sum, match) => sum + match.fieldMap.length, 0);
  const total = templateSheets.reduce((sum, sheet) => sum + sheet.fields.length, 0);
  return { matches, matched, total, ratio: total ? matched / total : 0 };
};

const responsibleIdsOf = (pubTem) => {
  const raw = pubTem.responsible_producers?.length > 0
    ? pubTem.responsible_producers
    : pubTem.template?.responsible_producers;
  return (raw || []).map(idOf);
};

const qrAuthorizedIdsOf = (pubTem) => {
  const raw = pubTem.qr_authorized_producers?.length > 0
    ? pubTem.qr_authorized_producers
    : pubTem.template?.qr_authorized_producers;
  return (raw || []).map(idOf);
};

// Busca, en el período de la carga, la plantilla SNIES publicada a la que
// corresponde el archivo (por nombre de archivo o por encabezados).
// Sin período (el selector aún no había cargado) se busca en todos y, ante
// empate, gana la publicación más reciente.
const findSniesMatch = async ({ periodId, fileName, sheets }) => {
  const query = { "template.is_snies": true, ...(periodId ? { period: periodId } : {}) };
  const published = await PublishedTemplate.find(query)
    .select("name period template final_submitted final_submitted_date responsible_producers loaded_data.dependency")
    .sort({ createdAt: -1 })
    .populate("period", "name")
    .lean();

  const nameKeys = [compact(baseFileName(fileName)), compact(templateNameFromInfo(sheets))].filter(Boolean);
  let best = null;

  published.forEach((pubTem) => {
    const nameMatch = nameKeys.includes(compact(pubTem.name));
    const result = matchTemplate(pubTem.template, sheets);
    const valid = result.matched > 0 && (nameMatch || result.ratio >= MIN_HEADER_RATIO);
    if (!valid) return;
    const rank = (nameMatch ? 10 : 0) + result.ratio;
    if (!best || rank > best.rank) best = { rank, pubTem, result, nameMatch };
  });

  if (!best) return null;

  const { pubTem, result } = best;
  const encargados = await Dependency.find({ _id: { $in: responsibleIdsOf(pubTem) } }).select("name").lean();

  return {
    pubTemId: String(pubTem._id),
    name: pubTem.name,
    period: pubTem.period?.name || "",
    finalSubmitted: Boolean(pubTem.final_submitted),
    finalSubmittedDate: pubTem.final_submitted_date || null,
    dependenciasConDatos: (pubTem.loaded_data || []).length,
    encargados: encargados.map((dep) => dep.name),
    hojas: result.matches.map((match) => ({
      hoja: match.uploadedName,
      hojaPlantilla: match.sheetName,
      columnas: match.fieldMap.length,
      faltantes: match.missing.slice(0, 15),
      porDependencia: match.depIndex >= 0,
    })),
  };
};

const toFieldValue = (raw, field) => {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (field.multiple && text.includes(",")) return text.split(",").map((value) => value.trim()).filter(Boolean);
  return text;
};

// Dependencia a la que quedan las filas sin columna "Dependencia" reconocible:
// el productor encargado; si no hay, el primer productor; si no, quien carga.
const defaultDependencyOf = async (pubTem, user) => {
  const candidates = [...responsibleIdsOf(pubTem), ...(pubTem.template?.producers || []).map(idOf)];
  for (const id of candidates) {
    const dep = await Dependency.findById(id).select("dep_code").lean().catch(() => null);
    if (dep?.dep_code) return dep.dep_code;
  }
  return user.dep_code || "";
};

// Reemplaza la información de la plantilla SNIES con la del archivo ya
// procesado (filas guardadas por bloques) y la deja como enviada al SNIES.
// La información anterior queda respaldada en consulta_replaced_data.
const applyToSnies = async (registro, pubTemId, user) => {
  const pubTem = await PublishedTemplate.findById(pubTemId);
  if (!pubTem) throw new Error("La plantilla SNIES publicada ya no existe.");
  if (!pubTem.template?.is_snies) throw new Error("La plantilla seleccionada no es de SNIES.");

  const sheets = (registro.sheets || []).map((sheet) => ({ name: sheet.name, headerOptions: [sheet.headers || []] }));
  const { matches } = matchTemplate(pubTem.template, sheets);
  if (!matches.length) throw new Error("Las columnas del archivo no coinciden con los campos de la plantilla SNIES.");

  const dependencies = await Dependency.find({}).select("dep_code name").lean();
  const depByKey = new Map();
  dependencies.forEach((dep) => {
    depByKey.set(compact(dep.name), dep.dep_code);
    depByKey.set(compact(dep.dep_code), dep.dep_code);
  });
  const defaultDep = await defaultDependencyOf(pubTem, user);
  if (!defaultDep) throw new Error("No se pudo determinar la dependencia encargada de la plantilla SNIES.");

  // dependencia → (hoja|campo) → { sheet_name, field_name, values }
  const byDependency = new Map();
  const rowsBySheetAndDep = new Map();
  let totalFilas = 0;

  for (const match of matches) {
    const keyOf = (field) => `${match.sheetName || ""}|${field.name}`;
    await forEachSheetRow(registro, match.uploadedIndex, (row) => {
      const values = Array.isArray(row) ? row : match.fieldMap.map(() => "");
      const depRaw = match.depIndex >= 0 ? values[match.depIndex] : "";
      const dep = (depRaw && depByKey.get(compact(depRaw))) || defaultDep;

      if (!byDependency.has(dep)) byDependency.set(dep, new Map());
      const fields = byDependency.get(dep);
      match.fieldMap.forEach(({ index, field }) => {
        const key = keyOf(field);
        if (!fields.has(key)) {
          fields.set(key, { ...(match.sheetName ? { sheet_name: match.sheetName } : {}), field_name: field.name, values: [] });
        }
        fields.get(key).values.push(toFieldValue(values[index], field));
      });

      const countKey = `${match.sheetName || ""}|${dep}`;
      rowsBySheetAndDep.set(countKey, (rowsBySheetAndDep.get(countKey) || 0) + 1);
      totalFilas += 1;
    });

    // Los campos de la plantilla que el archivo no trae van vacíos, para que
    // todas las columnas tengan el mismo número de filas.
    byDependency.forEach((fields, dep) => {
      const count = rowsBySheetAndDep.get(`${match.sheetName || ""}|${dep}`) || 0;
      if (!count) return;
      match.missing.forEach((fieldName) => {
        const key = `${match.sheetName || ""}|${fieldName}`;
        if (!fields.has(key)) {
          fields.set(key, { ...(match.sheetName ? { sheet_name: match.sheetName } : {}), field_name: fieldName, values: Array(count).fill(null) });
        }
      });
    });
  }

  if (!totalFilas) throw new Error("El archivo no tiene filas con información para la plantilla SNIES.");

  const now = new Date();
  const sendBy = { email: user.email, full_name: user.full_name || user.name || user.email, dep_code: user.dep_code };

  pubTem.consulta_replaced_data = {
    date: now,
    by: user.email,
    final_submitted: pubTem.final_submitted,
    final_submitted_by: pubTem.final_submitted_by || null,
    final_submitted_date: pubTem.final_submitted_date || null,
    loaded_data: (pubTem.loaded_data || []).map((entry) => entry.toObject?.() || entry),
    qr_draft_data: (pubTem.qr_draft_data || []).map((entry) => entry.toObject?.() || entry),
    dependency_final_submissions: pubTem.dependency_final_submissions || [],
  };
  pubTem.loaded_data = [...byDependency.entries()].map(([dependency, fields]) => ({
    dependency,
    send_by: sendBy,
    loaded_date: now,
    filled_data: [...fields.values()],
    source: "excel",
    sender_email: user.email,
    sender_name: sendBy.full_name,
  }));
  // Los borradores QR se sumarían a la información del archivo en SNIES
  pubTem.qr_draft_data = [];

  pubTem.final_submitted = true;
  pubTem.final_submitted_by = sendBy;
  pubTem.final_submitted_date = now;
  // Plantillas con envío final por dependencia: todas quedan enviadas
  if (responsibleIdsOf(pubTem).length === 0 && qrAuthorizedIdsOf(pubTem).length > 0) {
    pubTem.dependency_final_submissions = pubTem.loaded_data.map((entry) => ({
      dependency: entry.dependency,
      submitted_by: sendBy,
      submitted_date: now,
    }));
  }
  pubTem.loaded_from_consulta = {
    historico_id: registro._id,
    file_name: registro.file_name,
    date: now,
    by: user.email,
  };
  pubTem.markModified("loaded_data");
  pubTem.markModified("qr_draft_data");
  await pubTem.save();

  return {
    pubTemId: String(pubTem._id),
    name: pubTem.name,
    filas: totalFilas,
    dependencias: byDependency.size,
  };
};

module.exports = {
  findSniesMatch,
  matchTemplate,
  applyToSnies,
};
