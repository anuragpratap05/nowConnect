# Phase 4 — Posts with images (presigned uploads, connection-scoped feed, async thumbnails)

**Talking point:** "Uploads go straight from the client to object storage via a
presigned URL — the backend never proxies image bytes, so an upload costs us the
same whether it's 50KB or 5MB. The interesting part was everything that falls out
of that decision: 'upload' stops being one atomic operation and becomes three
steps across two systems, and each seam needed its own guard. A presigned PUT
can't cap object size, so size is enforced after the fact with a metadata-only
HeadObject that deletes the object if it's oversized. It also turned out that the
Content-Type we thought we were pinning wasn't in the signature at all until we
explicitly signed it. Thumbnails are generated on a background worker, which is
only safe because a missing thumbnail is a valid state. And while indexing the
feed's access pattern we found a second full collection scan on our
fastest-growing collection — this one on a user-facing route."

Five changes, ordered by dependency:

| # | Change | Why it had to come in this order |
|---|--------|----------------------------------|
| 0 | `Post` + `Like` schemas | The storage shape decides everything downstream; the embedded-array lesson from Phase 3 gets applied *before* it bites this time |
| 1 | Presigned upload flow | The core design decision, and the source of every edge case in items 2–3 |
| 2 | Connection-scoped cursor feed | Needs the schema and the upload flow to exist before there is anything to page through |
| 3 | The `$or` COLLSCAN fix (not in the plan) | Found *because* the feed needed the connection list on a hot read path |
| 4 | Async thumbnails (BullMQ + sharp) | Reuses Phase 1's queue infra; last because the post must be complete without it |

Two things surfaced that were not in the plan: a **second full collection scan on
`ConnectionRequest`**, on a user-facing route this time rather than a cron, and
the discovery that **`ContentType` on a presigned PUT is not enforced by default**
— our own upload URLs accepted a mismatched Content-Type until this phase signed
the header explicitly. Both are covered below.

---

## Item 0 — `Post` and `Like`: applying the Phase 3 lesson before it bites

### Problem

Phase 3 spent an entire phase undoing an embedded array: `Chat.messages[]` had a
hard 16MB ceiling, rewrote the whole document on every append, and couldn't be
paginated. Posts arrive with the same two temptations — `Post.likes[]` (an array
of liker ids) and image bytes in the document — and the naive version of both is
what a tutorial would write.

### Decision

Neither goes in the document.

**Likes are their own collection** (`src/models/like.js`) with a unique compound
index on `{postId, userId}`. The failure modes of `likes: [ObjectId]` are the chat
array's, with one addition:

| | Embedded `likes[]` | Separate `Like` collection |
|---|---|---|
| Growth ceiling | ~1.3M likes = 16MB, then the post is permanently unlikeable | none |
| Cost of one like | rewrite + re-replicate + re-oplog the whole document | one small insert |
| Which document | the **hottest** one in the system — the same one every feed read fetches | an unrelated collection |
| "Did I like this?" | pull the entire array over the wire | one point lookup |
| Paginate likers | impossible | index range scan |
| Idempotency | `$addToSet` works, but is a server-side linear scan of the array, and cannot be made atomic with a counter | free, from the unique index |

That last row is the one worth noticing: the unique index doesn't just *prevent*
duplicates, it *removes the need for application code to check for them*. See
item 4 below.

