const { Worker } = require("bullmq");
const { createRedisConnection } = require("../queues/connection");
const { EMAIL_QUEUE_NAME } = require("../queues/emailQueue");
const sendEmail = require("../utils/sendEmail");

// Consumes email jobs and performs the actual SES send. Runs in the separate
// `npm run worker` process (see src/workers/index.js), never in the API/cron
// process — so email latency and failures are fully isolated from request
// handling.
const emailWorker = new Worker(
  EMAIL_QUEUE_NAME,
  async (job) => {
    const { subject, body, toEmailId } = job.data;
    if (!toEmailId) {
      // Non-retryable: a job with no recipient can never succeed.
      throw new Error("email job missing toEmailId");
    }
    return await sendEmail.run(subject, body, toEmailId);
  },
  { connection: createRedisConnection(), concurrency: 5 }
);

emailWorker.on("completed", (job) => {
  console.log(`[emailWorker] job ${job.id} -> ${job.data.toEmailId} completed`);
});

// Log failed jobs (this is the "email provider is down" answer: the job stays in
// the failed set for inspection/retry rather than silently vanishing).
emailWorker.on("failed", (job, err) => {
  console.error(
    `[emailWorker] job ${job?.id} -> ${job?.data?.toEmailId} failed ` +
      `(attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${err.message}`
  );
});

module.exports = emailWorker;
