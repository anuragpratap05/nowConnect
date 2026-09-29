const { Queue } = require("bullmq");
const { createRedisConnection } = require("./connection");

const EMAIL_QUEUE_NAME = "email";

// Async email queue. Producers (the daily cron, and any future feature that
// needs to notify a user) just enqueue and return; the worker in
// src/workers/emailWorker.js does the actual SES call off the request/cron path,
// so a slow or down mail provider can never block the caller.
const emailQueue = new Queue(EMAIL_QUEUE_NAME, {
  connection: createRedisConnection(),
  defaultJobOptions: {
    // "What happens when the email provider is down": retry with exponential
    // backoff (5s, 10s, 20s, 40s, 80s) instead of losing the notification.
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 1000 }, // cap completed history
    removeOnFail: { count: 5000 }, // keep failures around as a poor-man's DLQ
  },
});

// One job per recipient. data: { subject, body, toEmailId }
const addEmailJob = (data) => emailQueue.add("send-email", data);

module.exports = { emailQueue, addEmailJob, EMAIL_QUEUE_NAME };
