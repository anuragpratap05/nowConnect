const Redis = require("ioredis");

// Single shared ioredis client, mirroring the export shape of sesClient.js /
// razorpay.js. Reused by:
//   - the rate limiter (Phase 2)
//   - BullMQ queue + worker (Phase 1)
//   - the Socket.io Redis adapter (Phase 3)
//
// `maxRetriesPerRequest: null` is required by BullMQ's blocking commands.
// `lazyConnect: true` means we don't open a socket at import time, so simply
// requiring this module (e.g. during tests or when Redis isn't running yet)
// never throws — the connection is established on first command.
const redisClient = new Redis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

redisClient.on("error", (err) => {
  console.error("Redis client error:", err.message);
});

module.exports = redisClient;
