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

    // Phase 2 concurrency fix: the canonicalised (direction-independent) pair.
    // fromUserId/toUserId carry *who swiped on whom* and so cannot be uniquely
    // indexed directly — (A→B) and (B→A) are different documents to the index
    // but the same relationship to the app. These two fields hold the same two
    // ids sorted, so both directions produce one identical key, which a unique
    // index can then reject. Derived in the pre-validate hook below; never set
    // by callers.
    userIdLow: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    userIdHigh: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
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

// Phase 2 concurrency fix: make the database — not application code — the
// authority on "one connection request per pair, in either direction".
//
// src/routes/request.js used to findOne() for an existing request and then
// save() a new one. Two concurrent swipes on the same pair (a double-click, or
// both users swiping on each other in the same instant) can both complete the
// findOne before either save lands, so both pass the check and both insert. It
// never reproduces in sequential manual testing, which is exactly why it
// survived to here.
//
// partialFilterExpression on $exists is what makes this index safe to add to a
// collection that already has rows: documents written before this change have
// neither pair field, and a plain unique index would read all of them as
// (null, null) — colliding with each other, so the build would fail outright.
// Restricting the index to documents that have the fields lets it build
// immediately and start enforcing on new writes; src/scripts/backfillRequestPairs.js
// backfills the legacy rows into it.
connectionRequestSchema.index(
  { userIdLow: 1, userIdHigh: 1 },
  {
    unique: true,
    partialFilterExpression: {
      userIdLow: { $exists: true },
      userIdHigh: { $exists: true },
    },
  }
);

// Phase 4: index the "my connections" access pattern — in BOTH directions.
//
// Found while building the posts feed, which needs "the ids of everyone I am
// accepted-connected to" on every feed page. That list comes from
// src/utils/connectionGraph.js, and the query behind it is the same $or that
// GET /user/connections has always run:
//
//     {$or: [{fromUserId: me, status: "accepted"},
//            {toUserId:   me, status: "accepted"}]}
//
// Before these two indexes, `.explain()` on that query returned
// SUBPLAN -> COLLSCAN with totalKeysExamined: 0 — a full scan of
// ConnectionRequest, the fastest-growing collection in the system. This is the
// SECOND independent collection scan found on this collection (Phase 1 fixed the
// 8am cron's), and this one is worse in one specific way: the cron ran once a day
// off the request path, while this runs on a user-facing route, synchronously,
// every time anyone opens their connections list.
//
// Why it scanned even though {fromUserId, toUserId} exists and could serve the
// first branch: MongoDB's $or subplanner needs an indexed plan for EVERY branch.
// If even one branch has no usable index it abandons index selection for the
// whole $or and scans once, which is cheaper than scanning once per branch. So a
// half-indexed $or performs exactly like an unindexed one — there is no partial
// credit. That is the non-obvious part, and it is why the fix has to be two
// indexes, not one.
//
// Key order {<pairField>, status, <otherPairField>} is chosen so the queries are
// COVERED. Both pair fields are equality predicates, `status` is equality too,
// and the trailing field is the only other one connectionGraph.js projects — so
// with {_id: 0} MongoDB answers entirely from index keys and never fetches a
// document (totalDocsExamined: 0). Same covered-query technique as the Phase 1
// cron fix, applied to a read path instead of a batch job.


// This also tightens GET /user/requests/received, which queries
// {toUserId: me, status: "interested"}. It was never a COLLSCAN — the Phase 1
// partial index {status, createdAt, toUserId} already served it — but createdAt
// sits between status and toUserId in that key order, so the walk had to pass
// over every OTHER user's interested requests before filtering by toUserId.
// Measured at 8,000 docs: keysExamined 89 -> 42, exactly equal to nReturned.
//
// It does NOT become a covered query, and can't: the route needs the
// ConnectionRequest's own _id (the Accept/Reject buttons send it straight to
// POST /request/review/:status/:requestId), and _id isn't part of this index.
// It also calls .populate("fromUserId", ...), a second round-trip to User
// regardless of whether this read is covered.

// Note on the {fromUserId, toUserId} index above: Phase 2 removed the only query
// that used it (the check-then-act findOne, replaced by the canonical-pair unique
// index), so it is now dead weight — it costs a write on every insert and serves
// no read. It is deliberately left in place rather than dropped in this phase:
// dropping an index is an irreversible-in-production operation that wants its own
// change and its own verification that nothing regressed, not a drive-by deletion
// inside a feature branch.
connectionRequestSchema.index({ fromUserId: 1, status: 1, toUserId: 1 });
connectionRequestSchema.index({ toUserId: 1, status: 1, fromUserId: 1 });

// Derive the canonical pair before validation, so the `required` rules above
// see the computed values. Sorting the two ids as hex strings is a stable total
// order, so (A,B) and (B,A) both yield low=A, high=B.
connectionRequestSchema.pre("validate", function (next) {
  const connectionRequest = this;

  if (connectionRequest.fromUserId && connectionRequest.toUserId) {
    const [low, high] = [
      connectionRequest.fromUserId,
      connectionRequest.toUserId,
    ].sort((a, b) => (a.toString() < b.toString() ? -1 : 1));

    connectionRequest.userIdLow = low;
    connectionRequest.userIdHigh = high;
  }

  next();
});

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
