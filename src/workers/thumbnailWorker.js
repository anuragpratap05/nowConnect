const { Worker, UnrecoverableError } = require("bullmq");
const sharp = require("sharp");

const { createRedisConnection } = require("../queues/connection");
const { THUMBNAIL_QUEUE_NAME } = require("../queues/thumbnailQueue");
const { buildThumbnailKey, getObjectBuffer, putObject } = require("../utils/postStorage");
const { thumbnailSize } = require("../utils/constants");
const Post = require("../models/post");

// Phase 4 — generates a display thumbnail for an uploaded post image.
//
// Pipeline: download the original from S3 -> resize with sharp -> upload the
// thumbnail -> point the Post row at it. Runs in the `npm run worker` process, so
// none of that decode/encode CPU or buffered image memory lands on an instance
// serving requests.
const thumbnailWorker = new Worker(
  THUMBNAIL_QUEUE_NAME,
  async (job) => {
    const { postId, imageKey } = job.data;

    if (!postId || !imageKey) {
      // Non-retryable by construction: no amount of waiting adds the missing
      // field. UnrecoverableError tells BullMQ to fail the job immediately
      // instead of spending its remaining attempts (and their backoff delays)
      // re-proving that a malformed job is malformed.
      throw new UnrecoverableError("thumbnail job missing postId or imageKey");
    }

    // Read the post FIRST, and treat a missing one as success-by-vacancy.
    //
    // The race this handles is real and ordinary: a user posts and then deletes
    // within the couple of seconds the job sits in the queue. Without this the
    // worker would generate a thumbnail for a post that no longer exists, upload
    // it (orphaning an object nothing will ever reference or clean up), and then
    // fail its Mongo update — burning all three attempts on a job that is
    // correctly done by virtue of there being nothing to do.
    const post = await Post.findById(postId).select("_id imageKey thumbnailKey");
    if (!post) {
      return { skipped: "post-deleted" };
    }

    // Already done. Makes the job IDEMPOTENT, which matters because BullMQ (like
    // every at-least-once queue) can deliver the same job twice — a worker that
    // dies after uploading but before acking will have its job redelivered. Both
    // deliveries would compute the same thumbnail key and produce the same bytes,
    // so a duplicate is harmless rather than wrong; this check just makes it free.
    if (post.thumbnailKey) {
      return { skipped: "already-generated" };
    }

    const original = await getObjectBuffer(imageKey);

    let thumbnail;
    try {
      thumbnail = await sharp(original)
        // fit: "inside" scales to fit the box preserving aspect ratio;
        // withoutEnlargement means an image already smaller than 400px is left at
        // its own size rather than being upscaled into a blurrier, LARGER file.
        .resize({
          width: thumbnailSize.width,
          height: thumbnailSize.height,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 80 })
        .toBuffer();
    } catch (err) {
      // THIS is where "is it actually an image?" is finally answered.
      //
      // Nothing earlier in the flow can answer it. The presigned URL pins a
      // declared Content-Type into the signature and the claim-time HeadObject
      // reads that same declared value back — both are the client's claim about
      // the bytes, not a fact about them. sharp is the first thing that parses the
      // real container, so a renamed PDF, a text file, or a truncated upload fails
      // exactly here and nowhere before.
      //
      // Non-retryable: bytes that are not an image now will not be an image in
      // four seconds. The post itself is deliberately left ALIVE with a null
      // thumbnailKey — the object store holds whatever the client sent, the
      // client's own <img> render will fail on it, and quarantining or deleting
      // user content on a decode failure is a moderation decision, not something
      // a resize worker should make unilaterally.
      throw new UnrecoverableError(
        `not a decodable image (${imageKey}): ${err.message}`
      );
    }

    const thumbnailKey = buildThumbnailKey(imageKey);
    await putObject(thumbnailKey, thumbnail, "image/webp");

    // Write the pointer LAST, after the bytes are durably in the object store.
    //
    // Ordering is the whole correctness argument here, and it is the same
    // reasoning as the Phase 3 decision to write a Message before updating
    // Chat.lastMessageAt. There is no transaction across S3 and Mongo, so one of
    // the two writes can land without the other, and the ordering decides which
    // inconsistency is possible:
    //   - bytes then pointer (this order): a crash in between leaves an unreferenced
    //     thumbnail object. Invisible to users, costs a few KB, and the next run of
    //     the job recomputes the SAME key and overwrites it.
    //   - pointer then bytes: a crash in between leaves a Post claiming a thumbnail
    //     that does not exist, so every viewer's feed renders a broken image.
    // Wasted bytes are always preferable to a dangling reference.
    //
    // Guarded on `thumbnailKey: null` so two concurrent deliveries of the same job
    // cannot both write — the second matches nothing, and that is reported honestly
    // as a skip rather than as a success that did nothing.
    const updated = await Post.updateOne(
      { _id: postId, thumbnailKey: null },
      { $set: { thumbnailKey } }
    );

    if (updated.matchedCount === 0) {
      return { skipped: "raced", thumbnailKey };
    }

    return { thumbnailKey, bytes: thumbnail.length };
  },
  {
    connection: createRedisConnection(),
    // Lower than the email worker's 5. Email jobs are almost entirely network
    // wait, so high concurrency costs nothing; thumbnail jobs are CPU- and
    // memory-bound, and sharp's native work runs on libuv's threadpool (4 threads
    // by default). Requesting more concurrency than that just queues jobs inside
    // the process while holding each one's image buffer in memory — more resident
    // memory for no more throughput.
    concurrency: 3,
  }
);

thumbnailWorker.on("completed", (job, result) => {
  console.log(
    `[thumbnailWorker] job ${job.id} post ${job.data.postId} -> ` +
      (result?.thumbnailKey
        ? `${result.thumbnailKey} (${result.bytes} bytes)`
        : `skipped: ${result?.skipped}`)
  );
});

thumbnailWorker.on("failed", (job, err) => {
  console.error(
    `[thumbnailWorker] job ${job?.id} post ${job?.data?.postId} failed ` +
      `(attempt ${job?.attemptsMade}/${job?.opts?.attempts}): ${err.message}`
  );
});

module.exports = thumbnailWorker;
