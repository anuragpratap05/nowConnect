const { Queue } = require("bullmq");
const { createRedisConnection } = require("./connection");

const THUMBNAIL_QUEUE_NAME = "thumbnail";

// Phase 4 — image resizing, off the request path.
//
// This is the third consumer of the queue infrastructure Phase 1 built (email,
// payment, now thumbnails), and it is the one that best shows why that
// infrastructure was worth building rather than just calling SES inline: adding a
// whole new asynchronous workload here costs one queue file and one worker file,
// because the Redis connection factory, the retry policy shape, the worker
// process entrypoint and the failure-logging convention already exist.
//
// Why resizing must not be inline in POST /posts:
//   - It is CPU-bound, and Node is single-threaded. sharp releases the event loop
//     for its own decode/encode (it is native and uses libuv's threadpool), but
//     the default threadpool is 4 threads — so a handful of concurrent uploads
//     saturate it, and once it is saturated every other libuv consumer in the
//     process queues behind image resizing. That includes DNS lookups and file
//     I/O for requests that have nothing to do with posts.
//   - It requires downloading the full original from S3 into this process, which
//     is precisely the byte-shuffling the presigned-upload design exists to avoid.
//     Doing it inline would put the bytes back on the API instance, just one step
//     later in the flow.
//   - The user is waiting. A thumbnail is a bandwidth optimisation for OTHER
//     people's feed renders; making the author wait 2 seconds for it inverts who
//     pays the cost.
//
// The design that makes this safely deferrable is `thumbnailKey: null` being a
// valid, renderable state on Post (see src/models/post.js). The post is live the
// instant the row is written; the thumbnail improves it later. A queue backlog
// therefore degrades image weight, never availability — which is the property
// that distinguishes work that genuinely belongs on a queue from work that was
// merely moved onto one.
const thumbnailQueue = new Queue(THUMBNAIL_QUEUE_NAME, {
  connection: createRedisConnection(),
  defaultJobOptions: {
    // Fewer attempts than the email queue's 5, with a shorter base delay, because
    // the failure modes are different in kind. Email retries exist to ride out a
    // provider outage, which can last minutes. A thumbnail job fails either
    // because S3 blipped (retrying in seconds fixes it) or because the object is
    // not a decodable image (retrying NEVER fixes it — see the worker, which
    // marks that case non-retryable rather than burning attempts on it).
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

// data: { postId, imageKey }
//
// Both are passed even though postId alone would let the worker look up imageKey,
// which is deliberate: it saves a Mongo round trip per job, and it means a job is
// self-describing in the BullMQ UI when someone is debugging a failure. The
// worker still re-reads the post before writing, so the passed key is never
// trusted as the authority for the update.
const addThumbnailJob = (data) => thumbnailQueue.add("generate-thumbnail", data);

module.exports = { thumbnailQueue, addThumbnailJob, THUMBNAIL_QUEUE_NAME };
