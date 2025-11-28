const cron = require("node-cron");
const Period = require('../models/periods');
const PublishedTemplate = require('../models/publishedTemplates');
const PublishedReport = require('../models/publishedReports');
const PublishedProducerReport = require('../models/publishedProducerReports');
const Template = require('../models/templates');
const Report = require('../models/reports');
const ProducerReport = require('../models/producerReports');
const UserService = require('../services/users');
const DependencyService = require('../services/dependency');
const Validator = require('../models/validators');
const User = require('../models/users');
const Dependency = require('../models/dependencies');

const periodController = {};


// ✅ Backend: Nuevo endpoint en controllers/periods.js
periodController.getPeriodById = async (req, res) => {
  try {
    const { id } = req.params;
    const period = await Period.findById(id, 'producer_report_start_date producer_report_end_date responsible_start_date responsible_end_date');

    if (!period) {
      return res.status(404).json({ message: 'Period not found' });
    }

    res.status(200).json(period);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};

periodController.getPeriods = async (req, res) => {
  try {
    const email = req.query.email;
    await UserService.findUserByEmailAndRole(email, "Administrador");
    const periods = await Period.find();
    res.status(200).json(periods);
  } catch (error) {
    console.error(error);
    res.status(500).json({ status: "Error getting periods", error: error.message });
  }
}

periodController.getPeriodsPagination = async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    try {
        const query = {};

        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } }
            ];

            if (search.toLowerCase() === 'activo' || search.toLowerCase() === 'inactivo') {
                query.$or.push({ is_active: search.toLowerCase() === 'activo' });
            }
        }

        const periods = await Period.find(query).skip(skip).limit(limit);
        const total = await Period.countDocuments(query);

        res.status(200).json({
            periods,
            total,
            page,
            pages: Math.ceil(total / limit)
        });
    } catch (error) {
        console.error('Error fetching periods:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

periodController.getPeriod = async (req, res) => {
    const start_date = req.body.start_date;
    const period = await Period.findOne({ start_date });
    res.status(200).json(period);
}

periodController.createPeriod = async (req, res) => {
    const period = new Period(req.body);
    const [usersData, dependenciesData, validators] = await Promise.all([
      UserService.giveUsersToKeepAndDelete(),
      DependencyService.giveDependenciesToKeep(),
      Validator.find()
    ]);

    const { usersToKeep, usersToDelete } = usersData;
    
    const dependencies = dependenciesData;
    const emailsToDelete = usersToDelete;

    dependencies.forEach(dependency => {
      if (emailsToDelete) {
        dependency.members = dependency.members.filter(member => !emailsToDelete.includes(member.email));
      }
    });

    period.screenshot.users = usersToKeep;
    period.screenshot.dependencies = dependencies;
    period.screenshot.validators = validators;
    period.screenshot_date = new Date();

    //TODO: Implementar lógica para cargar estudiantes

    await period.save();
    res.status(200).json({ status: "Period created" });
}

periodController.updateScreenshotsJob = async () => {
  const currentDate = new Date();

  try {
    const periods = await Period.find({ producer_end_date: { $gt: currentDate } });

    for (const period of periods) {
      const users = await User.find({ isActive: true });
      const dependencies = await Dependency.find();
      const validators = await Validator.find();

      period.screenshot.users = users;
      period.screenshot.dependencies = dependencies;
      period.screenshot.validators = validators;
      period.screenshot_date = currentDate;

      await period.save();
      console.log(`Screenshot updated for period ${period._id}`);
    }
  } catch (error) {
    console.error("Error updating screenshots:", error);
  }
};

// Ejecutar cada 12 horas
// Esto lo hará a las 00:00 y a las 12:00
cron.schedule("0 0,12 * * *", () => {
  console.log("Ejecutando tarea programada de actualización de screenshots");
  periodController.updateScreenshotsJob();
});

periodController.updatePeriod = async (req, res) => {
    const { id } = req.params;
    try {
        const updatedPeriod = await Period.findByIdAndUpdate(id, req.body, { new: true });
        if (!updatedPeriod) {
            return res.status(404).json({ error: "Period not found" });
        }
        res.status(200).json(updatedPeriod);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

periodController.deletePeriod = async (req, res) => {
  const { id } = req.params;
  try {
      const deletedPeriod = await Period.findByIdAndDelete(id);
      if (!deletedPeriod) {
          return res.status(404).json({ error: "Period not found" });
      }
      res.status(200).json({ message: "Period deleted" });
  } catch (error) {
      res.status(500).json({ error: error.message });
  }
}

periodController.getActivePeriods = async (req, res) => {
    try {
        const periods = await Period.find({ is_active: true }).sort({ end_date: 1 });
        res.status(200).json(periods);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

periodController.feedDuplicateOptions = async (req, res) => {
  try {
    const { email, fromPeriod, toPeriod } = req.query;

    await UserService.findUserByEmailAndRole(email, "Administrador");

    const from = await Period.findById(fromPeriod);
    const to = await Period.findById(toPeriod);
    if (!from || !to) {
      throw new Error("Period not found");
    }

    let pTemplates = await PublishedTemplate.find({ period: fromPeriod }, 'template._id');
    pTemplates = pTemplates?.map(t => t.template._id);
    let pReports = await PublishedReport.find({ period: fromPeriod }, 'report._id');
    pReports = pReports.map(r => r.report._id);
    let pProducerReports = await PublishedProducerReport.find({ period: fromPeriod }, 'report._id');
    pProducerReports = pProducerReports?.map(r => r.report._id);

    const templates = await Template.find({ _id: { $in: pTemplates } }, '_id name');
    const reports = await Report.find({ _id: { $in: pReports } }, '_id name');
    const producerReports = await ProducerReport.find({ _id: { $in: pProducerReports } }, '_id name');

    res.status(200).json({ templates, reports, producerReports });
  } catch (error) {
    console.error('Error fetching duplicate options:', error);
    res.status(500).json({ message: error.message });
  }
}

periodController.getAllPeriods = async (req, res) => {
    try {
      const periods = await Period.find({}, { _id: 1, name: 1 }).sort({ name: 1 });
      res.status(200).json(periods);
    } catch (error) {
      console.error('Error fetching all periods:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
};

periodController.toggleActive = async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active } = req.body;
    
    const updatedPeriod = await Period.findByIdAndUpdate(
      id, 
      { is_active }, 
      { new: true }
    );
    
    if (!updatedPeriod) {
      return res.status(404).json({ error: 'Period not found' });
    }
    
    res.json({ success: true, period: updatedPeriod });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


module.exports = periodController;
