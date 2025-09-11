const express = require('express');
const morgan = require('morgan');
const cors = require('cors');
const initDB = require('./config/db');
const swaggerRouter = require('./swagger');
const app = express();
const cron = require('node-cron');

require('dotenv').config();

const allowedOrigins = [
  'http://localhost:3000', 
  'https://miro.unibague.edu.co',
  'https://mirodev.unibague.edu.co'
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
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ limit: '500mb', extended: false }));
app.use(morgan('dev'));

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
apiRouter.use("/pReports", require('./routes/publishedReports'));
apiRouter.use("/producerReports", require('./routes/producerReports'));
apiRouter.use("/pProducerReports", require('./routes/publishedProducerReports'));
apiRouter.use("/logs", require('./routes/logs'));
apiRouter.use("/homeInfo", require('./routes/homeInfo'));
apiRouter.use("/pending-user-changes", require('./routes/pendingUserChanges'));
apiRouter.use("/user-dependencies", require('./routes/userDependencies'));
apiRouter.use("/audit", require('./routes/auditLogs'));

if (process.env.NODE_ENV === 'production') {
  app.use('/api/p', apiRouter);
} else {
  app.use('/api/d', apiRouter);
}


// Añadir Swagger UI en la ruta /api-docs
app.use('/', swaggerRouter);

const PORT = process.env.PORT || 6000;

app.listen(PORT, () => {
  if (process.env.NODE_ENV === 'production') {
    console.log('Server running in production mode on ' + PORT);
  } else {
    console.log('Server running in development mode on ' + PORT);
  }
});

initDB();

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
