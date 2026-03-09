const PublishedTemplate = require('../models/publishedTemplates');
const User = require('../models/users');
const Dependency = require('../models/dependencies');
const xlsx = require('xlsx');

const templateStatusController = {};

const getTemplateSummary = (rows) => {
  const totalAssigned = rows.length;
  const totalSubmitted = rows.filter((row) => row.has_submitted).length;
  const totalPending = Math.max(totalAssigned - totalSubmitted, 0);
  const completionPercentage = totalAssigned === 0
    ? 0
    : Number(((totalSubmitted / totalAssigned) * 100).toFixed(2));
  const pendingPercentage = totalAssigned === 0
    ? 0
    : Number(((totalPending / totalAssigned) * 100).toFixed(2));

  return {
    total_assigned: totalAssigned,
    total_submitted: totalSubmitted,
    total_pending: totalPending,
    completion_percentage: completionPercentage,
    pending_percentage: pendingPercentage
  };
};

const buildTemplateSubmissionRows = async (template) => {
  const rows = [];
  const assignedDependencyIds = template.template?.producers || [];

  if (assignedDependencyIds.length === 0) {
    return {
      rows,
      summary: getTemplateSummary(rows)
    };
  }

  const dependencies = await Dependency.find({
    _id: { $in: assignedDependencyIds }
  }).select('dep_code name responsible visualizers members').lean();

  const loadedDepCodes = template.loaded_data?.map((data) => data.dependency) || [];
  const allDepCodes = [...new Set([...dependencies.map((dep) => dep.dep_code), ...loadedDepCodes])];

  const allDependencies = await Dependency.find({
    dep_code: { $in: allDepCodes }
  }).select('dep_code name').lean();

  const dependencyNameByCode = new Map(
    allDependencies.map((dep) => [dep.dep_code, dep.name])
  );

  if (template.loaded_data && template.loaded_data.length > 0) {
    for (const data of template.loaded_data) {
      rows.push({
        template_id: template._id,
        template_name: template.name,
        period: template.period?.name || 'N/A',
        deadline: template.deadline,
        user_name: data.send_by?.full_name || data.send_by?.name || 'N/A',
        user_email: data.send_by?.email || 'N/A',
        dependency: dependencyNameByCode.get(data.dependency) || data.dependency,
        has_submitted: true,
        submitted_date: data.loaded_date
      });
    }
  }

  const assignedDepCodes = dependencies.map((dep) => dep.dep_code);
  const submittedDepCodes = template.loaded_data?.map((data) => data.dependency) || [];
  const pendingDepCodes = assignedDepCodes.filter((code) => !submittedDepCodes.includes(code));

  for (const depCode of pendingDepCodes) {
    const dependencyName = dependencyNameByCode.get(depCode) || depCode;
    const fullDep = dependencies.find((dep) => dep.dep_code === depCode);

    if (!fullDep) {
      rows.push({
        template_id: template._id,
        template_name: template.name,
        period: template.period?.name || 'N/A',
        deadline: template.deadline,
        user_name: 'Dependencia no encontrada',
        user_email: 'N/A',
        dependency: dependencyName,
        has_submitted: false,
        submitted_date: null
      });
      continue;
    }

    const allowedEmails = new Set();

    if (fullDep.responsible) allowedEmails.add(fullDep.responsible);
    if (fullDep.visualizers) fullDep.visualizers.forEach((email) => allowedEmails.add(email));
    if (fullDep.members) fullDep.members.forEach((email) => allowedEmails.add(email));

    if (allowedEmails.size === 0) {
      rows.push({
        template_id: template._id,
        template_name: template.name,
        period: template.period?.name || 'N/A',
        deadline: template.deadline,
        user_name: 'Sin usuarios asignados',
        user_email: 'N/A',
        dependency: dependencyName,
        has_submitted: false,
        submitted_date: null
      });
      continue;
    }

    const users = await User.find({
      email: { $in: Array.from(allowedEmails) },
      isActive: true
    }).select('name full_name email').lean();

    if (users.length === 0) {
      rows.push({
        template_id: template._id,
        template_name: template.name,
        period: template.period?.name || 'N/A',
        deadline: template.deadline,
        user_name: 'Sin permiso en la Dependencia',
        user_email: 'N/A',
        dependency: dependencyName,
        has_submitted: false,
        submitted_date: null
      });
      continue;
    }

    for (const user of users) {
      rows.push({
        template_id: template._id,
        template_name: template.name,
        period: template.period?.name || 'N/A',
        deadline: template.deadline,
        user_name: user.full_name || user.name,
        user_email: user.email,
        dependency: dependencyName,
        has_submitted: false,
        submitted_date: null
      });
    }
  }

  return {
    rows,
    summary: getTemplateSummary(rows)
  };
};

// Obtener estado de plantillas: quien debe subir y si ya lo hizo
templateStatusController.getTemplateSubmissionStatus = async (req, res) => {
  try {
    const { periodId } = req.query;

    if (!periodId) {
      return res.status(400).json({ message: 'periodId is required' });
    }

    const publishedTemplates = await PublishedTemplate.find({ period: periodId })
      .populate('period', 'name producer_end_date')
      .lean();

    if (!publishedTemplates || publishedTemplates.length === 0) {
      return res.status(200).json([]);
    }

    const result = [];

    for (const template of publishedTemplates) {
      const { rows, summary } = await buildTemplateSubmissionRows(template);

      for (const row of rows) {
        result.push({
          ...row,
          ...summary
        });
      }
    }

    return res.status(200).json(result);
  } catch (error) {
    console.error('[TemplateStatus] Error:', error);
    return res.status(500).json({ message: 'Error getting template submission status', error: error.message });
  }
};

// Descargar reporte en Excel
templateStatusController.downloadTemplateSubmissionStatus = async (req, res) => {
  try {
    const { periodId } = req.query;
    const query = periodId ? { period: periodId } : {};

    const publishedTemplates = await PublishedTemplate.find(query)
      .populate('period', 'name producer_end_date')
      .lean();

    const data = [];

    for (const template of publishedTemplates) {
      const { rows, summary } = await buildTemplateSubmissionRows(template);

      for (const row of rows) {
        data.push({
          'Plantilla': row.template_name,
          'Periodo': row.period,
          'Fecha Limite': row.deadline ? new Date(row.deadline).toLocaleDateString('es-CO') : 'N/A',
          'Usuario': row.user_name,
          'Email': row.user_email,
          'Dependencia': row.dependency,
          'Estado': row.has_submitted ? 'Enviado' : 'Pendiente',
          'Fecha Envio': row.submitted_date ? new Date(row.submitted_date).toLocaleDateString('es-CO') : 'N/A',
          'Asignados': summary.total_assigned,
          'Enviados': summary.total_submitted,
          'Faltantes': summary.total_pending,
          '% Cumplimiento': summary.completion_percentage,
          '% Pendiente': summary.pending_percentage
        });
      }
    }

    const ws = xlsx.utils.json_to_sheet(data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Estado Plantillas');

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="estado-plantillas-${Date.now()}.xlsx"`);
    return res.send(buffer);
  } catch (error) {
    console.error('Error downloading template submission status:', error);
    return res.status(500).json({ message: 'Error downloading report', error: error.message });
  }
};

module.exports = templateStatusController;
