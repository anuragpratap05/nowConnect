const { Queue } = require("bullmq");
const { createRedisConnection } = require("./connection");

const PAYMENT_QUEUE_NAME = "payment";

// Payment-webhook processing queue. The webhook route verifies the signature,
// enqueues the work, and acks 200 immediately — so a burst of webhook calls
// (e.g. a promo causing many payments to complete in a short window) can never
// make Razorpay's delivery back up or time out. The DB writes (payment status +
// user upgrade) happen in src/workers/paymentWorker.js.
const paymentQueue = new Queue(PAYMENT_QUEUE_NAME, {
  connection: createRedisConnection(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

// Idempotency guard #1: use the Razorpay event id as the BullMQ jobId, so a
// redelivered webhook (Razorpay retries) is de-duplicated by the queue itself —
// adding a job with an existing id is a no-op. (The worker applies an idempotent
// end-state as guard #2, in case a job was already evicted from history.)
// data: { event, paymentEntity }
const addPaymentJob = (eventId, data) =>
  paymentQueue.add("process-webhook", data, { jobId: eventId });

module.exports = { paymentQueue, addPaymentJob, PAYMENT_QUEUE_NAME };
