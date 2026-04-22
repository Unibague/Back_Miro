const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const path = require('path');
const connectDB = require('./config/db');
const swaggerRouter = require('./swagger');
const app = express();
const cron = require('node-cron');

require('dotenv').config();

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://miro.unibague.edu.co',
  'https://mirodev.unibague.edu.co',
];

// Configurar Express para entender que está detrás de un proxy inverso
app.set('trust proxy', true); 

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  credentials: true
}));

app.use(express.json({ limit: '500mb', charset: 'utf-8' }));
app.use(express.urlencoded({ limit: '500mb', extended: false, charset: 'utf-8' }));
app.use(morgan('dev'));

// Servir archivos estáticos de uploads (evidencias PDI, etc.)
app.use('/uploads', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, 'uploads')));

// Configurar charset UTF-8 para todas las respuestas
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
      next();
    } else {
      res.redirect(`https://${req.headers.host}${req.url}`);
    }
  });
}

const apiRouter = express.Router();

apiRouter.use("/reminders", require('./routes/reminders'));
apiRouter.use("/categories", require('./routes/categories'));
apiRouter.use("/users", require('./routes/users'));
apiRouter.use("/students", require('./routes/students'));
apiRouter.use("/dimensions", require('./routes/dimensions'));
apiRouter.use("/dependencies", require('./routes/dependencies'));
apiRouter.use("/periods", require('./routes/periods'));
apiRouter.use("/templates", require('./routes/templates'));
apiRouter.use("/pTemplates", require('./routes/publishedTemplates'));
apiRouter.use("/validators", require('./routes/validators'));
apiRouter.use("/reports", require('./routes/reports'));
apiRouter.use("/ambitReports", require('./routes/ambitReports'));
apiRouter.use("/pReports", require('./routes/publishedReports'));
apiRouter.use("/producerReports", require('./routes/producerReports'));
apiRouter.use("/pProducerReports", require('./routes/publishedProducerReports'));
apiRouter.use("/logs", require('./routes/logs'));
apiRouter.use("/homeInfo", require('./routes/homeInfo'));
apiRouter.use("/pending-user-changes", require('./routes/pendingUserChanges'));
apiRouter.use("/user-dependencies", require('./routes/userDependencies'));
apiRouter.use("/audit", require('./routes/auditLogs'));
apiRouter.use("/template-filters", require('./routes/templateFilters'));
apiRouter.use("/pTemplates-filtered", require('./routes/publishedTemplatesFiltered'));
apiRouter.use("/programs",         require('./routes/programs'));
apiRouter.use("/processes",        require('./routes/processes'));
apiRouter.use("/phases",           require('./routes/phases'));
apiRouter.use("/process-documents", require('./routes/phaseDocuments'));
apiRouter.use("/process-history",  require('./routes/processHistory'));
apiRouter.use("/process-reminders", require('./routes/processReminders'));
apiRouter.use("/casos",            require('./routes/casos'));
apiRouter.use("/pqr",              require('./routes/pqr'));
apiRouter.use("/config-audit", require('./routes/configurationAudit'));
apiRouter.use("/ai-assistant", require('./routes/aiAssistant'));
apiRouter.use("/template-status", require('./routes/templateStatus'));
apiRouter.use("/snies/templates", require('./routes/sniesTemplates'));
apiRouter.use("/cna/templates", require('./routes/cnaTemplates'));
apiRouter.use("/pdi/macroproyectos",   require('./routes/pdiMacroproyecto'));
apiRouter.use("/pdi/proyectos",        require('./routes/pdiProyecto'));
apiRouter.use("/pdi/acciones",         require('./routes/pdiAccionEstrategica'));
apiRouter.use("/pdi/indicadores",      require('./routes/pdiIndicador'));
apiRouter.use("/pdi/historial",        require('./routes/pdiIndicadorHistorial'));
apiRouter.use("/pdi/cortes",           require('./routes/pdiCorte'));
apiRouter.use("/pdi/formularios",      require('./routes/pdiFormulario'));
apiRouter.use("/pdi/cambios",          require('./routes/pdiSolicitudCambio'));
apiRouter.use("/pdi/dashboard",        require('./routes/pdiDashboard'));
apiRouter.use("/pdi/config",           require('./routes/pdiConfig'));

// Ruta directa para jerarquía aoi
const dependencyController = require('./controllers/dependencies');
apiRouter.get("/hierarchy", dependencyController.getHierarchy);

if (process.env.NODE_ENV === 'production') {
  app.use('/api/p', apiRouter);
} else {
  app.use('/api/d', apiRouter);
}


// Añadir Swagger UI en la ruta /api-docs
app.use('/', swaggerRouter);

const PORT = process.env.PORT || 6000;

async function start() {
  try {
    await connectDB();
  } catch (err) {
    console.error('No se pudo iniciar el API sin MongoDB:', err.message || err);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    if (process.env.NODE_ENV === 'production') {
      console.log('Servr running in production mode on ' + PORT);
    } else {
      console.log('Server running in development mode on ' + PORT);
    }
  });

  server.timeout = 240000;
  server.keepAliveTimeout = 240000;
  server.headersTimeout = 245000;
}

start();

// const { runReminderEmails } = require('./controllers/reminders');
// cron.schedule('0 7 * * *', async () => {
//   console.log(" Ejecutando envío automático de recordatorios...");
//   try {
//     await runReminderEmails(); 
//     console.log(" Correos enviados correctamente");
//   } catch (err) {
//     console.error(" Error al enviar recordatorios:", err);
//   }
// });
//prueba
