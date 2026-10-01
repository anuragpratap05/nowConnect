const express = require("express");
const mongoose = require("mongoose");

const { userAuth } = require("../middlewares/auth");
const Post = require("../models/post");
const Like = require("../models/like");
const { getAcceptedConnectionIds } = require("../utils/connectionGraph");
const { areConnected } = require("../utils/connectionGuard");
const { postUploadLimits } = require("../utils/constants");
const { addThumbnailJob } = require("../queues/thumbnailQueue");
const {
  createUploadUrl,
  createViewUrl,
  verifyUploadedObject,
  deleteObjectQuietly,
} = require("../utils/postStorage");

const postRouter = express.Router();

// Same limit-clamping shape as the feed (src/routes/user.js) and chat history
// (src/routes/chat.js): a client can ask for less, cannot ask for more than the
// ceiling, and a garbage value falls back to the default instead of becoming NaN
// and returning the whole collection.
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;

const USER_SAFE_DATA = "firstName lastName photoUrl";

// ---------------------------------------------------------------------------
// POST /posts/upload-url  — step 1 of 3
// ---------------------------------------------------------------------------
//
// Creating a post is three steps, not one:
//
//   1. POST /posts/upload-url  -> { key, url }        (this route)
//   2. PUT <url>               -> bytes go to S3      (client to S3, we are not involved)
//   3. POST /posts { key, caption } -> the Post row    (the "claim")
//
// The reason it is three and not one is the whole point of the design — image
// bytes never transit this process. The full cost argument is in
// src/utils/postStorage.js.
//
// Why this is a POST and not a GET, despite reading like one: it has a side effect
// (it mints a credential that authorizes a write to our bucket) and it must never
// be cached by a proxy or a browser — a cached upload URL would hand a second
// uploader a key that a different user's post already points at.
postRouter.post("/posts/upload-url", userAuth, async (req, res) => {
  try {
    const { contentType } = req.body;

    // Validated against an ALLOWLIST, not a pattern like /^image\//.
    //
    // A regex would accept image/svg+xml, and an SVG is not a picture — it is a
    // document that can carry <script>. Served from our own origin it would be
    // stored XSS; served from the bucket's it is still a phishing surface. An
    // allowlist of three raster formats also happens to be exactly the set sharp
    // is configured to handle in the thumbnail worker, so the two ends of the
    // pipeline cannot disagree about what is uploadable.
    if (!postUploadLimits.ALLOWED_IMAGE_TYPES.includes(contentType)) {
      return res.status(400).json({
        message:
          "contentType must be one of: " +
          postUploadLimits.ALLOWED_IMAGE_TYPES.join(", "),
      });
    }

    // The key is built from the AUTHENTICATED user's id, never from anything in
    // the request body. That is what makes the `posts/<userId>/` prefix a real
    // ownership boundary rather than a naming convention: a user cannot obtain a
    // signed URL that writes into another user's prefix, because they never get
    // to influence the prefix.
    const { key, url, expiresIn } = await createUploadUrl(
      req.user._id,
      contentType
    );

    res.json({
      key,
      url,
      expiresIn,
      // Echoed so the client can reject an oversized file BEFORE spending the
      // user's bandwidth uploading something the claim step would refuse. This is
      // a UX affordance, not a control — the enforcing check is the HeadObject in
      // POST /posts below, because anything the client checks, a client can skip.
      maxBytes: postUploadLimits.MAX_IMAGE_BYTES,
    });
  } catch (err) {
    console.error("[POST /posts/upload-url] failed:", err);
    res.status(500).json({ message: "Could not create an upload URL" });
  }
});

