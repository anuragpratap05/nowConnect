const mongoose = require("mongoose");

// Phase 4 — likes as their own collection, for the third time in this codebase.
//
// This is the same decision as Phase 2's canonical pair and Phase 3's Message
// split, and it is worth naming the pattern explicitly because all three are the
// same move: when a relationship is (a) unbounded in count and (b) must exist at
// most once, it belongs in its own collection with a unique index on the pair,
// not in an array on one of the two sides.
//
// What an embedded `likes: [ObjectId]` array on Post would cost:
//   1. Unbounded growth against the 16MB document cap. At 12 bytes per ObjectId
//      that is ~1.3M likes before a post becomes permanently unlikeable. Remote
//      for this app — but the failure mode is total and unrecoverable-in-place,
//      which is exactly what made the chat version of this bug worth a phase.
//   2. Whole-document rewrite per like. The hottest document in the system (a
//      popular post) would be rewritten, re-replicated and re-oplogged on every
//      single like, and it is the same document every feed read is fetching.
//   3. No pagination of likers, and no way to answer "did *I* like this" without
//      pulling the entire array over the wire.
//   4. $addToSet makes a like idempotent but gives you NO way to make it atomic
//      with the counter, and a 1.3M-element $addToSet is a linear scan of the
//      array server-side on every like.
//
// The flat collection makes a like one small insert, the uniqueness a database
// guarantee, and "did I like this" a single point lookup.

const likeSchema = new mongoose.Schema(
  {
    postId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Post",
      required: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true }
);

// The index this whole design rests on.
//
// UNIQUE is what makes liking idempotent WITHOUT any application-level guard. The
// route does not check "has this user already liked this post" — it just inserts,
// and lets the index reject the second attempt with E11000, which the route reads
// as "already liked, nothing to do" and answers 200. That matters because
// check-then-act is precisely the bug Phase 2 fixed on swipes: two concurrent
// likes (a double-tap sends two requests) both pass a findOne check and both
// insert. Here the second one cannot land, no matter how close together they
// arrive, because the database is the one deciding.
//
// The key ORDER is {postId, userId}, not the reverse, and it is doing two jobs:
//   - Enforcing the uniqueness above (either order would do that).
//   - Serving "who liked post X" / "how many" as a contiguous range scan on a
//     single postId prefix — the query a likers list needs.
//
// A leading `userId` would instead serve "everything user X liked", which is not
// a screen this app has. If it ever gets one, that is a second index, not a
// reordering of this one: reordering would turn the range scan for a post's likers
// into a scan of the whole index.
//
// No partialFilterExpression here, unlike the Phase 2/3 unique indexes. Those had
// to tolerate pre-existing documents that lacked the new fields; this collection
// is created by this phase and is empty, so every document it will ever hold has
// both fields. A plain unique index is the simpler correct thing when there is no
// legacy row to accommodate.
likeSchema.index({ postId: 1, userId: 1 }, { unique: true });

const Like = mongoose.model("Like", likeSchema);

module.exports = Like;
