const mongoose = require("mongoose");

const connectDB = async () => {
  // Never log the connection string — it carries credentials in any non-local environment.
  await mongoose.connect(process.env.DB_CONNECTION_SECRET);
};

module.exports = connectDB;
