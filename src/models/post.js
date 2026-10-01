const mongoose = require("mongoose");

// Phase 4 — a post is a caption plus a POINTER into object storage.
//
// The single most important thing about this schema is what it does NOT contain:
// image bytes, and a `likes` array.
//
// No bytes: `imageKey` is an S3 object key, not a URL and not a Buffer. Mongo
// stores the 80-byte key; the object store stores the 3MB JPEG. Putting binary in
// Mongo (or worse, base64 in a string field) would mean every document read drags
// megabytes through the working set, and the 16MB document cap would put a hard
// ceiling on image size. It also means image bytes never transit this Node
// process at all — see src/routes/post.js for the presigned-upload flow.
//
// Why a KEY and not a URL: a URL bakes in the bucket, the region, the endpoint and
// the access scheme. We serve MinIO locally and real S3 in production (Phase 0's
// "one env var, no code branch" rule), and read URLs here are short-lived
// presigned GETs that expire — so a stored URL would be stale within the hour AND
// wrong in the other environment. The key is the stable identity; the URL is
// derived at read time.
//
// No likes array: that is the Phase 3 lesson applied before it bites. An embedded
// array of liker ids on a post has exactly the failure modes the chat `messages`
// array had — unbounded growth against the 16MB cap, a whole-document rewrite on
// every like, and no way to paginate likers. A popular post is precisely the
// document you least want to be rewriting under load. Likes live in their own
// collection (src/models/like.js); what stays here is the one denormalised number
// a feed render actually needs.

const postSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    // The S3 key of the full-size original, e.g.
    // `posts/652f.../3f9a1c2b8e7d4f60.jpg`.
    //
    // Unique, because it is also the idempotency key for POST /posts. The upload
    // flow is two calls (get a presigned URL, then claim the uploaded object), and
    // a client that retries the second call — a flaky network, a double-tapped
    // Share button — would otherwise create two posts pointing at one image. The
    // index makes the second insert fail with E11000, which the route reads as
    // "already claimed" rather than as an error. Correctness from the database
    // again, not from a check-then-act in the handler.
    imageKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },

    // Set LATER, by src/workers/thumbnailWorker.js — null on every freshly
    // created post and that is the intended steady state for the first second or
    // two of a post's life.
    //
    // Nullable is the whole design: it makes the thumbnail an optimisation rather
    // than a precondition. The post is complete and renderable the moment the row
    // exists (clients fall back to the original), so a backed-up or crashed
    // thumbnail worker degrades image weight, not availability. Had this been
    // `required`, the resize would have to happen inline on the request and the
    // upload would be exactly as slow as the slowest image.
    thumbnailKey: {
      type: String,
      default: null,
      trim: true,
    },

    caption: {
      type: String,
      trim: true,
      default: "",
      // Bounded for the same reason Message.text is bounded: a field a client can
      // fill is a field a client can fill with 15MB.
      maxLength: 2200,
    },

    // Denormalised counter, maintained with $inc by the like/unlike routes.
    //
    // Why store a number that is derivable: without it, rendering a 20-post feed
    // means 20 `countDocuments` queries against the Like collection (or one
    // $lookup + $group aggregation that cannot use the feed's cursor index well).
    // The count is read on every feed impression and written once per like — a
    // read:write ratio of hundreds to one, which is the textbook case for
    // precomputing.
    //
    // The honest cost: this is a second source of truth and it can drift. It is
    // only ever $inc'd when the corresponding Like insert actually succeeded, and
    // only ever $dec'd when a Like was actually deleted (see src/routes/post.js),
    // so the two can only diverge if the process dies in the window between those
    // two writes — there is no transaction here. That is a deliberate trade: the
    // blast radius of a drift is a like count that reads 41 instead of 42, and the
    // Like collection remains the source of truth from which it can be recomputed
    // at any time. `min: 0` stops an unlike-that-double-fires from ever rendering
    // a negative count to a user.
    likeCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true }
);

// The feed index. GET /posts/feed asks:
//     find({userId: {$in: [...my connections]}, _id: {$lt: cursor}}).sort({_id: -1})
//
// {userId: 1, _id: -1} lets MongoDB open one index scan per $in value, position
// each directly at the cursor within that author's key range, and SORT_MERGE the
// streams — so it fetches only the documents the page actually returns.
//
// _id descending for the same reason chat history uses it: a feed opens at the
// newest post and pages backwards into the past, and _id is the unique, tie-free
// cursor that pagination correctness requires while createdAt is not. The full
// argument is in src/models/message.js — this is the third place in the codebase
// using that one convention, which is the point of having one.
//
// MEASURED, because the obvious claim ("this index makes the feed fast") turned
// out to be conditional, and the condition is the interesting part.
//
// Without this index the query is still not a COLLSCAN: MongoDB can walk the
// default _id index in descending order — which already satisfies the sort and
// the cursor — and filter each document by userId. Whether that is cheaper than
// the merge depends entirely on what FRACTION of all authors the viewer follows,
// because that fraction is the hit rate of the filter. At 50,000 posts
// (docsExamined for one 10-post page):
//
//   viewer follows 120 of     400 authors (30%):   _id-walk 36  vs  merge 11
//   viewer follows 120 of  20,000 authors (0.6%):  _id-walk 2525 vs merge 11
//
// In a dense graph the _id walk wins outright — it finds 11 matching posts in 36
// documents, while the merge pays to open and coordinate 121 index cursors. In a
// realistically sparse graph it has to examine 2,525 documents to fill one page,
// because 99.4% of what it walks past belongs to someone the viewer does not
// follow, and that number grows in proportion to the user base while the merge's
// stays at 11.
//
// So this index is here for the regime the app is actually heading into, not the
// regime a small test database is in. The metric to watch is docsExamined rather
// than wall-clock: at 50k documents everything is in cache and the timings are
// noise, but a fetched document is a potential random read, and 2,525 of them per
// page is what falls off a cliff once the collection outgrows RAM.
//
// One honest wrinkle worth knowing before an interviewer finds it: in the DENSE
// regime MongoDB's planner picks the merge anyway and is measurably slower for it
// (14ms vs 0ms) — its cost model undercounts the overhead of coordinating 121
// cursors. That is a real limitation of relying on the planner, and the lever if
// it ever matters in production is .hint(). Not used here: hinting pins a plan
// that stops adapting when the data distribution changes, and the distribution is
// moving toward the regime where the merge is correct anyway.
postSchema.index({ userId: 1, _id: -1 });

const Post = mongoose.model("Post", postSchema);

module.exports = Post;
