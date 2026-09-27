# Now Connect — Scale-Up Plan

## Context

The current backend (renamed from DevTinder to **Now Connect** — an internal social-networking app) works end-to-end but is, honestly, a CRUD app with sockets attached: auth, a connection request graph, a feed, payments, chat. There's nothing in it that forces a "how did you handle scale" or "what broke in production" answer, which is exactly what a 5-6 YOE interview loop probes for.

We already found one real production-shaped bug during code review: the daily cron job (`src/utils/cronjob.js`) does a full collection scan on `ConnectionRequest` — the collection that grows fastest in the whole system — because the only index is `{fromUserId, toUserId}` and the query filters on `status`+`createdAt`. That's a genuine incident story, not a fabricated one, and it anchors Phase 1 below.

The goal of this plan is to add ~4 feature areas that each map to a specific, defensible interview talking point (a design decision, a trade-off, a failure mode and its fix) — not to gold-plate the app. Depth over breadth: every phase should leave you able to say "I chose X over Y because Z" and mean it.

**Decisions already made with the user:**
- All four feature areas are in scope: rate-limited swipes + feed scaling, posts w/ images, chat at scale, async jobs + incident story.
- New infra is fine: Redis and S3-compatible object storage, run locally via Docker Compose (no cloud spend).
- No formal load testing — interviews are close, so we optimize for finishing and being able to reason about the trade-offs, not for measured before/after numbers. Verification is via query plans (`.explain()`), manual smoke tests, and documented Big-O/round-trip reasoning instead.

