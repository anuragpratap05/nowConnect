const mongoose = require("mongoose");

const connectionRequestSchema = new mongoose.Schema(
  {
    fromUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    toUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    status: {
      type: String,
      required: true,
      enum: {
        values: ["ignored", "interested", "accepted", "rejected"],
        message: `{VALUE} is incorrect status type`,
      },
    },
  },
  { timestamps: true }
);

// ConnectionRequest.find({fromUserId: 273478465864786587, toUserId: 273478465864786587})

connectionRequestSchema.index({ fromUserId: 1, toUserId: 1 });

// Phase 1 incident fix: the daily 8am cron (src/utils/cronjob.js) queries this
// collection — the fastest-growing one in the whole system — by
// {status: "interested", createdAt: <yesterday>} and only ever needs the
// toUserId values. With only the {fromUserId, toUserId} index above, that query
// was a full COLLSCAN (silent: no error, just slow, DB CPU spiking at 8am).
//
// This partial index covers exactly that query:
//   - partialFilterExpression restricts it to status:"interested", so we don't
//     pay to index the ignored/accepted/rejected rows the cron never scans
//     (smaller index, less write amplification on every non-interested write).
//   - key order {status, createdAt, toUserId}: status+createdAt satisfy the
//     predicate, and trailing toUserId makes the cron's DISTINCT_SCAN on
//     toUserId a COVERED query — it reads keys only, totalDocsExamined: 0.
connectionRequestSchema.index(
  { status: 1, createdAt: 1, toUserId: 1 },
  { partialFilterExpression: { status: "interested" } }
);

connectionRequestSchema.pre("save", function (next) {
  const connectionRequest = this;
  // Check if the fromUserId is same as toUserId
  if (connectionRequest.fromUserId.equals(connectionRequest.toUserId)) {
    throw new Error("Cannot send connection request to yourself!");
  }
  next();
});

const ConnectionRequestModel = new mongoose.model(
  "ConnectionRequest",
  connectionRequestSchema
);

module.exports = ConnectionRequestModel;
