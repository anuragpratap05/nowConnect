const { Worker } = require("bullmq");
const { createRedisConnection } = require("../queues/connection");
const { PAYMENT_QUEUE_NAME } = require("../queues/paymentQueue");
const Payment = require("../models/payment");
const User = require("../models/user");

// Consumes payment-webhook jobs and applies the DB side effects the webhook
// route deliberately no longer does inline. Written to be idempotent: it applies
// a desired END-STATE rather than a blind transition, so re-running the same job
// (a Razorpay redelivery that slipped past the jobId de-dup) is harmless.
const paymentWorker = new Worker(
  PAYMENT_QUEUE_NAME,
  async (job) => {
    const { event, paymentEntity } = job.data;

    // Guard: the payment record must exist (the old inline code assumed it did
    // and would 500 on a null).
    const payment = await Payment.findOne({ orderId: paymentEntity.order_id });
    if (!payment) {
      throw new Error(`no payment record for order ${paymentEntity.order_id}`);
    }

    payment.status = paymentEntity.status;
    if (paymentEntity.id) payment.paymentId = paymentEntity.id;
    await payment.save();

    // Only a successful capture upgrades the user. The old code set
    // isPremium = true on ANY event, including payment.failed.
    if (event === "payment.captured") {
      const user = await User.findById(payment.userId);
      if (user) {
        // Idempotent: setting these again on a redelivery is a no-op.
        user.isPremium = true;
        user.membershipType = payment.notes?.membershipType;
        await user.save();
      }
    }

    return { event, orderId: paymentEntity.order_id, status: payment.status };
  },
  { connection: createRedisConnection(), concurrency: 5 }
);

paymentWorker.on("completed", (job, result) => {
  console.log(
    `[paymentWorker] job ${job.id} (${result?.event}) -> ` +
      `order ${result?.orderId} status ${result?.status}`
  );
});

paymentWorker.on("failed", (job, err) => {
  console.error(
    `[paymentWorker] job ${job?.id} failed ` +
      `(attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${err.message}`
  );
});

module.exports = paymentWorker;