**Sequencing rationale:** Phase 1 first (cheapest, uses a bug we've already diagnosed, introduces Redis + a job queue that later phases reuse). Then Phase 2 (rate limiting is a small, self-contained Redis use case before touching the feed). Then Phase 3 (chat — moderate complexity, benefits from the queue existing). Phase 4 last (posts is the most new surface area: new model, new upload flow, new storage).

Reuse existing patterns throughout: routers live in `src/routes/`, guards in `src/middlewares/` (pattern: `src/middlewares/auth.js`), external clients live in `src/config/` or `src/utils/` following the existing `sesClient.js` / `razorpay.js` shape, and membership-tier constants already live in `src/utils/constants.js`.

---

## Interview Question Coverage

The user's actual bar for this plan is: will it hold up against a specific set of senior-level interview questions. Mapped explicitly so gaps are visible rather than assumed:

| # | Question | Primary source | Secondary source |
|---|---|---|---|
| 1 | Challenge faced & why it was hard | Phase 3 (16MB cap + single-instance sockets — invisible until you deploy 2+ instances) | Phase 2 item 0 (race condition — invisible under manual testing), Phase 1 (silent perf bug, no errors, just slow) |
| 2 | Performance incident & fix | Phase 1 (cron COLLSCAN, real `.explain()` before/after) | Phase 2 (feed `$nin`-over-full-history) |
| 3 | A design decision | All phases — each has an explicit options-considered call | — |
| 4 | Trade-off between options & how it played out long-term | Phase 3 (embedded messages → separate collection: a **real** V1→V2 evolution in git history, not hypothetical) | Phase 2 item 0 (fail-open vs fail-closed), Phase 1 (sync vs async email) |
| 5 | Load at a fixed time of day/month | Phase 1 (8am cron spike) | Phase 1 webhook item (bursty payment completions), Phase 2 (evening peak swipe traffic) |
| 6 | How you scaled it / would scale it further | Phase 5 (forward-looking roadmap) | References the concrete choices made in Phases 1-4 as the "already done" half of the answer |
| 7 | Similar/adjacent questions | Breadth across all phases + Phase 5 | — |

Phase 3 and Phase 1 carry the most weight — if time runs out, those two are non-negotiable. Phase 4 (posts) is the weakest per-question fit (mainly Q3) and is the safest to cut or trim to just the presigned-upload flow if the deadline is tight.

---

## Phase 0 — Shared infrastructure (do once)

- `docker-compose.yml` at the project root: `redis` (7.x) and `minio` (S3-compatible), alongside the existing Mongo connection (leave Mongo as-is — Atlas or local, unchanged).
- `src/config/redis.js` — a single `ioredis` client, exported like `sesClient.js` exports its client. Used by rate limiting (Phase 2), BullMQ (Phase 1), and the Socket.io adapter (Phase 3).
- `src/config/s3.js` — `@aws-sdk/client-s3` client pointed at MinIO locally (`endpoint` + `forcePathStyle: true`) and real S3 in prod via env vars. Mirrors the existing `sesClient.js` / `razorpay.js` pattern (same AWS SDK family already used for SES).
- New deps: `ioredis`, `bullmq`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@socket.io/redis-adapter` (+ `redis` v4 client, which that adapter expects for its pub/sub pair).
- Extend `.env` (no `.env` exists yet — this is also when we finally create it) with `REDIS_URL`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`.
- Cosmetic rename: `package.json` `name`/`description` → "Now Connect", plus a short README replacing the course-checklist `homework.md` framing.

---

## Phase 1 — Async processing + a real incident story

**Talking point:** "We found a full collection scan on our largest, fastest-growing collection running daily in production, root-caused it with `.explain()`, and fixed it with an index + a rewritten query — then moved the side-effect (sending email) off the request/cron path entirely so a slow mail provider can never block it again."

1. **Fix the actual bug** in `src/models/connectionRequest.js`: add a compound index matching the cron query — `{status: 1, createdAt: 1}`, or better, a partial index (`partialFilterExpression: {status: "interested"}`) since only that status is ever queried this way.
2. **Rewrite the cron query** in `src/utils/cronjob.js`: replace `.find({...}).populate("fromUserId toUserId")` with `ConnectionRequest.distinct("toUserId", {...})` (a covered query against the new index, no document fetch) followed by a single `User.find({_id: {$in: ids}}, {emailId: 1})`. This also fixes the current bug where `fromUserId` is populated but never used.
3. **Introduce a job queue**: `src/queues/emailQueue.js` (BullMQ queue) + `src/workers/emailWorker.js` (the worker process, run via a separate `npm run worker` script). The cron job's only job becomes: compute recipients, enqueue one job per recipient (or one batch job), return immediately.
4. **Fix `src/utils/sendEmail.js`**: it currently hardcodes the recipient and ignores its `toEmailId` argument — fix that as part of wiring it into the worker, since the worker actually needs it to work correctly per-user.
5. **Add retry/backoff** on the queue (BullMQ's built-in exponential backoff) and log failed jobs — this is your answer to "what happens when the email provider is down."
6. **Harden the payment webhook** in `src/routes/payment.js`, and reuse the queue for it — this is a second, independent "load at a specific time" story (a promo/sale causing many payments to complete in a short window):
   - It currently sets `isPremium = true` on *any* webhook event, including `payment.failed`, and has no null check if the payment record isn't found. Fix: branch on `req.body.event` and guard the lookup.
   - It's not idempotent — Razorpay can and will redeliver the same webhook. Add an idempotency guard (e.g., a unique index on a stored `razorpayEventId`, or check the payment's current status before transitioning it).
   - Once the signature is verified, **ack immediately** (`res.status(200)`) and push the actual DB update (payment status + user upgrade) onto the Phase 1 queue instead of doing it inline. This is the direct answer to "how do you handle a burst of webhook calls without falling behind or dropping one."

**Interview narrative to write down** (put it in `ISSUES.md` or a new `docs/incidents.md`): the symptom (cron job slow / DB CPU spike at 8am), the diagnosis tool (`.explain("executionStats")` showing `COLLSCAN`), the fix (index + covered query), and the follow-up (decoupling side effects via a queue so a future slow dependency can't cause the same class of problem again).

---

## Phase 2 — Membership-tier rate limiting + feed scaling

**Talking point:** "We moved the hottest write path (swipes) off Mongo and onto an atomic Redis counter so free-tier abuse can't hammer our primary datastore, and we swapped skip/limit pagination for cursor-based pagination so feed latency doesn't degrade on deep pages."

0. **Fix a real concurrency bug first**: `src/routes/request.js` currently does a `findOne` "does this request already exist" check, then a separate `.save()` — classic check-then-act, so two near-simultaneous swipes (double-click, or both users swiping on each other at the same instant) can both pass the check and create duplicate/conflicting `ConnectionRequest` documents. Fix with a unique compound index on a **canonicalized pair** (e.g., store `userIdLow`/`userIdHigh` as the two IDs sorted, with a unique index on that pair) so the database itself rejects the duplicate on `save()`, and catch the resulting duplicate-key error as an expected "someone else already sent it" case rather than a 500. This is a genuinely hard-to-notice bug (it never shows up in manual/sequential testing) and a strong idempotency/concurrency story on its own.
1. **Rate limiter middleware**: `src/middlewares/rateLimiter.js`. Key shape `swipe:{userId}:{YYYY-MM-DD}`, atomic `INCR` + conditional `EXPIRE` (a small Lua script or `MULTI` to avoid the race where two concurrent first-requests both set a fresh TTL). Limits per tier read from `src/utils/constants.js` (which already holds `membershipAmount` — add a sibling `swipeLimits: {free: 20, silver: 100, gold: Infinity}` there). Apply to `POST /request/send/:status/:toUserId` in `src/routes/request.js`.
   - Decide and be ready to defend: fail-open or fail-closed if Redis is unreachable. Fail-open (allow the swipe, log a warning) is the defensible choice for a non-payment-critical limit.
2. **Feed pagination fix** (baseline, do this regardless of the stretch goal below): in `src/routes/user.js`, replace `skip`/`limit` with cursor-based pagination (`_id > lastSeenId`, sorted by `_id`), which avoids Mongo re-walking and discarding N documents on every deep page.
3. **Stretch (if time allows): cached candidate pool.** Cache each user's "already interacted with" ID set in Redis (a set, refreshed periodically, invalidated by adding to it on every new swipe) instead of recomputing it from `ConnectionRequest` on every `/feed` call. This is the fan-out-on-write vs. fan-out-on-read trade-off — worth being able to describe even if you only fully implement the simpler baseline above.

---

## Phase 3 — Chat at scale

**Talking point:** "The original design stored all messages in one embedded document per conversation, which hits Mongo's 16MB document cap and rewrites the whole array on every message. It also assumed a single Node process — Socket.io rooms are in-memory per instance, so a second server instance can't deliver messages to a room owned by the first. We split messages into their own collection and added a Redis pub/sub adapter so Socket.io works across instances."

1. **Split messages out of `Chat`**: new `Message` model (`chatId`, `senderId`, `text`, `createdAt`), indexed on `{chatId: 1, createdAt: 1}`. `Chat` keeps just `participants` (+ maybe `lastMessageAt` for sorting a conversation list later).
2. **Cursor-paginate history**: `GET /chat/:targetUserId?before=<messageId>&limit=50` in `src/routes/chat.js`, instead of returning the whole array.
3. **Socket.io Redis adapter**: wire `@socket.io/redis-adapter` into `src/utils/socket.js` using the Phase 0 Redis client (or a dedicated pub/sub pair, per the adapter's requirements). This is the concrete answer to "how would this work with more than one server instance."
4. **Close the authorization gap** that's already flagged as a `TODO` in `src/utils/socket.js`: before `joinChat`/`sendMessage` proceed, verify the two users have an `accepted` `ConnectionRequest` between them. This both fixes a real security bug and gives you a legitimate "we added an authz check that was missing" story.

---

## Phase 4 — Posts feature (images, captions, likes)

**Talking point:** "Uploads go straight from the client to object storage via a pre-signed URL — the backend never proxies image bytes — which is the standard way to keep a Node process from becoming a bottleneck for large payloads."

1. **`Post` model**: `userId`, `imageKey`/`imageUrl`, `caption`, `createdAt`. Likes as a **separate `Like` collection** (`postId`, `userId`, unique compound index) rather than an array on `Post` — same embedded-array growth problem as chat, already fixed once this session, don't reintroduce it.
2. **Pre-signed upload flow**: `POST /posts/upload-url` returns a pre-signed PUT URL (via `@aws-sdk/s3-request-presigner` against the Phase 0 S3/MinIO client); the client uploads directly to storage; then `POST /posts` creates the DB record with the resulting key.
3. **`GET /posts/feed`**: cursor-paginated, scoped to the requester's accepted connections (reuses the existing connection graph — keeps this feature socially consistent with the rest of the app instead of being a bolt-on).
4. **`POST /posts/:postId/like`** (and unlike): idempotent via the unique `{postId, userId}` index — a duplicate like attempt is a no-op, not a bug you have to guard against in application code.
5. **Optional stretch**: async thumbnail generation via a BullMQ worker (`sharp`), reusing the Phase 1 queue infra — "upload stays fast because resizing happens after the response is already sent."

---

## Phase 5 — Future scaling roadmap (write-up only, no code — do this regardless of how far Phases 1-4 get)

This directly answers "how would you scale this further" (Q6) without needing anything built. It's written as an ordered "what I'd do next, and why, based on what would actually break first" — the shape senior interviewers want, versus a list of buzzwords. Draft now, refine after Phases 1-4 land (the "already done" items get to move from "I'd do X" to "I did X"):

- **Database.** Today: a single MongoDB cluster. Next: `readPreference: secondaryPreferred` on read-heavy, eventually-consistent paths (feed, profile views) via read replicas — cheap, no schema change. Beyond that: shard `ConnectionRequest` and `Message` by a hash of user ID specifically, because those are the two collections we already know grow fastest (every swipe, every message) — sharding the small, slow-growing collections (`User`, `Payment`) would be solving the wrong problem. Also: TTL or archive old `rejected`/`ignored` requests and old messages to cold storage once they're not needed hot.
- **Caching.** Post-plan: Redis for rate limits and the job queue. Next: cache-aside for `/profile/view` and feed-candidate profiles (high read:write ratio, short TTL, invalidate on `/profile/edit`) — the next-cheapest win after what's already planned.
- **Async/messaging.** Post-plan: BullMQ on Redis for email + webhook processing. Next, and only if job volume/durability needs outgrow what a Redis-backed queue comfortably gives (replay, multiple consumer groups, stricter delivery guarantees): move to Kafka or SQS. The point to make explicitly in an interview: choosing BullMQ now instead of Kafka is itself a deliberate scale-appropriate decision, not a gap — reaching for Kafka on day one for this traffic level would be over-engineering.
- **Real-time/chat.** Post-plan: Redis pub/sub adapter so Socket.io works across instances. Next: presence tracking in Redis; at much larger scale, split the WebSocket gateway into its own service so long-lived socket connections stop competing with the API tier for capacity.
- **Deployment/compute.** The API tier is already stateless (JWT auth, no server-side session) — horizontal scaling is "add another instance behind a load balancer," and the Phase 3 Redis adapter is what makes that actually correct for sockets, not just theoretically possible. Run the BullMQ worker as a separate process/deployment from the API so a notification-volume spike doesn't steal CPU from request handling.
- **Media.** Presigned uploads already keep the API tier out of the read/write path for images. Next: a CDN in front of the S3/MinIO bucket, since image reads vastly outnumber writes (post once, viewed by many).
- **Observability — the prerequisite for all of the above.** You can't justify any item on this list without a signal that it's needed. Minimum bar: structured request logs + per-route latency. Next: p95/p99 latency dashboards, queue depth/lag, Mongo slow-query log — the actual triggers for deciding which item above to do next, instead of guessing.

---

## Documentation & narrative deliverables (this is what makes you interview-ready, not just the code)

Code changes alone don't make these answers recallable under pressure. For each phase, produce a short **Problem → Investigation → Options → Decision → Outcome/Estimate** note (extend `ISSUES.md` or a new `docs/decisions.md`):
- **Problem**: the symptom, and explicitly *why it was hard to notice* (silent perf degradation, only shows up under concurrency, only shows up with 2+ instances, etc.) — this is what answers "why was it challenging," not just "what was broken."
- **Investigation**: how you found it (`.explain()` output, code reading, reasoning about the model) — be ready to show the actual command/output, not just describe it.
- **Options**: 2-3 real alternatives considered, with the one-line trade-off for each.
- **Decision**: which one, and the specific reason.
- **Outcome/estimate**: since there's no load test, use a concrete computed estimate (e.g., "at ~X bytes/message, the 16MB cap is hit after ~Y messages — for an active daily pair, that's Z months away") rather than a vague "it's faster now." A quantified estimate is far more convincing than an unquantified claim.

**Git hygiene matters here**: keep each phase's "before" state as real, separate commits rather than squashing — Q4 specifically wants a trade-off that "played out," and the chat migration (embedded array → separate collection) is only a credible long-run story if there's an actual diff to point to, not a description of one.

**After each phase is implemented**, come back and we'll co-draft the actual spoken version of the answer (Problem→Action→Outcome, like we did earlier for the old project) grounded in the real file paths, index names, and estimates you ended up with — don't try to memorize a speech from this plan file itself, since it'll drift from what you actually build.

---

## Verification (no formal load test, per the decision above)

For each phase, verify with:
- **Query plans**: run `.explain("executionStats")` on the changed queries (cron job, feed, message history) before/after the index or pagination change, and note the `COLLSCAN`→`IXSCAN` shift and `totalDocsExamined` delta — this is your "before/after" evidence instead of a load test number.
- **Manual smoke test** via Postman/curl for every new/changed route: happy path, the tier-limit boundary (free user's Nth+1 swipe), a duplicate like, an unauthorized chat join.
- **Concurrency check for the duplicate-request fix**: fire two near-simultaneous requests (e.g., a tiny script issuing both with `Promise.all`, or two Postman runners) at `POST /request/send` for the same pair and confirm only one `ConnectionRequest` is ever created — this is the one item that a purely sequential manual test would miss.
- **Reasoning, written down**: for each phase, a short note (extend `ISSUES.md` or a new `docs/decisions.md`) stating the problem, the option chosen, the option rejected, and why — this is the artifact you'll actually be recalling from in an interview, more valuable here than raw throughput numbers.

## Out of scope (explicitly, to keep this finishable)

No Kafka, no Kubernetes/multi-region, no real load-testing tool, no CI/CD changes, no read replicas/sharding actually provisioned. Redis + MinIO via Docker Compose is the entire new infra footprint. All of the "no"s above are deliberately deferred to the Phase 5 roadmap as *reasoned future steps*, not gaps — "I chose not to add Kafka/sharding yet because current volume doesn't need it, and here's the signal that would tell me it's time" is itself a senior-level answer. If any phase starts sprawling, stop at the baseline described and keep the stretch item as a "here's what I'd do next" talking point rather than building it.
