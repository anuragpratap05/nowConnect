require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/database");
const { Chat, canonicalPair } = require("../models/chat");
const Message = require("../models/message");

// Phase 3 migration: embedded Chat.messages[] -> the Message collection.
//
// This is the V1 -> V2 data move that the schema change in src/models/chat.js
// assumes. For each legacy chat document it:
//   1. inserts one Message per embedded message,
//   2. sets the canonical pair fields so the chat enters the new unique index,
//   3. sets lastMessageAt from the newest message,
//   4. $unsets the now-migrated `messages` array.
//
// Usage:
//   node src/scripts/migrateChatMessages.js --dry-run   # report only, no writes
//   node src/scripts/migrateChatMessages.js
//
// A separate operator-run script, not a boot-time migration, for the same reasons
// as src/scripts/backfillRequestPairs.js: it's one-shot, it's over user data, and
// it can partially fail in ways a human should look at rather than a process that
// is also trying to serve traffic.
//
// IDEMPOTENT, and the mechanism is worth stating because it's the whole design of
// this script: each embedded message already HAS an `_id` (Mongoose gives every
// subdocument one), and we reuse it as the new Message document's `_id` instead of
// generating a fresh one. So re-running cannot duplicate anything — the second
// insert of the same message collides with its own `_id` and is skipped. That also
// means a run interrupted halfway can simply be re-run, which is the property you
// actually want at 2am, and it keeps any message id a client already holds (as a
// pagination cursor, say) valid across the migration.

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 500;

// Read through the raw driver collection, NOT the Chat model. The model's schema
// no longer declares `messages`, so Mongoose would strip the field out of the
// result and the script would see every chat as already empty — quietly migrating
// nothing and reporting success. This is the one place in the codebase that has to
// see the old shape, so it's the one place that bypasses the model.
const rawChats = () => mongoose.connection.db.collection("chats");

