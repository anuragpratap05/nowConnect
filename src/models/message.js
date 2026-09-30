const mongoose = require("mongoose");

// Phase 3 — messages as their own collection.
//
// The V1 design embedded every message of a conversation in an array on the Chat
// document (see git history of src/models/chat.js). Three things break there,
// in increasing order of how hard they are to notice:
//
//   1. The 16MB document cap. MongoDB refuses any document over 16MB, so a
//      conversation has a hard ceiling — roughly 100-150k short messages — after
//      which every further send fails outright. Not "gets slow": stops working,
//      permanently, for that pair, with no migration path that doesn't involve
//      the change in this file.
//   2. Whole-array rewrite on every write. `chat.messages.push(...)` followed by
//      `chat.save()` sends the entire array back to the server, so the cost of
//      appending message N is O(N). A long conversation gets progressively more
//      expensive to talk in, and the document is rewritten in place each time,
//      which fragments storage and re-replicates the whole array to secondaries
//      and the oplog on every single message.
//   3. Reads cannot be paginated meaningfully. A projection can slice the array,
//      but the server still loads the whole document off disk to do it.
//
// One document per message makes an append O(1) and a page of history an index
// range scan, at the cost of an extra collection and a join (or a populate) when
// you want sender names. That is the trade we want: this is an append-heavy,
// read-recent workload, which is exactly what a flat indexed collection is for.

const messageSchema = new mongoose.Schema(
  {
    chatId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Chat",
      required: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
      // Bounded so a single client cannot write an unbounded document. The old
      // embedded design had no per-message limit either, which made the 16MB
      // document cap reachable by one determined sender rather than only by a
      // genuinely long conversation.
      maxLength: 2000,
    },
  },
  { timestamps: true }
);

// The one index the read path needs: {chatId, _id descending}.
//
// Why _id and not createdAt, which is the obvious choice and the one the plan
// originally called for: `createdAt` is a millisecond timestamp and is therefore
// NOT unique. Two messages saved in the same millisecond tie, and a cursor built
// on a non-unique sort key cannot be exact — `createdAt < cursor` skips every
// message that shares the boundary timestamp, and `<=` re-sends them. Under a
// fast back-and-forth (or any bulk insert, like the migration script) that is a
// silently dropped or duplicated message, which is the worst possible bug for a
// chat product because the user cannot tell it happened.
//
// _id has no ties: it is a TOTAL, stable, unique order, which is the property a
// cursor actually requires. Its leading 4 bytes are a unix timestamp, so it is
// also chronological — but only to SECOND granularity. Within the same second
// the remaining bytes (a per-process random value plus a counter) decide, which
// is monotonic within one process and arbitrary across processes. This is real
// and observable: two messages 70ms apart, written by two different instances in
// the same second, sort by _id in the opposite order to their createdAt.
//
// That is not a reason to prefer createdAt, because createdAt cannot order them
// reliably either — across instances, sub-second ordering is a function of clock
// skew, so a "true" millisecond order between two processes is not something
// either field can give you. The difference is that _id's ordering is exact and
// stable (no message can be skipped or repeated at a page boundary) while
// createdAt's is neither.
//
// So: page by _id, display createdAt. Correctness from the one that is unique,
// precision from the one that is precise. This is also the same cursor
// convention Phase 2 chose for the feed — one set of edge cases across the
// codebase instead of two.
//
// Declared descending because history is read newest-first. Mongo can walk a
// compound index in reverse, so {chatId: 1, _id: 1} would also serve this query
// — matching the declared direction to the dominant access pattern just keeps
// the intent legible in `getIndexes()` output.
messageSchema.index({ chatId: 1, _id: -1 });

const Message = mongoose.model("Message", messageSchema);

module.exports = Message;
