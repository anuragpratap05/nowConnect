const IORedis = require("ioredis");

// BullMQ needs a dedicated Redis connection whose `maxRetriesPerRequest` is
// null — its blocking commands (BRPOPLPUSH etc.) error otherwise. Per the
// Phase 0 decision (see docs/phase-0.md), BullMQ gets its OWN connections
// rather than reusing the shared client in src/config/redis.js, because its
// blocking/pub-sub semantics monopolise a connection.
//
// Returns a NEW connection on each call so a Queue and a Worker never share the
// same socket (BullMQ recommends distinct connections per instance).
const createRedisConnection = () =>
  new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
    maxRetriesPerRequest: null,
  });

module.exports = { createRedisConnection };