const migrate = async () => {
  await connectDB();
  console.log(
    `Connected.${DRY_RUN ? " DRY RUN — no writes will be made.\n" : "\n"}`
  );

  const filter = { messages: { $exists: true, $not: { $size: 0 } } };
  const total = await rawChats().countDocuments(filter);
  console.log(`Chat documents with embedded messages: ${total}`);

  // Chats with no messages still need the pair fields, or they stay outside the
  // new unique index and two concurrent opens could duplicate them.
  const emptyFilter = {
    participantLow: { $exists: false },
    $or: [{ messages: { $exists: false } }, { messages: { $size: 0 } }],
  };
  const emptyTotal = await rawChats().countDocuments(emptyFilter);
  console.log(`Chat documents with no messages (pair fields only): ${emptyTotal}`);

  if (total === 0 && emptyTotal === 0) {
    console.log("Nothing to do.");
    return { chats: 0, messages: 0, skipped: 0, failures: [] };
  }

  let chatsMigrated = 0;
  let messagesInserted = 0;
  let messagesSkipped = 0;
  const failures = [];

  const cursor = rawChats().find(filter).batchSize(50);

  for await (const chat of cursor) {
    const embedded = chat.messages || [];

    const docs = embedded.map((msg) => ({
      // Reuse the subdocument's own _id — this is what makes the script
      // re-runnable. A subdocument written before timestamps existed could lack
      // one, so fall back to a fresh id rather than inserting a null _id.
      _id: msg._id || new mongoose.Types.ObjectId(),
      chatId: chat._id,
      senderId: msg.senderId,
      text: msg.text,
      createdAt: msg.createdAt || chat.createdAt || new Date(),
      updatedAt: msg.updatedAt || msg.createdAt || new Date(),
    }));

    // Preserve real timestamps rather than letting the schema stamp "now" —
    // otherwise the entire history collapses onto the migration's run time and
    // every conversation reads as if it happened in one second.
    const timestamps = docs
      .map((d) => d.createdAt)
      .filter(Boolean)
      .sort((a, b) => b - a);
    const lastMessageAt = timestamps[0] || chat.createdAt || null;

    const [low, high] = canonicalPair(
      chat.participants[0],
      chat.participants[1]
    );

    if (DRY_RUN) {
      console.log(
        `  [dry-run] chat ${chat._id}: would insert ${docs.length} message(s), ` +
          `set pair (${low}, ${high}), lastMessageAt=${lastMessageAt && lastMessageAt.toISOString?.()}`
      );
      chatsMigrated += 1;
      messagesInserted += docs.length;
      continue;
    }

    try {
      // ordered:false so one already-migrated message (a duplicate _id from a
      // previous run) doesn't abort the rest of the conversation. Inserted in
      // slices so a single enormous conversation doesn't build one giant batch.
      for (let i = 0; i < docs.length; i += BATCH_SIZE) {
        const slice = docs.slice(i, i + BATCH_SIZE);
        try {
          const res = await Message.collection.insertMany(slice, {
            ordered: false,
          });
          messagesInserted += res.insertedCount || 0;
        } catch (err) {
          // A BulkWriteError still applies every op that didn't conflict. Count
          // what landed, treat duplicate-key as "already migrated", and re-throw
          // anything else — a validation or connection failure must not be
          // mistaken for idempotency.
          const inserted = err.result?.insertedCount ?? 0;
          messagesInserted += inserted;

          const writeErrors = err.writeErrors || [];
          const nonDuplicate = writeErrors.filter((e) => e.code !== 11000);
          if (nonDuplicate.length > 0 || writeErrors.length === 0) throw err;

          messagesSkipped += writeErrors.length;
        }
      }

      // Only now drop the embedded array. Order is deliberate: messages are
      // copied and confirmed BEFORE the source is removed, so an interruption
      // anywhere in this script leaves duplicated data (harmless, and the
      // re-run skips it) rather than deleted data.
      await rawChats().updateOne(
        { _id: chat._id },
        {
          $set: {
            participantLow: low,
            participantHigh: high,
            ...(lastMessageAt ? { lastMessageAt } : {}),
          },
          $unset: { messages: "" },
        }
      );

      chatsMigrated += 1;
    } catch (err) {
      // Never abort the whole migration for one bad conversation — record it and
      // keep going, so one corrupt row can't block every other user's history.
      console.error(`  ✗ chat ${chat._id}: ${err.message}`);
      failures.push({ chatId: chat._id, reason: err.message });
    }
  }

  // Second pass: message-less chats just need the pair fields.
  if (!DRY_RUN && emptyTotal > 0) {
    const emptyCursor = rawChats().find(emptyFilter);
    for await (const chat of emptyCursor) {
      if (!chat.participants || chat.participants.length !== 2) {
        failures.push({
          chatId: chat._id,
          reason: `expected 2 participants, found ${chat.participants?.length ?? 0}`,
        });
        continue;
      }

      const [low, high] = canonicalPair(
        chat.participants[0],
        chat.participants[1]
      );

      try {
        await rawChats().updateOne(
          { _id: chat._id },
          { $set: { participantLow: low, participantHigh: high } }
        );
        chatsMigrated += 1;
      } catch (err) {
        // E11000 here means the old check-then-act race already produced two Chat
        // documents for this pair. Only one can enter the unique index; the script
        // refuses to guess which conversation to keep and leaves it for a human,
        // exactly as the Phase 2 backfill does.
        failures.push({ chatId: chat._id, reason: err.message });
      }
    }
  }

  return {
    chats: chatsMigrated,
    messages: messagesInserted,
    skipped: messagesSkipped,
    failures,
  };
};

migrate()
  .then(async ({ chats, messages, skipped, failures }) => {
    console.log(
      `\n${DRY_RUN ? "[dry-run] " : ""}Chats migrated: ${chats}` +
        `\n${DRY_RUN ? "[dry-run] " : ""}Messages inserted: ${messages}` +
        (skipped ? `\nMessages already present (skipped): ${skipped}` : "")
    );

    if (failures.length > 0) {
      console.log(
        `\n⚠️  ${failures.length} chat document(s) could not be migrated. ` +
          `Review manually — this script does not delete data:\n`
      );
      failures.forEach((f) => console.log(`  chat ${f.chatId}: ${f.reason}`));
    }

    if (!DRY_RUN) {
      const remaining = await rawChats().countDocuments({
        messages: { $exists: true, $not: { $size: 0 } },
      });
      const unpaired = await rawChats().countDocuments({
        participantLow: { $exists: false },
      });
      console.log(`\nChats still holding embedded messages: ${remaining}`);
      console.log(`Chats still outside the unique pair index: ${unpaired}`);
      console.log(`Total documents in Message collection: ${await Message.countDocuments()}`);
    }

    await mongoose.connection.close();
    process.exit(failures.length > 0 ? 1 : 0);
  })
  .catch(async (err) => {
    console.error("Migration failed:", err);
    await mongoose.connection.close();
    process.exit(1);
  });
