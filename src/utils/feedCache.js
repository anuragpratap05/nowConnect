const redisClient = require("../config/redis");
const ConnectionRequest = require("../models/connectionRequest");

// Phase 2 — cached "hide from my feed" ID set.
//
// The problem it solves: GET /feed used to read EVERY connection request the
// user has ever been part of, on every single feed call, purely to build a list
// of ids to exclude. That read grows without bound for the life of the account
// — a heavy user with 5,000 swipes pays a 5,000-document read to render 10
// profiles, and it gets worse every time they swipe. The exclusion set is also
// the same on every page of the same scroll session, so we were recomputing an
// unchanged answer once per page.
//
// This is the fan-out-on-read vs fan-out-on-write trade-off. Fan-out-on-read
// (the old code) recomputes from source on every read: always fresh, cost
// scales with history. Fan-out-on-write maintains the answer incrementally as
// swipes happen: reads are O(set size) from memory, at the cost of keeping a
// derived copy correct. We take the second, with the source of truth still in
// Mongo so a wrong cache is always recoverable by dropping the key.
//
// Staleness is safe here BY CONSTRUCTION, and that's the part worth noticing:
// the worst a stale set can do is let an already-swiped profile reappear in the
// feed. If the user swipes it again, the canonical-pair unique index from item 0
// of this phase rejects the write and the route returns a clean 409. The
// concurrency fix is what makes this cache affordable to be eventually
// consistent — the two changes are load-bearing for each other.

// 10 minutes. The TTL is NOT the main freshness mechanism — addInteraction
// below keeps the set current as swipes happen, on both sides of the pair. What
// the TTL actually buys:
//   1. Memory reclamation. Without it, every user who ever loaded a feed keeps
//      a set in Redis forever, including accounts that never come back.
//   2. A backstop for changes the app never saw: the backfill script, a manual
//      DB fix, or an incremental SADD we dropped during a transient Redis error
//      (those are swallowed by design — see below).
const EXCLUSION_TTL_SECONDS = 10 * 60;

const exclusionKey = (userId) => `feed:excl:${userId}`;

// Add a member ONLY if the key already exists.
//
// This is the one genuinely dangerous edge in the whole cache. A plain SADD on
// a missing key CREATES it, with exactly one member — and that one-member set is
// indistinguishable from a fully-populated cache, so every later feed call would
// trust it and show the user profiles they have already swiped on, until the TTL
// expired. Guarding on EXISTS means a cold cache stays cold and gets built
// properly from Mongo on the next read.
redisClient.defineCommand("saddIfExists", {
  numberOfKeys: 1,
  lua: `
    if redis.call('EXISTS', KEYS[1]) == 1 then
      return redis.call('SADD', KEYS[1], ARGV[1])
    end
    return -1
  `,
});

// Rebuild from the source of truth.
//
// The requester's own id is always a member. That is not a detail — it's what
// makes a populated set never empty, which is the only way to tell "cache
// populated, this user has no interactions yet" apart from "cache missing"
// (SMEMBERS returns [] for both). It also folds the old separate
// `{_id: {$ne: loggedInUser._id}}` clause into the same $nin, so the feed query
// has one exclusion mechanism instead of two.
const computeExcludedIds = async (userId) => {
  const requests = await ConnectionRequest.find({
    $or: [{ fromUserId: userId }, { toUserId: userId }],
  })
    .select("fromUserId toUserId")
    .lean();

  const excluded = new Set([userId.toString()]);
  requests.forEach((request) => {
    excluded.add(request.fromUserId.toString());
    excluded.add(request.toUserId.toString());
  });

  return Array.from(excluded);
};

// Cache-aside read. Returns an array of id strings, always including userId.
//
// Fails open to Mongo: if Redis is unreachable the feed is still correct, just
// as expensive as it was before this phase. A cache outage must not become a
// feature outage.
const getExcludedIds = async (userId) => {
  const key = exclusionKey(userId);

  try {
    const cached = await redisClient.smembers(key);
    if (cached.length > 0) return cached;
  } catch (err) {
    console.error(
      `[feedCache] Redis read failed for user ${userId}, falling back to Mongo:`,
      err.message
    );
    return computeExcludedIds(userId);
  }

  const excluded = await computeExcludedIds(userId);

  try {
    // Pipeline so the populate is one round trip. A concurrent writer can only
    // ever SADD a member that belongs in the set anyway, so there's no
    // lost-update problem to solve with a transaction here.
    await redisClient
      .pipeline()
      .sadd(key, ...excluded)
      .expire(key, EXCLUSION_TTL_SECONDS)
      .exec();
  } catch (err) {
    // Populating the cache is an optimisation; failing to do it is not an error
    // the caller needs to know about. We already have the right answer.
    console.error(
      `[feedCache] Redis populate failed for user ${userId}:`,
      err.message
    );
  }

  return excluded;
};

// Fan-out-on-write: keep BOTH users' sets current when a request is created.
// Both sides matter — a swipe hides the target from the swiper's feed, and it
// also hides the swiper from the target's feed.
//
// Deliberately never throws. This runs after the connection request has already
// been durably written to Mongo; the request has succeeded, and a failure to
// update a derived cache must not turn a successful swipe into an error
// response. The TTL is the safety net.
const addInteraction = async (userIdA, userIdB) => {
  const a = userIdA.toString();
  const b = userIdB.toString();

  try {
    await Promise.all([
      redisClient.saddIfExists(exclusionKey(a), b),
      redisClient.saddIfExists(exclusionKey(b), a),
    ]);
  } catch (err) {
    console.error("[feedCache] failed to record interaction:", err.message);
  }
};

// Escape hatch for operators and for tests: drop a user's set and let the next
// feed call rebuild it from Mongo.
const invalidate = async (userId) => {
  try {
    await redisClient.del(exclusionKey(userId));
  } catch (err) {
    console.error(
      `[feedCache] failed to invalidate user ${userId}:`,
      err.message
    );
  }
};

module.exports = {
  getExcludedIds,
  addInteraction,
  invalidate,
  computeExcludedIds,
  exclusionKey,
  EXCLUSION_TTL_SECONDS,
};