// ---------------------------------------------------------------------------
// POST /posts  — step 3 of 3, the "claim"
// ---------------------------------------------------------------------------
//
// Turns an uploaded object into a post. Everything defensive about this route
// follows from one fact: between step 1 and step 3, the only thing we know is what
// the client tells us, and the client could tell us anything.
postRouter.post("/posts", userAuth, async (req, res) => {
  try {
    const { imageKey, caption = "" } = req.body;
    const userId = req.user._id;

    if (!imageKey || typeof imageKey !== "string") {
      return res.status(400).json({ message: "imageKey is required" });
    }

    // THE authorization check of this route.
    //
    // `imageKey` arrives in a request body, so it is attacker-controlled. Without
    // this check a user could claim ANY key in the bucket — including another
    // user's — and publish someone else's private photo as their own post. The key
    // format is what makes the check a one-liner: because step 1 always builds
    // `posts/<userId>/...` from the authenticated session, a key belongs to this
    // user if and only if it starts with their own prefix.
    //
    // This is why the key is structured and server-generated rather than opaque
    // randomness: the structure carries the ownership claim, so verifying it needs
    // no extra "pending upload" table to look the key up in.
    if (!imageKey.startsWith(`posts/${userId}/`)) {
      return res
        .status(403)
        .json({ message: "That upload key does not belong to you" });
    }

    if (typeof caption !== "string" || caption.length > 2200) {
      return res
        .status(400)
        .json({ message: "caption must be a string of at most 2200 characters" });
    }

    // Did the client actually upload, and is what it uploaded within limits?
    //
    // Skipping this would let a client create a post whose image key points at
    // nothing — a permanently broken post in everyone's feed — simply by calling
    // step 3 without doing step 2. HeadObject is metadata-only, so this costs one
    // small round trip and no bytes. It is also the size enforcement a presigned
    // PUT cannot do itself; see src/utils/postStorage.js for why that is and what
    // the alternatives were.
    const verification = await verifyUploadedObject(imageKey);

    if (!verification.ok) {
      if (verification.reason === "missing") {
        return res
          .status(400)
          .json({ message: "No uploaded image found for that key" });
      }

      // The object exists but must not become a post. Delete it — otherwise a
      // client could use the upload-url endpoint as free unlimited storage by
      // uploading oversized objects and simply never claiming them.
      await deleteObjectQuietly(imageKey);

      if (verification.reason === "too_large") {
        return res.status(413).json({
          message: `Image is ${verification.size} bytes; the limit is ${postUploadLimits.MAX_IMAGE_BYTES}`,
        });
      }
      return res
        .status(400)
        .json({ message: `Unsupported image type: ${verification.contentType}` });
    }

    let post;
    try {
      post = await Post.create({ userId, imageKey, caption: caption.trim() });
    } catch (err) {
      // Idempotency, via the unique index on imageKey rather than via a
      // check-then-act findOne.
      //
      // The retry this handles is the common one: the client PUT the image, called
      // POST /posts, and lost the response to a flaky connection — so it retries
      // with the same key. Creating a second post for one image would be wrong,
      // and 500-ing would push the client to retry again. Returning the post that
      // already exists makes the operation safely repeatable, which is the
      // property a client on a mobile network actually needs.
      //
      // Same technique as the swipe route (Phase 2) and the chat upsert (Phase 3):
      // let the database be the authority on uniqueness, then translate its
      // duplicate-key error into the ordinary outcome it represents.
      if (err.code === 11000) {
        const existing = await Post.findOne({ imageKey });
        if (existing) {
          return res.status(200).json({
            message: "Post already created for this image",
            data: await withViewUrls(existing.toObject()),
          });
        }
      }
      throw err;
    }

    // Enqueue the resize AFTER the post is durably written, and never let a queue
    // failure fail the request.
    //
    // Order matters: enqueueing first would let the worker pick the job up and
    // look for a post that does not exist yet. Non-fatal matters because the post
    // is already created and the user's action has succeeded — Redis being down
    // must not turn a successful post into a 500. The cost of the dropped job is a
    // post that renders from its original image instead of a thumbnail, which is
    // exactly the degradation `thumbnailKey: null` was designed to make safe.
    try {
      await addThumbnailJob({ postId: post._id, imageKey });
    } catch (err) {
      console.error(
        `[POST /posts] could not enqueue thumbnail for ${post._id}:`,
        err.message
      );
    }

    res.status(201).json({
      message: "Post created",
      data: await withViewUrls(post.toObject()),
    });
  } catch (err) {
    console.error("[POST /posts] failed:", err);
    res.status(400).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /posts/feed
// ---------------------------------------------------------------------------
//
// Cursor-paginated, scoped to the requester's accepted connections, plus their own
// posts.
//
// THE SCALING DECISION — fan-out on read, chosen knowingly:
//
// This query reads the requester's connection list, then asks for the newest posts
// authored by anyone in it. The timeline is COMPUTED at read time. The alternative
// is fan-out on write: give every user a materialised timeline, and on each new
// post push its id into all of the author's connections' timelines.
//
//   Fan-out on read (here):  cheap writes (one insert), more expensive reads
//                            (an $in over N connections, merged and sorted).
//   Fan-out on write:        O(1) reads (one contiguous range scan of your own
//                            timeline), expensive writes (N inserts per post),
//                            and a materialised copy per user to keep correct.
//
// Read-time is right for THIS app, for a reason specific to it rather than a
// general preference: the $in is bounded by the connection count, and connections
// here are mutual and require an accepted request, so the fan-out is in the
// hundreds. The {userId, _id: -1} index turns that into a bounded number of index
// range scans that MongoDB merge-sorts, and each scan positions directly at the
// cursor — so a page costs O(connections + page size), with no term that grows
// with the size of the Post collection.
//
// Where that breaks, precisely: the celebrity problem. Fan-out on write collapses
// when one author has millions of followers, because a single post becomes
// millions of timeline inserts. Fan-out on read collapses when one READER follows
// tens of thousands of authors, because the $in becomes tens of thousands of index
// scans to merge. A mutual-connection graph cannot produce the second case without
// also being absurd socially — you cannot have 50,000 accepted mutual connections
// — which is exactly why read-time is safe here and would not be on Twitter. The
// real answer at that scale is hybrid: fan-out on write for ordinary accounts,
// read-time merge for the few high-fan-out ones.
postRouter.get("/posts/feed", userAuth, async (req, res) => {
  try {
    const userId = req.user._id;

    let limit = parseInt(req.query.limit) || DEFAULT_LIMIT;
    limit = limit > MAX_LIMIT ? MAX_LIMIT : limit;
    limit = limit < 1 ? DEFAULT_LIMIT : limit;

    const { cursor } = req.query;
    if (cursor && !mongoose.Types.ObjectId.isValid(cursor)) {
      return res.status(400).json({ message: "Invalid cursor: " + cursor });
    }

    // The requester's own id is included, so your own posts appear in your feed.
    // Without it, posting would look broken to the person who just posted — the
    // one reader guaranteed to check.
    const connectionIds = await getAcceptedConnectionIds(userId);
    const authorIds = [...connectionIds, userId];

    // Cursor pagination walking BACKWARDS, the same direction and convention as
    // chat history: a feed opens at the newest post and pages into the past, so it
    // is `_id < cursor` with a descending sort. `.skip()` would make each page
    // progressively more expensive exactly as the user scrolls further, and would
    // also duplicate or drop posts when someone posts mid-scroll and shifts every
    // subsequent offset.
    const query = { userId: { $in: authorIds } };
    if (cursor) {
      query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    // limit + 1 to learn whether an older page exists without a second count
    // query — same trick as the feed and chat history.
    const posts = await Post.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .populate("userId", USER_SAFE_DATA)
      .lean();

    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;

    // "Did I like this?" for the whole page in ONE query, not one per post.
    //
    // The N+1 this avoids is the classic one: a 10-post page would otherwise be 10
    // extra round trips, and the per-post version gets slower in direct proportion
    // to page size. One $in over the page's ids, served by the {postId, userId}
    // unique index, answers all of them — and because the index contains both
    // fields the projection needs, it never fetches a document.
    const likedPostIds = await likedIdsForPage(page, userId);

    const data = await Promise.all(
      page.map(async (post) => ({
        ...(await withViewUrls(post)),
        likedByMe: likedPostIds.has(post._id.toString()),
      }))
    );

    res.json({
      data,
      nextCursor: hasMore ? page[page.length - 1]._id : null,
      hasMore,
    });
  } catch (err) {
    console.error("[GET /posts/feed] failed:", err);
    res.status(400).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /posts/user/:userId
// ---------------------------------------------------------------------------
//
// One author's posts, for a profile page. Authorized through the SAME connection
// graph as the feed rather than a rule of its own — a profile view must not be a
// way to read posts the feed would have hidden. Sharing
// src/utils/connectionGraph.js between the two is what stops the two rules from
// drifting apart, the same argument as Phase 3's shared connectionGuard.
postRouter.get("/posts/user/:userId", userAuth, async (req, res) => {
  try {
    const { userId: targetUserId } = req.params;
    const viewerId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      return res
        .status(400)
        .json({ message: "Invalid user id: " + targetUserId });
    }

    const isSelf = targetUserId === viewerId.toString();

    // Pairwise check, so this uses Phase 3's connectionGuard rather than pulling
    // the viewer's whole connection list and scanning it. areConnected is a single
    // point lookup against the unique {userIdLow, userIdHigh} index — it examines
    // one key and at most one document, no matter how many connections the viewer
    // has. getAcceptedConnectionIds is the right tool for the FEED, which genuinely
    // needs every id; using it here would read N documents to answer a question
    // about one of them.
    if (!isSelf && !(await areConnected(viewerId, targetUserId))) {
      return res.status(403).json({
        message: "You can only view posts from your connections",
      });
    }

    let limit = parseInt(req.query.limit) || DEFAULT_LIMIT;
    limit = limit > MAX_LIMIT ? MAX_LIMIT : limit;
    limit = limit < 1 ? DEFAULT_LIMIT : limit;

    const { cursor } = req.query;
    if (cursor && !mongoose.Types.ObjectId.isValid(cursor)) {
      return res.status(400).json({ message: "Invalid cursor: " + cursor });
    }

    const query = { userId: targetUserId };
    if (cursor) {
      query._id = { $lt: new mongoose.Types.ObjectId(cursor) };
    }

    // The single-author case is the BEST case for the {userId, _id: -1} index:
    // one equality on the leading field plus a range on the second, so it is a
    // single contiguous range scan rather than the merge of many that the feed
    // needs.
    const posts = await Post.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .populate("userId", USER_SAFE_DATA)
      .lean();

    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;
    const likedPostIds = await likedIdsForPage(page, viewerId);

    const data = await Promise.all(
      page.map(async (post) => ({
        ...(await withViewUrls(post)),
        likedByMe: likedPostIds.has(post._id.toString()),
      }))
    );

    res.json({
      data,
      nextCursor: hasMore ? page[page.length - 1]._id : null,
      hasMore,
    });
  } catch (err) {
    console.error("[GET /posts/user] failed:", err);
    res.status(400).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /posts/:postId/like  and  DELETE /posts/:postId/like
// ---------------------------------------------------------------------------
//
// Both are IDEMPOTENT, and neither contains a "have they already liked it?"
// check. That is the payoff of the unique {postId, userId} index: liking twice is
// a duplicate-key error the route reads as "already liked", and unliking twice
// deletes zero documents. A double-tapped heart, a retried request, and two
// devices acting at once all converge on the same state.
//
// The alternative — findOne, then branch — is check-then-act, the exact bug Phase 2
// fixed on swipes. Two concurrent likes both pass the check and both try to
// insert; one gets a 500 the user did nothing to deserve, and if the counter is
// $inc'd alongside it, the count can end up wrong in a way no later request will
// correct.
postRouter.post("/posts/:postId/like", userAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({ message: "Invalid post id: " + postId });
    }

    // Authorization: you can only like a post you are allowed to SEE, which is the
    // same connection-graph rule the feed applies. Without this, post ids
    // (returned freely in feed responses, and guessable as ObjectIds) would be
    // likeable by strangers — and each like would notify and inflate the counter
    // of a post that user was never permitted to view.
    const post = await Post.findById(postId).select("_id userId");
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }
    if (!(await canView(userId, post.userId))) {
      return res
        .status(403)
        .json({ message: "You can only like posts from your connections" });
    }

    try {
      await Like.create({ postId, userId });
    } catch (err) {
      if (err.code === 11000) {
        // Already liked. Return the CURRENT count rather than assuming it, so a
        // client that got here by retrying still renders the true number.
        const current = await Post.findById(postId).select("likeCount").lean();
        return res.status(200).json({
          message: "Already liked",
          data: { postId, likedByMe: true, likeCount: current?.likeCount ?? 0 },
        });
      }
      throw err;
    }

    // $inc, not read-modify-write.
    //
    // `post.likeCount += 1; post.save()` would be a lost update under concurrency:
    // two likers both read 5, both write 6, and one like vanishes from the count.
    // $inc is applied atomically by the server on the document itself, so N
    // concurrent increments always sum to N.
    //
    // Only reached when the Like insert SUCCEEDED, which is what keeps the counter
    // honest — the duplicate path above returns before here, so a retried like can
    // never inflate it.
    const updated = await Post.findByIdAndUpdate(
      postId,
      { $inc: { likeCount: 1 } },
      { new: true, select: "likeCount" }
    );

    res.status(201).json({
      message: "Post liked",
      data: { postId, likedByMe: true, likeCount: updated.likeCount },
    });
  } catch (err) {
    console.error("[POST /posts/:postId/like] failed:", err);
    res.status(400).json({ message: err.message });
  }
});

postRouter.delete("/posts/:postId/like", userAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({ message: "Invalid post id: " + postId });
    }

    // No connection check here, deliberately, and it is not an oversight.
    //
    // Unliking only ever REMOVES a row this same user created. If they are no
    // longer connected to the author, they should still be able to withdraw a like
    // they left earlier — gating it would strand the row forever and leave the
    // counter permanently inflated. The general rule: authorize the action that
    // creates state, not the action that withdraws your own.
    const result = await Like.deleteOne({ postId, userId });

    if (result.deletedCount === 0) {
      // Not liked in the first place. A no-op, reported as success, because the
      // caller's intended end state ("I don't like this post") already holds. A
      // 404 here would make a double-tapped unlike look like a failure.
      const current = await Post.findById(postId).select("likeCount").lean();
      if (!current) {
        return res.status(404).json({ message: "Post not found" });
      }
      return res.status(200).json({
        message: "Not liked",
        data: { postId, likedByMe: false, likeCount: current.likeCount },
      });
    }

    // Guarded on `likeCount: {$gt: 0}` so the counter can never be driven
    // negative, even if it has already drifted below the true number of likes.
    // `min: 0` on the schema would reject the write with a validation error
    // instead; this makes it a silent no-op, which is the right behaviour for a
    // derived counter — the user's unlike still succeeded, and the Like collection
    // remains the source of truth to recompute from.
    const updated = await Post.findOneAndUpdate(
      { _id: postId, likeCount: { $gt: 0 } },
      { $inc: { likeCount: -1 } },
      { new: true, select: "likeCount" }
    );

    res.json({
      message: "Post unliked",
      data: {
        postId,
        likedByMe: false,
        likeCount: updated ? updated.likeCount : 0,
      },
    });
  } catch (err) {
    console.error("[DELETE /posts/:postId/like] failed:", err);
    res.status(400).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /posts/:postId
// ---------------------------------------------------------------------------
postRouter.delete("/posts/:postId", userAuth, async (req, res) => {
  try {
    const { postId } = req.params;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(400).json({ message: "Invalid post id: " + postId });
    }

    // Ownership is enforced in the QUERY, not in a separate check followed by a
    // delete. One round trip, and no window in which the post could change hands
    // between the check and the delete. A non-owner gets the same 404 as a missing
    // post, which also avoids confirming that a post id exists.
    const post = await Post.findOneAndDelete({ _id: postId, userId });
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    // Clean up the likes. Not transactional with the delete above — if the process
    // dies here the rows are orphaned, and that is tolerable because nothing reads
    // a like except through its post, which no longer exists. The alternative
    // (leaving them forever) makes the Like collection grow without bound.
    await Like.deleteMany({ postId });

    // Object-store cleanup last, and best-effort. The post is already gone from
    // the user's perspective; failing to delete two objects must not produce an
    // error response for an operation that has already succeeded. What it leaves
    // is unreferenced bytes, which the bucket lifecycle rule in docs/phase-4.md is
    // the systematic backstop for.
    await Promise.all([
      deleteObjectQuietly(post.imageKey),
      deleteObjectQuietly(post.thumbnailKey),
    ]);

    res.json({ message: "Post deleted", data: { _id: post._id } });
  } catch (err) {
    console.error("[DELETE /posts/:postId] failed:", err);
    res.status(400).json({ message: err.message });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Attach short-lived presigned GET URLs, and strip the raw keys from the response.
//
// The keys are an internal identifier — the client only ever needs something it can
// put in an <img src>. Leaking the bucket layout buys an attacker reconnaissance
// (the userId prefix, the naming scheme) for no client benefit.
//
// `thumbnailUrl` is null until the worker has run, which is why the client is
// expected to render `thumbnailUrl ?? imageUrl`. That fallback is the contract that
// makes asynchronous thumbnailing invisible rather than broken.
const withViewUrls = async (post) => {
  const { imageKey, thumbnailKey, ...rest } = post;

  const [imageUrl, thumbnailUrl] = await Promise.all([
    createViewUrl(imageKey),
    thumbnailKey ? createViewUrl(thumbnailKey) : Promise.resolve(null),
  ]);

  return { ...rest, imageUrl, thumbnailUrl };
};

// One query for "which of these posts has this viewer liked", returning a Set of
// id strings. Strings because a Set of ObjectIds compares by object identity and
// would never match — the same trap connectionGraph.js's Map keys avoid.
const likedIdsForPage = async (page, userId) => {
  if (page.length === 0) return new Set();

  const likes = await Like.find(
    { postId: { $in: page.map((post) => post._id) }, userId },
    { postId: 1, _id: 0 }
  ).lean();

  return new Set(likes.map((like) => like.postId.toString()));
};

// "Can this viewer see a post by this author?" — self, or an accepted connection.
//
// Delegates to Phase 3's connectionGuard for the same reason as the profile route
// above: this is a question about ONE pair, and areConnected answers it with a
// single unique-index lookup instead of materialising the viewer's entire
// connection list to search it.
const canView = async (viewerId, authorId) =>
  viewerId.toString() === authorId.toString() ||
  (await areConnected(viewerId, authorId));

module.exports = postRouter;
