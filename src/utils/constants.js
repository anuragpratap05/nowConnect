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

// Phase 4: upload constraints for the presigned-URL post flow.
//
// Here rather than in src/utils/postStorage.js because these are PRODUCT limits,
// not storage-client configuration — the same reason swipeLimits sits beside
// membershipAmount above. They are also enforced in two different places for two
// different reasons, and a single shared constant is what keeps those two in step:
//
//   - MAX_IMAGE_BYTES is checked by POST /posts (via a HeadObject on the uploaded
//     object) because a presigned PUT URL CANNOT carry a size cap — see
//     src/utils/postStorage.js for why, it is the most interesting limitation in
//     this whole flow.
//   - ALLOWED_IMAGE_TYPES is pinned into the signature at sign time, so an upload
//     declaring any other type is rejected by the object store itself before a
//     byte of it reaches us.
//
// 5MB is a phone-camera JPEG with headroom, and it is deliberately the number the
// client is told (GET /posts/upload-url returns it) so the UI can reject an
// oversized file before spending the user's bandwidth on an upload that the claim
// step would then refuse.
const postUploadLimits = {
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  ALLOWED_IMAGE_TYPES: ["image/jpeg", "image/png", "image/webp"],
  // How long a presigned URL stays valid. Short on purpose: the URL is a bearer
  // credential for writing to our bucket, so its lifetime is the window in which a
  // leaked one is useful. Five minutes is far longer than the round trip it exists
  // for (client gets URL, client PUTs the file) and far shorter than anything
  // worth stealing.
  UPLOAD_URL_TTL_SECONDS: 5 * 60,
  // Read URLs live longer than upload URLs because they are embedded in a rendered
  // feed the user may sit on. Still finite — that is the entire reason the bucket
  // can stay private. See src/utils/postStorage.js.
  VIEW_URL_TTL_SECONDS: 60 * 60,
};

// Thumbnail geometry, used by src/workers/thumbnailWorker.js. `fit: "inside"`
// semantics — the image is scaled to fit inside this box, preserving aspect ratio,
// never cropped and never enlarged.
const thumbnailSize = { width: 400, height: 400 };

module.exports = {
  membershipAmount,
  swipeLimits,
  postUploadLimits,
  thumbnailSize,
};
