require("dotenv").config();

const connectDB = require("../config/database");

// Single worker process entrypoint (`npm run worker`). Both workers run here for
// now — operationally "the worker" — but they are separate BullMQ queues, so
// each can be split into its own deployment later without a code change if one
// (e.g. a notification-volume spike) needs to scale independently of the other.
require("./emailWorker");
require("./paymentWorker");

// The payment worker touches Mongo; the email worker only calls SES. Connecting
// once here covers both.
connectDB()
  .then(() => {
    console.log("[worker] DB connected; workers running: email, payment");
  })
  .catch((err) => {
    console.error("[worker] DB connection failed:", err.message);
    process.exit(1);
  });

// Surface unexpected process-level errors instead of dying silently.
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandledRejection:", reason);
});
