const membershipAmount = {
  silver: 300,
  gold: 700,
};

// Phase 2: daily swipe ceiling per membership tier, enforced by
// src/middlewares/rateLimiter.js. Kept beside membershipAmount deliberately —
// price and limit are two halves of the same product decision, so they should
// be impossible to change out of step with each other.
//
// `Infinity` for gold is not a sentinel the limiter has to decode: the limiter
// reads it, sees no finite ceiling, and skips Redis entirely for that tier — no
// counter, no round trip, no key. "Unlimited" costs nothing to enforce.
const swipeLimits = {
  free: 20,
  silver: 100,
  gold: Infinity,
};

module.exports = { membershipAmount, swipeLimits };
