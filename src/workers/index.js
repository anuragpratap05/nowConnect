require("dotenv").config();

const connectDB = require("../config/database");

// Single worker process entrypoint (`npm run worker`). All three workers run here
// for now — operationally "the worker" — but they are separate BullMQ queues, so
// each can be split into its own deployment later without a code change if one
// needs to scale independently of the others.
//
// Phase 4 note on why that separability is no longer hypothetical: the thumbnail
// worker is the first one that is CPU- and memory-bound rather than
// network-bound. Email and payment jobs are almost entirely waiting on someone
// else's API, so they cost a socket and nothing else; a thumbnail job holds a
// multi-megabyte image buffer and saturates libuv's threadpool while sharp
// decodes it. Running them together means a burst of uploads adds latency to
// email and payment jobs sharing the process. That is acceptable at this size and
// is the first thing to split when it stops being — and because the queues are
// already separate, splitting it is a deployment change, not a code change.
require("./emailWorker");
require("./paymentWorker");
require("./thumbnailWorker");

// The payment worker touches Mongo, and so does the thumbnail worker (it writes
// the generated key back onto the Post). Connecting once here covers all three.
connectDB()
  .then(() => {
    console.log(
      "[worker] DB connected; workers running: email, payment, thumbnail"
    );
  })
  .catch((err) => {
    console.error("[worker] DB connection failed:", err.message);
    process.exit(1);
  });

// Surface unexpected process-level errors instead of dying silently.
process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandledRejection:", reason);
});