**Image bytes are a key, not a blob and not a URL.** Mongo stores an 80-byte
key; the object store stores the 3MB JPEG. A key rather than a URL because a URL
bakes in the bucket, region, endpoint and access scheme — and our read URLs are
short-lived presigned GETs, so a stored URL would be both stale within the hour
*and* wrong in the other environment (MinIO locally, real S3 in production, per
Phase 0's "one env var, no code branch" rule). The key is the stable identity;
the URL is derived at read time.

### The one denormalised field

`Post.likeCount`, maintained with `$inc`. Storing a derivable number is a
deliberate exception, justified by the read:write ratio: the count is read on
every feed impression and written once per like — hundreds to one. Without it, a
10-post page means 10 `countDocuments` calls, and the cost grows with page size.

Stated honestly, it is a second source of truth and it *can* drift: there is no
transaction between the `Like` insert and the `$inc`, so a process death in that
window loses one increment. The blast radius is a count that reads 41 instead of
42, and `Like` remains the source of truth to recompute from. That is the right
trade for a social counter; it would not be for a balance.

---

## Item 1 — Presigned uploads (Problem → Options → Decision → Outcome)

### Problem

The obvious implementation of "upload a photo" is `multipart/form-data` to an
Express route (multer), which buffers the file and forwards it to S3. It works,
and it is wrong at any scale — but "it's slow" is not a good enough reason, so
precisely:

1. **Every byte travels twice.** Client → us → S3. A 5MB post costs 5MB of
   ingress *and* 5MB of egress on our instance, and the user waits for both hops
   serially.
2. **It holds an event-loop-bound process hostage.** Node is single-threaded. A
   request spending 8 seconds streaming a photo over a phone's uplink is 8
   seconds of a connection, a request slot and buffer memory held open. A few
   hundred concurrent uploaders on bad connections is ordinary traffic, and it is
   enough to starve every other route on the instance — **the API gets slow for
   people who aren't uploading anything.**
3. **Memory scales with concurrency × file size**, so the failure mode under an
   upload spike is an OOM kill.
4. **A request timeout sits between the user and a successful upload.** Every
   layer in front of us has one, and slow mobile uploads are exactly the requests
   that hit it.

### Options considered

| Option | Verdict |
|---|---|
| Multipart through the API (multer) | Rejected — all four problems above |
| Presigned **PUT** URL | **Chosen.** One-line client upload; cannot cap size (see item 2) |
| Presigned **POST** policy | More correct on size (`content-length-range` enforced by S3 *before* storing), but adds a dependency and turns a one-line `fetch` into a multipart form with a dozen policy fields. Documented as the upgrade path |
| Upload through a CDN / API gateway with a body-size limit | Solves size, doesn't solve the double hop; also infrastructure rather than application code |

### Decision

Three steps, two of which carry no payload:

```
1. POST /posts/upload-url  { contentType }        -> { key, url, expiresIn, maxBytes }
2. PUT  <url>              <the image bytes>      -> client → object storage, DIRECT
3. POST /posts             { imageKey, caption }  -> the Post row  ("the claim")
```

Step 2 does not touch the API. Our involvement is two small JSON requests, so an
upload's cost to us is **constant regardless of image size**.

The price is that upload is no longer atomic, and every seam needs a guard:

**The key carries the ownership claim.** Step 1 always builds
`posts/<authenticated userId>/<16 random bytes>.<ext>` — the user never
influences the prefix. So step 3's authorization check is one line:

```js
if (!imageKey.startsWith(`posts/${userId}/`)) return res.status(403)...
```

Without it, `imageKey` is an attacker-controlled request body field and a user
could claim **any** key in the bucket, publishing someone else's private photo as
their own post. This is also why the key is *structured and server-generated*
rather than opaque randomness: the structure carries the claim, so verifying it
needs no separate "pending uploads" table. It incidentally neutralises path
traversal (`posts/../../etc/passwd` fails the same check).

**The user id is a prefix, not a suffix.** S3 has no directories; a key prefix is
the only grouping primitive that IAM policies, lifecycle rules and bulk deletes
can address. "Delete everything this user uploaded" — a GDPR erasure, or cleaning
up a banned account — is a prefix operation with this layout and a full-bucket
listing without it.

**The filename is never the client's.** A client-supplied filename is a path
traversal vector, a collision risk (every phone calls it `IMG_0001.jpg`), and an
information leak. 16 random bytes also make keys unguessable, which matters
because the key is part of the read URL.

### Reads are signed too

The bucket stays **private**; `imageUrl` and `thumbnailUrl` are presigned GETs
with a 1-hour TTL, minted only after the API has checked that this viewer is
allowed to see this post. Raw keys are stripped from every response.

A public bucket would be cheaper to render, but posts are visible only to the
author's accepted connections — and a public object URL is readable by anyone who
has it, forever. The access rule would then hold in the API and not in the
storage layer, so one leaked or shared URL bypasses the connection graph
entirely. **An access control that only one of two doors enforces is not an
access control.**

The cost, stated plainly: per-viewer, time-bound URLs are not shared-cacheable by
a CDN the way a stable public URL would be. The production answer is CloudFront
with an origin access identity or signed cookies — same private-bucket property,
cached at the edge. That is infrastructure configuration, not application code:
nothing in `src/utils/postStorage.js` would change.

---

## Item 2 — Two things a presigned PUT cannot do

This is the most interesting part of the phase, because both were discovered by
trying to violate the constraints rather than by reading documentation.

### 2a. It cannot cap object size

Size is not known at signing time, and there is no signable header that bounds it
(`ContentLength` in the signed command would pin it to one *exact* value, which a
client cannot know before choosing a file). So a presigned PUT URL is, for its
lifetime, **permission to write an object of any size to that key.**

Verified rather than assumed: a 24.7MB file PUT against a URL issued under a 5MB
policy returned **200**, and the object landed in the bucket at
`present (24733712 bytes)`.

Three ways to handle it:

| | Approach | Verdict |
|---|---|---|
| a | Presigned POST with `content-length-range` | The only option that rejects oversized bytes **before storing**. The correct answer if uploads were untrusted or unmetered; adds a dependency |
| b | Trust the client's pre-upload size check | Not a control — the client is what we're protecting the bucket from |
| c | **Verify at claim time with `HeadObject`, refuse, and delete** | **Chosen** |

`HeadObject` returns metadata only — no body transfer — so checking a 5MB
upload's size does not cost 5MB. That is what makes post-hoc verification viable
at all. `POST /posts` then answers `413` **and deletes the object**, which is the
part that matters: without the delete, `/posts/upload-url` is free unlimited
storage for anyone with an account (upload oversized objects, never claim them).

The residual exposure, stated honestly: the bytes were already transferred and
stored before we noticed, so this protects against an oversized object becoming a
*servable post*, not against the bandwidth. Given a 5-minute URL TTL, issued only
to an authenticated user, for a key only they can write, that is one oversized
object per deliberate attempt. Acceptable; (a) is the upgrade path.

`maxBytes` is echoed to the client in step 1 so the UI can reject a large file
before spending the user's bandwidth — a UX affordance, explicitly *not* the
control.

### 2b. It was not enforcing Content-Type at all

Passing `ContentType` to `PutObjectCommand` looks like it constrains the upload.
**It does not.** By default the presigner signs only the `host` header — the URL
comes back with `X-Amz-SignedHeaders=host` — so the Content-Type is simply absent
from the signature.

Verified against MinIO:

```
URL signed for image/jpeg, uploaded with "Content-Type: text/plain"  ->  200
HeadObject on the resulting key                                      ->  text/plain
```

The type we thought we were pinning was decoration. The fix is one option:

```js
getSignedUrl(s3Client, new PutObjectCommand({...}), {
  expiresIn: ...,
  signableHeaders: new Set(["content-type"]),   // <- X-Amz-SignedHeaders=content-type;host
});
```

Re-verified after the fix: matching Content-Type → `200`, mismatched → **`403
SignatureDoesNotMatch`**, refused by the object store before the bytes are
stored.

This also promoted the claim-time Content-Type re-check from belt-and-braces to
load-bearing-then-redundant: before the fix it was the *only* thing standing
between a mislabelled upload and a post. It is deliberately kept, because it is
what would catch a signing change that silently stops pinning the header again —
exactly the regression that is otherwise invisible.

### 2c. And it cannot tell you the bytes are an image

Both of the above bind the **label**, not the content. A client can send
`Content-Type: image/jpeg` with any bytes it likes, and `HeadObject` only ever
returns the claim.

Nothing short of parsing the bytes can answer it — and that check does happen,
just not on the request path: the thumbnail worker opens every uploaded object
with `sharp`, which parses the real container. A renamed PDF, a text file or a
truncated upload fails exactly there (item 4).

### Orphaned objects

The seam between step 1 and step 3 means a client can get a URL, upload, and
never claim. Those objects are unreferenced and nothing cleans them up
synchronously, by design — the alternative is a "pending uploads" table that
needs its own reaping.

The systematic answer is an **S3 lifecycle rule**: expire objects under `posts/`
older than N days that no `Post` references. In practice the cheap version is a
lifecycle rule on a dedicated `pending/` prefix with a claim-time copy, or a
periodic reconciliation job that lists the bucket and diffs against the `Post`
collection. Not implemented in this phase — it is bucket configuration plus a
scheduled job, and the storage cost of an unclaimed 5MB object is a rounding
error at this scale. Named here because "what happens to the objects nobody
claims?" is the obvious follow-up to this design, and "nothing, and that's a
known gap with a known fix" is a better answer than not having thought about it.

---

## Item 3 — The connection-scoped feed, and the `$or` COLLSCAN it uncovered

### The feed: fan-out on read, chosen knowingly

`GET /posts/feed` reads the requester's accepted-connection ids, then asks for the
newest posts by anyone in that set. **The timeline is computed at read time.**

The alternative is fan-out on write: materialise a timeline per user, and push
each new post's id into all of the author's connections' timelines.

| | Fan-out on read (chosen) | Fan-out on write |
|---|---|---|
| Write cost | one insert | N inserts per post |
| Read cost | `$in` over N authors, merge-sorted | one contiguous range scan |
| Extra state | none | a materialised copy per user, to keep correct |
| Breaks when | one **reader** follows tens of thousands of authors | one **author** has millions of followers (the celebrity problem) |

Read-time is right *for this app*, for a reason specific to it rather than a
general preference: **connections here are mutual and require an accepted
request**, so the fan-out is bounded in the hundreds. You cannot have 50,000
accepted mutual connections without it being absurd socially. That is exactly why
read-time is safe here and would not be on Twitter, where follows are one-way and
unbounded. At that scale the real answer is hybrid — fan-out on write for
ordinary accounts, read-time merge for the few high-fan-out ones.

### The index, and why the obvious claim about it was wrong

`{userId: 1, _id: -1}` lets MongoDB open one index scan per `$in` value, position
each directly at the cursor, and `SORT_MERGE` the streams — fetching only the
documents the page returns.

But the naive claim ("this index makes the feed fast") turned out to be
**conditional**, and the condition is the interesting part. Without the index the
query is *not* a COLLSCAN: MongoDB can walk the default `_id` index descending —
which already satisfies both the sort and the cursor — and filter by `userId`.
Whether that is cheaper depends entirely on **what fraction of all authors the
viewer follows**, because that fraction is the filter's hit rate.

Measured at 50,000 posts, one 10-post page (`totalDocsExamined`):

| Graph density | `_id`-walk plan | `{userId,_id}` merge plan |
|---|---|---|
| 120 of **400** authors (30%) | keys 36, **docs 36**, 0ms | keys 130, **docs 11**, 14ms |
| 120 of **20,000** authors (0.6%) | keys 2525, **docs 2525**, 10ms | keys 119, **docs 11**, 6ms |

In a dense graph the `_id` walk wins outright — it finds 11 matching posts within
36 documents, while the merge pays to open and coordinate 121 index cursors. In a
realistically sparse graph it must examine **2,525 documents to fill one page**,
because 99.4% of what it walks past belongs to someone the viewer doesn't follow
— and that number grows with the user base while the merge's stays at 11.

So the index is there for the regime the app is heading into, not the one a small
test database is in. **The metric to watch is `docsExamined`, not wall-clock:** at
50k documents everything is in cache and the timings are noise, but a fetched
document is a potential random read, and 2,525 per page is what falls off a cliff
once the collection outgrows RAM.

One honest wrinkle, worth knowing before an interviewer finds it: in the **dense**
regime MongoDB's planner picks the merge anyway and is measurably slower for it
(14ms vs 0ms) — its cost model undercounts the overhead of coordinating 121
cursors. The lever would be `.hint()`, deliberately not used: hinting pins a plan
that stops adapting when the distribution changes, and the distribution is moving
toward the regime where the merge is correct.

### Cursor, not skip — same convention as chat

`_id < cursor`, sorted descending: a feed opens at the newest post and pages into
the past. `_id` is the cursor rather than `createdAt` for the reason established
in Phase 3 — `createdAt` is millisecond-precision and **not unique**, so a cursor
built on it silently drops or duplicates rows at page boundaries. This is the
third place in the codebase using that one convention, which is the point of
having one.

Measured at 50,000 posts, page 40 of 10:

| | `totalKeysExamined` |
|---|---|
| cursor (`_id < ...`) | **37** |
| `.skip(390)` | **520** |

### The `$or` COLLSCAN (not in the plan)

The feed needs "the ids of everyone I'm accepted-connected to" on every page.
That list comes from the same `$or` that `GET /user/connections` has always run:

```js
{$or: [{fromUserId: me, status: "accepted"},
       {toUserId:   me, status: "accepted"}]}
```

`.explain()` on it returned **`SUBPLAN → COLLSCAN`, `totalKeysExamined: 0`,
`totalDocsExamined: 8000`.** A full scan of `ConnectionRequest` — the
fastest-growing collection in the system, and the same collection Phase 1 fixed a
COLLSCAN on. This one is worse in one specific way: **Phase 1's was a daily cron
off the request path; this is a user-facing route, synchronous, on every call.**

**Why it scanned even though `{fromUserId, toUserId}` existed and could serve the
first branch** — this is the non-obvious part, and it's the bit worth being able
to explain: MongoDB's `$or` subplanner needs an indexed plan for **every** branch.
If even one branch has no usable index, it abandons index selection for the whole
`$or` and scans once, which is cheaper than scanning once per branch. **A
half-indexed `$or` performs exactly like an unindexed one — there is no partial
credit.** Proven by adding only the `fromUserId` index and re-running:

| | Winning plan | keysExamined | docsExamined |
|---|---|---|---|
| Before | `SUBPLAN → COLLSCAN` | 0 | 8000 |
| Only `{fromUserId, status, toUserId}` | `SUBPLAN → COLLSCAN` | 0 | **8000 (unchanged)** |
| Both indexes | `OR → IXSCAN` | 126 | **0** |

So the fix has to be two indexes, one per direction:

```js
connectionRequestSchema.index({ fromUserId: 1, status: 1, toUserId: 1 });
connectionRequestSchema.index({ toUserId: 1, status: 1, fromUserId: 1 });
```

The **trailing field is chosen for coverage**: both pair fields and `status` are
equality predicates, and the trailing one is the only other field the projection
asks for, so with `{_id: 0}` MongoDB answers entirely from index keys —
`totalDocsExamined: 0`, `keysExamined` exactly equal to `nReturned`. Same
covered-query technique as the Phase 1 cron fix, applied to a read path. One
field in a projection is the difference: include `_id` and the query stops being
covered.

These also incidentally fix `GET /user/requests/received`
(`{toUserId, status: "interested"}`), which was scanning for the same reason.

**Why a connection is stored directionally at all**, since that's what forces the
`$or`: there is no "accepted connections" edge list. The request document *is* the
edge, and its direction is a historical artifact of who swiped first, not a
property of the relationship. So "my connections" always has to look both ways.

### One shared query, two callers

The `$or` now lives in `src/utils/connectionGraph.js`, shared by the connections
route and the posts feed. Two copies of a graph traversal drift — one gets the
index-friendly rewrite, one doesn't; one remembers the relationship is
bidirectional, one forgets. Same argument as Phase 3's shared `connectionGuard`,
and the two are complementary:

| | Question | Cost |
|---|---|---|
| `connectionGuard.areConnected(a, b)` | "are these two connected?" (one pair) | one point lookup on the unique `{userIdLow, userIdHigh}` index |
| `connectionGraph.getAcceptedConnectionIds(me)` | "who am I connected to?" (one-to-many) | one covered index read, proportional to the answer |

The pairwise routes (`GET /posts/user/:userId`, the like authorization) use
`areConnected`, **not** the list — materialising N connections to answer a
question about one of them would be the wrong tool.

### Why this one is NOT cached, when the feed's exclusion set is

The obvious follow-up, so it's written down. Phase 2 cached the feed's exclusion
set in Redis because that query's cost was proportional to the user's **entire
interaction history** — every swipe ever, re-read on every page, growing without
bound, to produce a list identical on every page of one scroll session. Caching
converted an unbounded read into a bounded one.

This query has no such gap. After the indexes its cost is proportional to the
number of accepted connections — the size of the answer itself, so there is
nothing to amortise — and it reads index keys only. A cache would buy one avoided
round trip and cost a second source of truth needing invalidation on every
accept, un-accept and account deletion. Those are exactly the paths where a stale
connection list stops being a performance detail and **becomes a privacy bug**:
the posts feed uses this list as its access-control boundary, so a stale entry
means showing a removed connection's posts.

**The rule: cache to fix an access pattern whose cost is unbounded, not to shave a
millisecond off one that is already proportional to its result.** An index was the
right fix here; a cache was the right fix there.

---

## Item 4 — Idempotent likes, and a counter that can't lose updates

Neither the like nor the unlike handler contains a "have they already liked it?"
check. That is the payoff of the unique `{postId, userId}` index.

```js
try { await Like.create({ postId, userId }); }
catch (err) { if (err.code === 11000) { /* already liked — 200, not an error */ } }
```

The alternative — `findOne`, then branch — is **check-then-act**, the exact bug
Phase 2 fixed on swipes and Phase 3 fixed on `Chat` creation. Two concurrent
likes (a double-tapped heart sends two requests) both pass the check and both
insert; one gets a 500 the user did nothing to deserve, and if the counter is
`$inc`'d alongside it, the count ends up wrong in a way no later request
corrects.

**`$inc`, never read-modify-write.** `post.likeCount += 1; post.save()` is a lost
update: two likers both read 5, both write 6, one like vanishes. `$inc` is applied
atomically on the server, so N concurrent increments always sum to N.

**The counter is only touched when the insert actually succeeded** — the duplicate
path returns before the `$inc`, so a retried like cannot inflate it. The unlike's
`$inc: -1` is guarded on `{likeCount: {$gt: 0}}` so the count can never go
negative even if it has already drifted.

**`likedByMe` for a whole page is one query, not one per post.** A 10-post page
would otherwise be 10 extra round trips, getting worse with page size. One `$in`
over the page's ids, served by the unique index, answers all of them — and because
the index contains both fields the projection needs, it's covered
(`PROJECTION_COVERED → IXSCAN`, `docsExamined: 0`).

**Asymmetric authorization, deliberately.** Liking requires an accepted connection
(post ids are handed out in feed responses and are guessable ObjectIds, so without
it strangers could like and inflate posts they were never permitted to view).
Unliking does **not** — it only removes a row you created yourself, and gating it
would strand the row and leave the counter permanently inflated if you were
disconnected in between. The rule: **authorize the action that creates state, not
the action that withdraws your own.**

---

## Item 5 — Async thumbnails (BullMQ + sharp)

Third consumer of the queue infrastructure Phase 1 built, and the one that best
shows why building it was worth it: a whole new asynchronous workload costs one
queue file and one worker file, because the Redis connection factory, the retry
policy shape, the worker entrypoint and the failure-logging convention already
exist.

### Why resizing must not be inline

- **CPU-bound, and Node is single-threaded.** sharp is native and uses libuv's
  threadpool — **4 threads by default** — so a handful of concurrent uploads
  saturates it, and then *every other libuv consumer in the process queues behind
  image resizing*, including DNS lookups and file I/O for requests that have
  nothing to do with posts.
- **It would put the bytes back on the API instance**, one step later in the flow
  — undoing the entire point of the presigned upload.
- **The user is waiting.** A thumbnail is a bandwidth optimisation for *other
  people's* feed renders. Making the author wait 2 seconds for it inverts who pays.

### What makes it safely deferrable

`thumbnailKey: null` is a **valid, renderable state**. The post is complete the
instant the row is written; clients render `thumbnailUrl ?? imageUrl`. So a queue
backlog, a crashed worker, or Redis being down degrades **image weight, never
availability**.

That property is the actual test of whether work belongs on a queue, as opposed to
having merely been moved onto one. Had `thumbnailKey` been `required`, the resize
would have to happen inline and the upload would be exactly as slow as the
slowest image. The enqueue is also wrapped in its own try/catch after the post is
durably written — Redis being down must not turn a successful post into a 500.

### Ordering: bytes before pointer

There is no transaction across S3 and Mongo, so one write can land without the
other, and the **ordering decides which inconsistency is possible**:

| Order | Crash in between leaves |
|---|---|
| **bytes then pointer** (chosen) | an unreferenced thumbnail object — invisible, a few KB, and the next run recomputes the *same* key and overwrites it |
| pointer then bytes | a `Post` claiming a thumbnail that doesn't exist — **every viewer's feed renders a broken image** |

Wasted bytes are always preferable to a dangling reference. Same reasoning as
Phase 3's "write the `Message` before updating `Chat.lastMessageAt`".

The thumbnail key is **derived** from the original's
(`posts/<u>/<id>.jpg` → `thumbs/<u>/<id>.webp`) rather than independently random,
which is what makes retries idempotent: the key it computes is the key it
computed last time. A random key would orphan the previous attempt's object on
every retry. It also makes the pair self-describing in the bucket, so a backfill
for posts whose `thumbnailKey` is still null can be driven entirely from the
`Post` collection.

### Retry policy, and what must not be retried

`attempts: 3`, base delay 2s — fewer and shorter than the email queue's 5 × 5s,
because the failure modes differ in **kind**. Email retries ride out a provider
outage, which lasts minutes. A thumbnail job fails either because S3 blipped
(seconds fixes it) or because **the object is not a decodable image, which
retrying never fixes**. Those are separated with `UnrecoverableError`, so a
malformed job fails immediately instead of burning three attempts and two backoff
delays re-proving that a PDF is not a JPEG.

A decode failure deliberately **leaves the post alive** with a null
`thumbnailKey`. Quarantining or deleting user content on a decode failure is a
moderation decision, not something a resize worker should make unilaterally.

`concurrency: 3`, against the email worker's 5: email jobs are almost entirely
network wait so high concurrency is free, while thumbnail jobs hold a
multi-megabyte buffer and saturate a 4-thread pool. Requesting more concurrency
than the pool has just queues jobs inside the process while holding their image
buffers resident — more memory for no more throughput.

### Idempotency against at-least-once delivery

BullMQ, like every at-least-once queue, can deliver a job twice (a worker that
dies after uploading but before acking has its job redelivered). Three guards, in
order:

1. **Post missing → success-by-vacancy.** A user who posts and deletes within the
   couple of seconds the job is queued would otherwise have the worker generate
   and upload a thumbnail for a nonexistent post — orphaning an object — and then
   burn all three attempts failing the Mongo update.
2. **`thumbnailKey` already set → skip.** Both deliveries compute the same key and
   the same bytes, so a duplicate is harmless; this makes it free.
3. **The update is guarded on `{thumbnailKey: null}`**, so two concurrent
   deliveries cannot both write — the loser matches nothing and reports a skip
   rather than a success that did nothing.

---

## Verification

Everything below was run **live** against the running app: the real API on
`:7777`, the real worker process, real MongoDB, and the real MinIO bucket
`now-connect-posts`. Query plans were measured in a throwaway database that was
dropped afterwards (same approach as Phase 1 — no real data touched).

Seeded users: `elon.musk@example.com` (connected to `user1`, `virat`, `barack`)
and `narendra.modi@example.com` (**not** connected to Elon) — the negative case.

### Item 1 — the presigned upload flow, end to end

```
POST /posts/upload-url  { contentType: "image/jpeg" }
  key:       posts/6ab915224cfec1fa9966e73a/bd0e...9a.jpg
  expiresIn: 300 s
  maxBytes:  5242880
  url base:  http://localhost:9000/now-connect-posts/posts/6ab91.../bd0e...9a.jpg
  X-Amz-SignedHeaders = content-type;host

PUT <url>  (1600x1200 JPEG, 44710 bytes, direct to MinIO)   -> 200
POST /posts { imageKey, caption }                           -> 201 "Post created"
  thumbnailUrl: null          <- worker hasn't run yet, and that's a valid state
  imageKey field in response: no (stripped)
```

Raw keys are stripped from responses; the client only ever receives presigned
URLs.

### Item 2a — a presigned PUT genuinely cannot cap size

```
PUT 24.7MB to a URL issued under a 5MB policy   -> 200        <- the URL cannot refuse it
object in bucket before claim: present (24733712 bytes, image/jpeg)
POST /posts                                     -> 413 "Image is 24733712 bytes; the limit is 5242880"
object in bucket AFTER claim:  ABSENT (404)                   <- deleted
```

The `200` is the point: the limitation is real, and the `413` + delete is the
mitigation working.

### Item 2b — Content-Type, before and after signing it

```
BEFORE (SignedHeaders=host):
  URL signed for image/jpeg + "Content-Type: text/plain"  -> 200
  HeadObject on the key                                   -> text/plain, 44710 bytes

AFTER (SignedHeaders=content-type;host):
  matching   "Content-Type: image/jpeg" -> 200
  mismatched "Content-Type: text/plain" -> 403 SignatureDoesNotMatch
```

### Item 2c — sharp is the only thing that checks the bytes

```
1550 bytes of plain text, uploaded as "Content-Type: image/jpeg"
POST /posts -> 201     <- accepted: HeadObject only ever sees the declared type

[thumbnailWorker] job 2 post 6abd753d... failed (attempt 1/3):
  not a decodable image (posts/6ab91.../8d0a...f6.jpg):
  Input buffer contains unsupported image format

post still alive? yes | thumbnailUrl: null
```

`attempt 1/3` and no further attempts confirms `UnrecoverableError` stopped the
retries rather than burning all three. The post survives with a null thumbnail.

### Item 3 — the `$or` COLLSCAN, 8,000 docs returning 126 connections

```
=== BEFORE (pre-Phase-4 indexes only) ===
stages:              SUBPLAN -> PROJECTION_SIMPLE -> COLLSCAN
nReturned: 126 | totalKeysExamined: 0 | totalDocsExamined: 8000

=== HALF-INDEXED (only the fromUserId branch) ===
stages:              SUBPLAN -> PROJECTION_SIMPLE -> COLLSCAN
nReturned: 126 | totalKeysExamined: 0 | totalDocsExamined: 8000     <- unchanged
=== AFTER (both Phase 4 indexes) ===
stages:              SUBPLAN -> PROJECTION_DEFAULT -> OR -> IXSCAN
nReturned: 126 | totalKeysExamined: 126 | totalDocsExamined: 0
```

`docsExamined 8000 → 0`, and `keysExamined` exactly equal to `nReturned` — the
query reads only the keys it returns. The middle row is the "no partial credit"
proof.

(The stage reads `PROJECTION_DEFAULT` rather than `PROJECTION_COVERED` because of
the `$or` dedup, but `totalDocsExamined: 0` is the fact that matters: no document
was fetched.)

### Item 3 — feed index across graph densities (50,000 posts, one 10-post page)

```
REGIME A — 400 authors, viewer follows 120 (30.0%)
  page 1, only the _id index      keys:     36  docs:     36  ms:  0   LIMIT -> FETCH -> IXSCAN
  page 1, planner's choice        keys:    130  docs:     11  ms: 14   LIMIT -> FETCH -> SORT_MERGE -> IXSCAN

REGIME B — 20,000 authors, viewer follows 120 (0.6%)
  page 1, FORCED _id index        keys:   2525  docs:   2525  ms: 10   LIMIT -> FETCH -> IXSCAN
  page 1, FORCED {userId,_id}     keys:    119  docs:     11  ms:  6   LIMIT -> FETCH -> SORT_MERGE -> IXSCAN
```

`docsExamined 2525 → 11` in the realistic regime. Regime A is the honest
counter-example, including the planner choosing the slower plan.

### Item 3 — cursor vs skip, and page-boundary correctness

```
page 40 of 10, 50,000 posts:
  cursor (_id < ...)  keysExamined: 37
  .skip(390)          keysExamined: 520

Live paging through Elon's feed at limit=3:
  page 1: 3 posts | hasMore=true  | Virat post #7, #6, #5
  page 2: 3 posts | hasMore=true  | Virat post #4, #3, #2
  page 3: 3 posts | hasMore=true  | Virat post #1, ...
  page 4: 1 posts | hasMore=false
  total 10 posts across 4 pages | duplicates across pages: 0 ✅
  strictly newest-first across page boundaries: ✅
  invalid cursor -> 400 | limit=999 clamped to MAX_LIMIT 30
```

### Item 3 — authorization through the connection graph

```
Narendra is NOT connected to Elon:
  GET  /posts/feed             -> 200, 0 posts visible   (Elon's post absent)
  GET  /posts/user/<elon>      -> 403 "You can only view posts from your connections"
  POST /posts/<id>/like        -> 403 "You can only like posts from your connections"

Virat IS connected to Elon:
  GET  /posts/feed             -> 200, 1 post visible
  GET  /posts/user/<elon>      -> 200, 1 post
```

### Item 3 — claiming a key you don't own

```
Virat uploads to posts/6ab915224cfec1fa9966e740/1ed6...ed.jpg
Elon claims Virat's key            -> 403 "That upload key does not belong to you"
Elon claims posts/../../etc/passwd -> 403 "That upload key does not belong to you"
Claim a key that was never uploaded -> 400 "No uploaded image found for that key"
```

### Item 4 — like idempotency, sequential and concurrent

```
like   attempt 1 -> 201 "Post liked"    likeCount=1 likedByMe=true
like   attempt 2 -> 200 "Already liked" likeCount=1 likedByMe=true
unlike attempt 1 -> 200 "Post unliked"  likeCount=0 likedByMe=false
unlike attempt 2 -> 200 "Not liked"     likeCount=0 likedByMe=false

8 SIMULTANEOUS likes on one post by one user:
  statuses:        201 200 200 200 200 200 200 200
  final likeCount: 1  ✅ exactly 1
```

One insert won; seven hit `E11000` and were reported as the ordinary outcome. The
counter is exactly 1 — this is the check-then-act bug class *not* reproducing,
which is the whole point of letting the index decide.

### Item 4 — idempotent claim (the client-retry case)

```
first claim -> 201 "Post created"                      id: 6abd75404d9156b394223366
retry claim -> 200 "Post already created for this image" id: 6abd75404d9156b394223366
same post returned? ✅ yes — no duplicate post
```

### Item 5 — the thumbnail actually gets generated, and is much smaller

```
[thumbnailWorker] job 1 post 6abd74f1... ->
  thumbs/6ab91.../0086...68.webp (3872 bytes)

Fetching both presigned GET URLs from the feed response:
  original   HTTP 200   44710 bytes  content-type: image/jpeg
  thumbnail  HTTP 200    3872 bytes  content-type: image/webp
```

1600×1200 JPEG → 400×300 webp, **44,710 → 3,872 bytes (11.5× smaller)**, on a
worker, after the response was already sent.

### Rejected content types

```
contentType "image/svg+xml"   -> 400   (an SVG can carry <script>; an allowlist excludes it, /^image\// would not)
contentType "application/pdf" -> 400
contentType "image/gif"       -> 400
contentType ""                -> 400
```

### Delete: row, likes, and both objects

```
before: imageKey present (44710b) | thumbKey present (3872b) | like rows: 1
Virat (not the author) DELETE -> 404 "Post not found"     <- same as missing, doesn't confirm the id exists
Elon  (author)         DELETE -> 200 "Post deleted"
after:  post row gone ✅ | like rows: 0 | imageKey ABSENT (404) | thumbKey ABSENT (404)
```

### Indexes actually built

```
posts:
   imageKey_1                        {"imageKey":1}                UNIQUE
   userId_1__id_-1                   {"userId":1,"_id":-1}
likes:
   postId_1_userId_1                 {"postId":1,"userId":1}       UNIQUE
connectionrequests:
   fromUserId_1_status_1_toUserId_1  {"fromUserId":1,"status":1,"toUserId":1}
   toUserId_1_status_1_fromUserId_1  {"toUserId":1,"status":1,"fromUserId":1}
```

### No regression on the refactored route

```
GET /user/connections -> 200 | 3 connections
fields: _id, firstName, lastName, photoUrl, about, skills
names:  user1, Virat, Barack
```

Same response shape as before the refactor; 3 queries became 2, and the edge
query went from a COLLSCAN to a covered index read.

### End-to-end through the real React app

The claim this whole phase rests on is "image bytes never touch the API". A
screenshot cannot show that; the network log can. Uploading a canvas-generated
JPEG through the real UI, logged in as Elon:

```
POST http://localhost:7777/posts/upload-url                        -> 200   (API, small JSON)
PUT  http://localhost:9000/now-connect-posts/posts/<uid>/325ba…jpg -> 200   <- THE BYTES
POST http://localhost:7777/posts                                   -> 201   (API, small JSON)
GET  http://localhost:9000/now-connect-posts/posts/<uid>/325ba…jpg -> 200   (original renders)
GET  http://localhost:7777/posts/feed?limit=5                      -> 200   (thumbnail poll)
GET  http://localhost:9000/now-connect-posts/thumbs/<uid>/325ba…webp -> 200 <- worker done
```

The bytes go to **:9000**, the object store. The API on **:7777** sees two small
JSON requests and never the image. The final request also confirms the derived
key: `thumbs/<uid>/325ba….webp` shares its basename with
`posts/<uid>/325ba….jpg`, which is what makes a retried thumbnail job overwrite
rather than orphan.

CORS worked without configuration: the browser sent an `OPTIONS` preflight to
MinIO, got `204`, then the `PUT`. That only works because the upload request
does **not** carry credentials — S3 and MinIO answer preflights with a wildcard
origin, and a browser refuses a wildcard on a credentialed request. The client
uses a separate bare axios instance for the object store for exactly this
reason.

Also verified in the browser:

| | |
|---|---|
| Likes | `♡ 0` → `♥ 1` → `♡ 0`, optimistic then reconciled from the response |
| Cursor paging | 5 posts, then 9 after "Load more"; button disappears at the end; one `?cursor=` request, no duplicates |
| Thumbnail swap | post rendered from the original on creation, replaced by the `.webp` a second later |
| Owner-only delete | the Delete button renders on Elon's own post and on none of Virat's |
| **Authorization** | logged in as Narendra (no accepted connections): **"No posts yet"** while 9 posts exist |

That last row is the connection graph holding through the real client, not just
through curl.

**One bug found this way, which is the argument for doing it:** the app-wide
footer is `fixed bottom-0`, so it painted over the bottom of the page and
swallowed clicks on "Load more posts" — `elementFromPoint` at the button's centre
returned the footer. It is invisible in a screenshot, because the button *is*
visible; it simply isn't clickable. Fixed with bottom padding on the posts page
rather than by un-fixing the shared footer.

### Cleanup

The bench database was dropped. The deliberately-corrupt test post and the
objects orphaned by the rejected-claim tests were swept, leaving 8 real posts and
their 16 objects (8 originals + 8 thumbnails) for the frontend verification.

---

## Files added / changed

### Backend (`devTinder`)

**Added**

| File | What |
|---|---|
| `src/models/post.js` | `Post` schema; unique `imageKey`, nullable `thumbnailKey`, denormalised `likeCount`; `{userId, _id: -1}` feed index with the measured selectivity reasoning |
| `src/models/like.js` | `Like` schema; unique `{postId, userId}` — the index that makes liking idempotent without application code |
| `src/utils/postStorage.js` | Presigned PUT/GET, key derivation, `HeadObject` verification, quiet deletes, byte access for the worker. All the presigned-URL trade-offs are documented here |
| `src/utils/connectionGraph.js` | `getAcceptedConnectionIds` — the shared, index-covered `$or`, plus why it is deliberately *not* cached |
| `src/routes/post.js` | 7 routes: upload-url, claim, feed, user posts, like, unlike, delete |
| `src/queues/thumbnailQueue.js` | BullMQ queue; retry policy tuned for a different failure kind than email's |
| `src/workers/thumbnailWorker.js` | Download → sharp resize → upload → point the row at it, with the three at-least-once guards |

**Changed**

| File | What |
|---|---|
| `src/models/connectionRequest.js` | **Two new indexes** for the bidirectional accepted-connection query (the COLLSCAN fix), and a note on why the now-dead `{fromUserId, toUserId}` index is left in place rather than dropped in a feature branch |
| `src/routes/user.js` | `/user/connections` refactored onto `connectionGraph`; two `.populate()` calls became one `User.find()` |
| `src/utils/constants.js` | `postUploadLimits` (size, allowlist, URL TTLs) and `thumbnailSize`, beside the existing product limits |
| `src/app.js` | Mount `postRouter` |
| `src/workers/index.js` | Register `thumbnailWorker`; note on why it is the first worker that is CPU-bound rather than network-bound, and the first candidate to split out |
| `package.json` | `sharp` |
| `README.md` | The three-step upload flow, the route table, the worker requirement |
| `ISSUES.md` | Scaling #5 (the `$or` COLLSCAN, fixed) and #6 (the presigned-PUT size limitation, accepted with mitigation) |
| `apiList.md` | `postRouter` and `chatRouter` sections |
| `postman/devTinder.postman_collection.json` | A `Posts` folder — 10 requests including the non-API step 2, with the reasoning in each description |

### Frontend (`nowConnect-web`, separate repo)

| File | What |
|---|---|
| `src/utils/postApi.js` *(added)* | The three-step upload. A **separate bare axios instance** for the object store, so the session cookie is never sent cross-origin (and so the credentialed-wildcard CORS failure can't happen); `Content-Type` threaded from one `file.type` read through both calls, since it is now signed; `displayUrl()` centralising the `thumbnailUrl ?? imageUrl` contract |
| `src/components/Posts.jsx` *(added)* | Upload form with real progress (real because the browser is doing the transfer), cursor-paginated feed, optimistic likes reconciled from the response, owner-only delete, bounded thumbnail poll |
| `src/App.jsx`, `src/components/NavBar.jsx` *(changed)* | `/posts` route and nav link |

The client is what proves the central claim of this phase — see "End-to-end
through the real React app" above.

---

## Bugs and gaps found along the way

1. **`GET /user/connections` had always been a COLLSCAN.** Not introduced by this
   phase — found because the posts feed needed the same query on a hot path. The
   `$or`-needs-every-branch-indexed rule is the reason it survived having a
   partially-applicable index.
2. **`GET /user/requests/received` was scanning for the same reason**, fixed by
   the same two indexes.
3. **Our presigned URLs were not enforcing Content-Type.** `ContentType` on the
   command is not in the signature unless you put it there; a URL signed for
   `image/jpeg` accepted a `text/plain` upload and stored it as `text/plain`.
4. **The `{fromUserId, toUserId}` index is now dead weight** — Phase 2 removed its
   only query (the check-then-act `findOne`). Left in place deliberately:
   dropping an index is irreversible-in-production and wants its own change and
   verification, not a drive-by deletion inside a feature branch.

---

## Anticipated interviewer follow-up questions

**"Why not just upload through your API? It's simpler."**
It is, and it's fine until it isn't. The problem isn't latency, it's that a
5-second mobile upload occupies a request slot, a connection and a multi-megabyte
buffer on a single-threaded process — so a few hundred concurrent uploaders make
the API slow *for people who aren't uploading*. Presigning removes our instance
from the data path entirely: our cost per upload is two small JSON requests
regardless of file size. The trade is that upload stops being atomic and each
seam needs a guard — key ownership, existence, size, and eventually whether the
bytes are even an image.

**"How do you stop someone claiming an image they don't own?"**
The key is server-generated as `posts/<authenticated userId>/<random>`, and the
user never influences the prefix — so the check is `imageKey.startsWith("posts/" +
req.user._id + "/")`. That's why the key is structured rather than opaque: the
structure carries the ownership claim, so no separate pending-uploads table is
needed. It also neutralises traversal attempts for free.

**"What stops someone uploading a 2GB file?"**
Nothing, at the URL — and that's worth saying plainly, because a presigned PUT
genuinely cannot cap size: it isn't known at signing time and there's no signable
header that bounds it. I verified it: 24.7MB against a 5MB-policy URL returns 200.
So it's enforced at claim time with a `HeadObject` — metadata only, so checking a
5MB upload doesn't cost 5MB — which refuses with 413 *and deletes the object*. The
delete is the important half; without it the endpoint is free unlimited storage.
The complete fix is a presigned POST with a `content-length-range` condition,
which S3 enforces before storing. I didn't take it because it adds a dependency
and turns a one-line client `fetch` into a multipart form, but it's the upgrade
path if uploads ever became untrusted or unmetered.

**"How do you know the file is actually an image?"**
Only by parsing the bytes, and nothing on the request path does. The signed
Content-Type binds the *label*, not the content, and `HeadObject` returns that
same label back. The real check is the thumbnail worker: sharp opens the object,
and a renamed PDF fails there with "unsupported image format". That's marked
`UnrecoverableError` so it fails immediately instead of retrying — bytes that
aren't an image now won't be in four seconds. The post is left alive with a null
thumbnail, because deleting user content on a decode failure is a moderation
decision, not a resize worker's call.

**"Why is `likeCount` stored if you can count the Like rows?"**
Read:write ratio. It's read on every feed impression and written once per like —
hundreds to one — and without it a 10-post page is 10 `countDocuments` calls. It's
a real second source of truth, and I'll say what it costs: there's no transaction
between the Like insert and the `$inc`, so a process death in that window loses
one increment. The blast radius is a count reading 41 instead of 42, `Like`
remains the source of truth to recompute from, and the `$inc` is guarded so it
can't go negative. That's the right trade for a social counter and the wrong one
for a balance.

**"Two people like the same post at the same instant. What happens?"**
Nothing interesting, which is the design. There's no "already liked?" check
anywhere — the unique `{postId, userId}` index decides, one insert wins, and
`E11000` is translated into a 200 "already liked". I tested it with 8 simultaneous
requests: one 201, seven 200s, final count exactly 1. The counter uses `$inc`
rather than read-modify-write, so N concurrent increments always sum to N; the
`+=`-then-`save()` version loses updates. This is the same check-then-act bug
class I fixed on swipes in Phase 2 and on Chat creation in Phase 3 — by Phase 4
the reflex is to reach for the index first.

**"Why is the timeline computed at read time? Doesn't that not scale?"**
It depends on which direction the fan-out goes, and mine is bounded. Fan-out on
write breaks when one *author* has millions of followers — one post becomes
millions of timeline inserts. Fan-out on read breaks when one *reader* follows
tens of thousands of authors. My connections are mutual and require an accepted
request, so you can't have 50,000 of them without it being socially absurd — the
`$in` stays in the hundreds. That's why read-time is right here and would be
wrong on Twitter. At that scale the answer is hybrid: fan-out on write for
ordinary accounts, read-time merge for the few high-fan-out ones.

**"Is your feed index actually helping?"**
Only in the regime the app is heading into, and I measured both. Without it the
query isn't a COLLSCAN — Mongo walks the `_id` index descending, which already
satisfies the sort and the cursor, and filters on `userId`. At 50k posts, when the
viewer follows 30% of all authors that walk examines 36 documents per page and
beats the merge. When they follow 0.6% — the realistic case — it examines 2,525,
because 99.4% of what it walks past belongs to someone they don't follow, and
that grows with the user base while the merge stays at 11. So I'm optimising
`docsExamined` for the sparse regime, not wall-clock on a small test set. I'd also
volunteer that in the dense regime the planner picks the merge and is slower for
it — its cost model undercounts coordinating 121 cursors.

**"You found a second COLLSCAN. Why didn't the existing index help?"**
Because `$or` doesn't get partial credit. MongoDB's subplanner needs an indexed
plan for *every* branch; if one branch has no usable index it abandons index
selection for the whole `$or` and scans once. `{fromUserId, toUserId}` could serve
the `fromUserId` branch, but nothing led with `toUserId`, so the whole thing
scanned. I proved it — adding only the `fromUserId` index left `docsExamined` at
8000, completely unchanged. The fix is two indexes, one per direction, with the
trailing field chosen so the projection is covered: `docsExamined` 8000 → 0, and
`keysExamined` exactly equal to `nReturned`.

**"Why cache the feed's exclusion set but not the connection list?"**
Because caching fixes an unbounded access pattern, not a slow one. The exclusion
set's cost grew with the user's entire swipe history — unbounded, re-read on every
page, identical across a scroll session. The connection list's cost, after the
index, is proportional to the number of connections, which is the size of the
answer, so there's nothing to amortise. And the downside isn't symmetric: the
posts feed uses that list as its access-control boundary, so a stale entry isn't
a slow feed, it's showing a removed connection's posts. An index was the right
fix here; a cache was the right fix there.

**"Why generate thumbnails asynchronously? The resize is only a second."**
Two reasons, and the second is the one that matters. First, sharp is CPU-bound on
libuv's 4-thread pool, so concurrent uploads saturate it and then everything else
in the process — including DNS and file I/O for unrelated routes — queues behind
image resizing. Second, it would put the image bytes back on the API instance,
which undoes the entire point of presigned uploads. What makes deferring *safe* is
that `thumbnailKey: null` is a valid renderable state — clients use
`thumbnailUrl ?? imageUrl` — so a backed-up worker degrades image weight, never
availability. That's the actual test of whether work belongs on a queue rather
than having merely been moved onto one.

**"Your worker uploads to S3 and then writes to Mongo. What if it dies in
between?"**
Then there's an unreferenced thumbnail object in the bucket — a few KB, invisible
to users, and the next run of the job recomputes the *same* derived key and
overwrites it. That ordering is deliberate: the reverse leaves a `Post` pointing
at a thumbnail that doesn't exist, which renders a broken image in every viewer's
feed. There's no transaction across S3 and Mongo, so the choice is which
inconsistency you can live with, and wasted bytes beat a dangling reference. It's
the same call as writing the `Message` before updating `Chat.lastMessageAt` in
Phase 3.

**"What happens to images nobody claims?"**
They're orphaned, and that's a known gap rather than an oversight. The seam
between "get a URL" and "claim it" is inherent to the design, and the alternative
— a pending-uploads table — needs its own reaping anyway. The systematic answer
is an S3 lifecycle rule expiring unclaimed objects under the prefix, or a
periodic job diffing the bucket against the `Post` collection. I didn't implement
it because it's bucket configuration plus a scheduled job and an unclaimed 5MB
object is a rounding error at this scale, but it's the right fix.

**"Why keep the bucket private? Public objects with a CDN would be faster."**
Because posts are visible only to accepted connections, and a public object URL
is readable by anyone who has it, forever — so the access rule would hold in the
API and not in storage, and one shared URL bypasses the connection graph. An
access control only one of two doors enforces isn't one. The cost I'm paying is
real: per-viewer, time-bound URLs aren't shared-cacheable at the edge. The
production answer is CloudFront with an origin access identity or signed cookies
— same private bucket, cached at the edge — and it's infrastructure config, not
an application change.

**"Why is unliking not authorization-checked when liking is?"**
Because they create different things. Liking creates state on someone else's
post, and post ids are handed out in feed responses and are guessable ObjectIds,
so without a check strangers could like and inflate the counter of posts they
were never allowed to see. Unliking only removes a row you created yourself — and
gating it would strand that row and leave the counter permanently inflated if you
got disconnected in between. The rule I'd state is: authorize the action that
creates state, not the action that withdraws your own.

**"You added two indexes and left a dead one. Why?"**
Phase 2 removed the only query that used `{fromUserId, toUserId}`, so it now costs
a write on every insert and serves no read. I left it because dropping an index is
irreversible in production and deserves its own change with its own verification
that nothing regressed — not a drive-by deletion buried in a feature branch where
a rollback would also roll back the posts feature. It's flagged in `ISSUES.md`.

---

## Next: Phase 5

Phase 5 is a **write-up only, no code**: the forward-looking scaling roadmap. It
should reference the concrete choices made in Phases 1–4 as the "already done"
half of a "how would you scale this further" answer — the queue infrastructure,
the cursor convention, the index work, the fan-out-on-read decision and the
conditions under which each would need to change.

Specific threads this phase leaves open for it to pick up:
- **Hybrid fan-out** for the posts feed, and the follower-count threshold at which
  you'd switch an account over.
- **CloudFront + origin access identity**, replacing per-viewer presigned GETs
  with edge-cached private delivery.
- **Presigned POST** with `content-length-range`, closing the size gap at the
  object store instead of at claim time.
- **Orphan reaping** — lifecycle rules or a reconciliation job.
- **Splitting the thumbnail worker** into its own deployment, since it's the first
  CPU-bound workload sharing a process with network-bound ones.
- **Dropping the dead `{fromUserId, toUserId}` index**, as its own verified change.
- `userAuth` doing a `User.findById` on every request (`ISSUES.md` Scaling #4) —
  still open, and the natural next Redis use case.
