const mongoose = require("mongoose");

// Phase 3 — Chat is now conversation METADATA only.
//
// V1 (see git history) was:
//     { participants: [ObjectId], messages: [messageSchema] }
// and the embedded `messages` array is gone from this file. The reasoning for
// splitting it out lives in src/models/message.js; what's left here is the
// conversation identity plus the one denormalised field a conversation list
// needs (`lastMessageAt`).
//
// The embedded array is NOT declared as a deprecated field on the schema on
// purpose. Mongoose would then keep hydrating it on every read, and any code
// path that still called .save() on a Chat would write an empty array back over
// data the migration had not yet moved. Legacy documents are read exactly once,
// by src/scripts/migrateChatMessages.js, which goes through the raw driver
// collection instead of this model precisely so it can see a field the schema no
// longer knows about.

const chatSchema = new mongoose.Schema(
  {
    participants: [
      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    ],

    // Same canonicalised-pair trick Phase 2 introduced on ConnectionRequest, for
    // the same reason and against the same class of bug.
    //
    // Both the old GET /chat/:targetUserId route and the old socket sendMessage
    // handler did `findOne({participants: {$all: [a, b]}})` and then created a
    // Chat if none came back — check-then-act again. Two clients opening the same
    // conversation at the same instant (which is the NORMAL case: both users open
    // the chat when they match) both miss, both insert, and the pair now has two
    // Chat documents. From then on messages land in whichever one that request
    // happened to find, so the conversation silently splits in two and each user
    // sees half of it.
    //
    // `participants` can't be uniquely indexed to prevent that: it's an array, so
    // a unique index on it is a multikey index that constrains each individual
    // member to appear in one document only — it would let user A have exactly
    // one conversation in total. These two scalar fields hold the same ids sorted,
    // so the pair gets one stable key that a unique index can enforce.
    participantLow: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    participantHigh: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    // Denormalised from the newest Message, so "list my conversations, most
    // recent first" is one indexed read of this collection instead of an
    // aggregation over the whole Message collection. Deliberately allowed to be
    // stale: it is derived data, and src/scripts/migrateChatMessages.js can
    // recompute it from Message at any time. See src/utils/socket.js for why the
    // write that maintains it is not in a transaction with the message insert.
    lastMessageAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

// Phase 3: one conversation per pair, enforced by the database.
//
// Partial on $exists for the same rollout reason as the Phase 2 index: documents
// written before this change have neither pair field, and a plain unique index
// would read all of them as (null, null), collide them against each other, and
// fail to build at all. Restricting the index to documents that HAVE the fields
// means it builds immediately and enforces on every new write, while
// src/scripts/migrateChatMessages.js brings the legacy rows in.
chatSchema.index(
  { participantLow: 1, participantHigh: 1 },
  {
    unique: true,
    partialFilterExpression: {
      participantLow: { $exists: true },
      participantHigh: { $exists: true },
    },
  }
);

// "My conversations, newest activity first." Not used by a route yet — it is the
// index that makes lastMessageAt worth storing, and it's cheap to declare now
// while the collection is small rather than as an index build later.
chatSchema.index({ participants: 1, lastMessageAt: -1 });

// Sorting two ObjectIds as hex strings is a stable total order, so (A,B) and
// (B,A) both yield low=A, high=B. Exported because the routes and the migration
// script need to build the same key this model enforces.
const canonicalPair = (a, b) =>
  [a, b].sort((x, y) => (x.toString() < y.toString() ? -1 : 1));

chatSchema.pre("validate", function (next) {
  if (this.participants && this.participants.length === 2) {
    const [low, high] = canonicalPair(
      this.participants[0],
      this.participants[1]
    );
    this.participantLow = low;
    this.participantHigh = high;
  }
  next();
});

// Get the conversation for a pair, creating it if this is the first time anyone
// opened it — atomically, in one round trip.
//
// `findOneAndUpdate` with upsert is the fix for the check-then-act described
// above: the match and the insert are a single atomic operation on the server, so
// two concurrent callers cannot both decide to insert. $setOnInsert means an
// existing conversation is returned untouched rather than having its metadata
// rewritten on every open.
//
// The E11000 catch is not redundant. Mongo's upsert can still race with itself:
// two upserts that both miss the index can both attempt the insert, and the
// loser gets a duplicate-key error rather than the winner's document. The
// documented remedy is to retry the read, which is guaranteed to find the
// winner's document — so the loser converges on the same conversation instead of
// surfacing a 500 to a user who did nothing wrong.
chatSchema.statics.findOrCreateForPair = async function (userIdA, userIdB) {
  const [low, high] = canonicalPair(userIdA, userIdB);

  const query = { participantLow: low, participantHigh: high };

  try {
    return await this.findOneAndUpdate(
      query,
      { $setOnInsert: { participants: [low, high], ...query } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    if (err.code === 11000) {
      return this.findOne(query);
    }
    throw err;
  }
};

const Chat = mongoose.model("Chat", chatSchema);

module.exports = { Chat, canonicalPair };
