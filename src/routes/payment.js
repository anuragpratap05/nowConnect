const express = require("express");
const { userAuth } = require("../middlewares/auth");
const paymentRouter = express.Router();
const razorpayInstance = require("../utils/razorpay");
const Payment = require("../models/payment");
const { membershipAmount } = require("../utils/constants");
const {
  validateWebhookSignature,
} = require("razorpay/dist/utils/razorpay-utils");
const { addPaymentJob } = require("../queues/paymentQueue");

paymentRouter.post("/payment/create", userAuth, async (req, res) => {
  try {
    const { membershipType } = req.body;
    const { firstName, lastName, emailId } = req.user;

    const order = await razorpayInstance.orders.create({
      amount: membershipAmount[membershipType] * 100,
      currency: "INR",
      receipt: "receipt#1",
      notes: {
        firstName,
        lastName,
        emailId,
        membershipType: membershipType,
      },
    });

    // Save it in my database
    console.log(order);

    const payment = new Payment({
      userId: req.user._id,
      orderId: order.id,
      status: order.status,
      amount: order.amount,
      currency: order.currency,
      receipt: order.receipt,
      notes: order.notes,
    });

    const savedPayment = await payment.save();

    // Return back my order details to frontend
    res.json({ ...savedPayment.toJSON(), keyId: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});

paymentRouter.post("/payment/webhook", async (req, res) => {
  try {
    const webhookSignature = req.get("X-Razorpay-Signature");

    const isWebhookValid = validateWebhookSignature(
      JSON.stringify(req.body),
      webhookSignature,
      process.env.RAZORPAY_WEBHOOK_SECRET
    );

    if (!isWebhookValid) {
      return res.status(400).json({ msg: "Webhook signature is invalid" });
    }

    // Razorpay sends a unique id per event; used as the queue jobId so a
    // redelivered webhook is de-duplicated by the queue (idempotency).
    const eventId = req.get("X-Razorpay-Event-Id");
    const event = req.body.event;
    const paymentEntity = req.body?.payload?.payment?.entity;

    if (!paymentEntity?.order_id) {
      // Not a payment event we handle (e.g. a refund/subscription event). Ack so
      // Razorpay stops retrying, but do nothing.
      return res.status(200).json({ msg: "Ignored: not a payment event" });
    }

    // Once the signature is verified, ACK IMMEDIATELY and do the DB work off the
    // request path (src/workers/paymentWorker.js). This is what lets us absorb a
    // burst of webhook calls without Razorpay's delivery backing up. The DB
    // update (payment status + user upgrade) and event-type branching all happen
    // in the worker; here we only enqueue.
    await addPaymentJob(eventId, { event, paymentEntity });

    return res.status(200).json({ msg: "Webhook received" });
  } catch (err) {
    return res.status(500).json({ msg: err.message });
  }
});

paymentRouter.get("/premium/verify", userAuth, async (req, res) => {
  const user = req.user.toJSON();
  console.log(user);
  if (user.isPremium) {
    return res.json({ ...user });
  }
  return res.json({ ...user });
});

module.exports = paymentRouter;
