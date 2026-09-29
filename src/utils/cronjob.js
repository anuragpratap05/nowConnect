const cron = require("node-cron");
const { subDays, startOfDay, endOfDay } = require("date-fns");
const ConnectionRequestModel = require("../models/connectionRequest");
const User = require("../models/user");
const { addEmailJob } = require("../queues/emailQueue");

// This job runs at 8 AM every day and notifies everyone who received a
// connection request the previous day.
//
// Phase 1 rewrite (see docs/phase-1.md):
//  - The old query did `.find({status, createdAt}).populate("fromUserId toUserId")`,
//    which was a full COLLSCAN on the fastest-growing collection AND fetched +
//    populated both sides of every request just to read one email address
//    (fromUserId was populated but never used).
//  - Now: `distinct("toUserId", ...)` — a COVERED DISTINCT_SCAN against the new
//    partial index (see src/models/connectionRequest.js), returning just the ids
//    with zero document fetches — followed by a single projected User.find.
//  - The side effect (sending email) is no longer done here: we enqueue one job
//    per recipient and return, so a slow mail provider can never stall the cron.
cron.schedule("0 8 * * *", async () => {
  try {
    const yesterday = subDays(new Date(), 1);
    const yesterdayStart = startOfDay(yesterday);
    const yesterdayEnd = endOfDay(yesterday);

    // Covered query: reads index keys only, no documents examined.
    const recipientIds = await ConnectionRequestModel.distinct("toUserId", {
      status: "interested",
      createdAt: { $gte: yesterdayStart, $lt: yesterdayEnd },
    });

    if (recipientIds.length === 0) return;

    // One round-trip, projected to just the email address we need.
    const recipients = await User.find(
      { _id: { $in: recipientIds } },
      { emailId: 1 }
    );

    for (const user of recipients) {
      if (!user.emailId) continue;
      await addEmailJob({
        subject: "New connection requests pending for " + user.emailId,
        body: "You have connection requests waiting. Log in to Now Connect to accept or reject them.",
        toEmailId: user.emailId,
      });
    }

    console.log(
      `[cron] enqueued ${recipients.length} pending-request notification(s)`
    );
  } catch (err) {
    console.error("[cron] failed to enqueue notifications:", err);
  }
});
