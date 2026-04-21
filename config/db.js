require("dotenv").config();
const mongoose = require("mongoose");

const DB_URI = process.env.DB_URI;

/**
 * Conecta a MongoDB y resuelve cuando la conexión está lista.
 * Evita 500 intermitentes justo al reiniciar el API (peticiones antes de que exista conexión).
 */
async function connectDB() {
  if (!DB_URI) {
    const msg = "MongoDB: falta DB_URI en .env";
    console.error(msg);
    throw new Error(msg);
  }
  await mongoose.connect(DB_URI);
  console.log("MongoDB: conectado.");
}

module.exports = connectDB;
