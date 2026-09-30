const redisClient = require("../config/redis");
const { swipeLimits } = require("../utils/constants");

// Phase 2 — per-tier daily swipe limiter.
//
// Why Redis and not Mongo: the swipe endpoint is the hottest write path in the
// app, and a counter is the worst possible workload to put on the primary
// datastore — it's a read-modify-write on the same document, once per request,
// with contention concentrated on the heaviest users. Redis does INCR in
// memory, atomically, in one round trip; Mongo would need a document per user
// per day plus the write amplification of indexing it.
//
// Guards `POST /request/send/:status/:toUserId`. Must be mounted AFTER userAuth,
// since the key is derived from req.user.

// ---------------------------------------------------------------------------
// The atomic INCR + first-write-only EXPIRE.
//
// The subtle bug this avoids: doing INCR and EXPIRE as two separate commands
// leaves a window where the process dies (or the connection drops) after the
// INCR but before the EXPIRE. The key then has no TTL at all, so the user's
// counter never resets and they are locked out permanently — a limiter that
// fails into a ban.
//
// MULTI/EXEC closes that window but can't branch: inside a transaction you
// can't read the INCR result, so you'd have to EXPIRE unconditionally. With a
// relative TTL that slides the window forward on every request (under
// continuous traffic it never resets). A Lua script is the smallest thing that
// is both atomic and able to branch on the counter — set the TTL exactly once,
// on the request that created the key.
//
// Returns [count, ttl] so the caller can build accurate response headers
// without a second round trip.
redisClient.defineCommand("incrWithTtl", {
  numberOfKeys: 1,
  lua: `
    local count = redis.call('INCR', KEYS[1])
    if count == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    return {count, redis.call('TTL', KEYS[1])}
  `,
});

// Window boundaries are UTC, not server-local. Two API instances in different
// timezones (or one instance whose TZ changes on redeploy) would otherwise
// disagree about which day it is and hand the same user two separate buckets.
const utcDayKey = (date) => date.toISOString().slice(0, 10); // YYYY-MM-DD

// TTL runs to the end of the UTC day rather than a flat 86400s, so the counter
// expires exactly when its key becomes unreachable instead of lingering.
const secondsUntilUtcMidnight = (date) => {
  const midnight = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1
  );
  return Math.ceil((midnight - date.getTime()) / 1000);
};

// isPremium is the flag the payment webhook sets; membershipType is the tier it
// records. A premium user with an unrecognised membershipType is a data bug, and
// the two ways to resolve it are not symmetric: silently demoting a paying
// customer to the free tier is user-visible harm and a support ticket, whereas
// granting them the lowest PAID tier costs us a few extra swipes. We take the
// cheap error and log loudly.
const resolveTier = (user) => {
  if (!user.isPremium) return "free";

  const tier = (user.membershipType || "").toLowerCase();
  if (Object.prototype.hasOwnProperty.call(swipeLimits, tier) && tier !== "free") {
    return tier;
  }

  console.warn(
    `[rateLimiter] premium user ${user._id} has unrecognised membershipType ` +
      `"${user.membershipType}" — defaulting to silver limits`
  );
  return "silver";
};

const swipeRateLimiter = async (req, res, next) => {
  const user = req.user;
  const tier = resolveTier(user);
  const limit = swipeLimits[tier];

  // Unlimited tier: never touch Redis.
  if (!Number.isFinite(limit)) {
    res.set("X-RateLimit-Limit", "unlimited");
    return next();
  }

  const now = new Date();
  const key = `swipe:${user._id}:${utcDayKey(now)}`;

  let count;
  let ttl;

  try {
    [count, ttl] = await redisClient.incrWithTtl(
      key,
      secondsUntilUtcMidnight(now)
    );
  } catch (err) {
    // FAIL OPEN, deliberately. This limit protects against free-tier abuse of a
    // non-payment-critical action. If Redis is unreachable we have two ways to
    // be wrong: let some extra swipes through, or take the entire core feature
    // of the product offline for every user because a cache is down. The first
    // is a monetisation leak for the length of the outage; the second is an
    // outage. We log so the leak is visible and alertable.
    //
    // Note this is the OPPOSITE of the call made in Phase 1 for the payment
    // webhook, which fails closed — there, a lost enqueue means a payment we
    // took money for and never recorded. Same infrastructure, opposite default,
    // decided by what each path actually protects.
    console.error(
      `[rateLimiter] Redis unavailable, failing open for user ${user._id}:`,
      err.message
    );
    res.set("X-RateLimit-Bypass", "redis-unavailable");
    return next();
  }

  const resetAt = new Date(now.getTime() + ttl * 1000).toISOString();
  res.set("X-RateLimit-Limit", String(limit));
  res.set("X-RateLimit-Remaining", String(Math.max(0, limit - count)));
  res.set("X-RateLimit-Reset", resetAt);

  if (count > limit) {
    res.set("Retry-After", String(ttl));
    return res.status(429).json({
      message:
        `Daily swipe limit reached (${limit} on the ${tier} tier). ` +
        `Resets at ${resetAt}.`,
      tier,
      limit,
      resetAt,
    });
  }

  next();
};

module.exports = { swipeRateLimiter };
