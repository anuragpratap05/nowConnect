require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/database");
const ConnectionRequest = require("../models/connectionRequest");

// Phase 2 rollout step for the canonical-pair unique index.
//
// The index in src/models/connectionRequest.js is partial ({userIdLow,
// userIdHigh} must $exist), so it builds instantly and enforces uniqueness on
// every NEW write regardless of what the collection already holds. This script
// moves the pre-existing documents into that index by computing their pair.
//
// Two reasons it's a separate script rather than a migration run at boot:
//   1. It's a one-shot backfill over the largest collection in the system —
//      that belongs in an operator's hands, not on the API's startup path.
//   2. It can legitimately FAIL on some rows. If the old check-then-act race
//      already produced duplicate requests for a pair, only the first row can
//      enter a unique index; the rest are reported here for a human to decide
//      on (keep the oldest? keep the accepted one?) rather than being deleted
//      by a script.
//
// Idempotent: re-running only touches rows that still lack the pair fields.
// Usage: node src/scripts/backfillRequestPairs.js

const BATCH_SIZE = 500;

const canonicalPair = (a, b) =>
  [a, b].sort((x, y) => (x.toString() < y.toString() ? -1 : 1));

const backfill = async () => {
  await connectDB();
  console.log("Connected. Backfilling canonical pair fields...\n");

  const filter = { userIdLow: { $exists: false } };
  const total = await ConnectionRequest.countDocuments(filter);
  console.log(`Documents needing backfill: ${total}`);

  if (total === 0) {
    console.log("Nothing to do.");
    return { updated: 0, conflicts: [] };
  }

  let updated = 0;
  const conflicts = [];

  // Cursor + batched bulkWrite: never loads the whole collection into memory,
  // which matters precisely because this is the fastest-growing collection.
  const cursor = ConnectionRequest.find(filter)
    .select("fromUserId toUserId status createdAt")
    .lean()
    .cursor();

  let batch = [];

  const flush = async () => {
    if (batch.length === 0) return;

    try {
      // ordered: false — one conflicting row must not abort the rest of the batch.
      const res = await ConnectionRequest.bulkWrite(batch, { ordered: false });
      updated += res.modifiedCount || 0;
    } catch (err) {
      // A bulkWrite with failures still applies the successful ops and reports
      // the rest here, so we count what landed and record what collided.
      updated += err.result?.nModified ?? err.result?.result?.nModified ?? 0;

      for (const writeError of err.writeErrors || []) {
        if (writeError.code === 11000) {
          const op = batch[writeError.index];
          conflicts.push(op.updateOne.filter._id);
        } else {
          throw err;
        }
      }
    }

    batch = [];
  };

  for await (const doc of cursor) {
    const [low, high] = canonicalPair(doc.fromUserId, doc.toUserId);

    batch.push({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: { userIdLow: low, userIdHigh: high } },
      },
    });

    if (batch.length >= BATCH_SIZE) await flush();
  }

  await flush();

  return { updated, conflicts };
};

backfill()
  .then(async ({ updated, conflicts }) => {
    console.log(`\nBackfilled: ${updated}`);

    if (conflicts.length > 0) {
      console.log(
        `\n⚠️  ${conflicts.length} document(s) could not be backfilled because ` +
          `another request already occupies that pair in the unique index.\n` +
          `These are the duplicates the old check-then-act race created. ` +
          `Review and resolve manually — this script will not delete data:\n`
      );
      conflicts.forEach((id) => console.log(`  _id: ${id}`));
      console.log(
        `\nInspect one with:\n` +
          `  db.connectionrequests.find({_id: ObjectId("${conflicts[0]}")})`
      );
    } else {
      console.log("No pair conflicts — every request is unique per pair. ✅");
    }

    const remaining = await ConnectionRequest.countDocuments({
      userIdLow: { $exists: false },
    });
    console.log(`\nStill missing pair fields: ${remaining}`);

    await mongoose.connection.close();
    process.exit(conflicts.length > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error("Backfill failed:", err);
    await mongoose.connection.close();
    process.exit(1);
  });
