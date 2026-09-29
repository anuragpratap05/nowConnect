# Phase 1 — Async processing + a real incident story

> One-line summary: found a full collection scan running daily against our
> fastest-growing collection, root-caused it with `.explain()`, fixed it with a
> partial covering index + a rewritten (covered) query, and then moved the
> side-effect (sending email) off the cron/request path onto a BullMQ queue so a
> slow mail provider can never block it again. Reused the same queue to harden
> the payment webhook.

This is the phase that carries the most interview weight (with Phase 3). It's
built around a **real** performance bug that was already in the code, not a
fabricated one.

---

## The incident (Problem → Investigation → Options → Decision → Outcome)

### Problem
The daily 8am cron (`src/utils/cronjob.js`) emails everyone who received a
connection request the day before. Its query was:

```js
ConnectionRequestModel
  .find({ status: "interested", createdAt: { $gte, $lt } })
  .populate("fromUserId toUserId");
```

`ConnectionRequest` is the **fastest-growing collection in the whole system** —
one document per swipe. The only index on it was `{fromUserId: 1, toUserId: 1}`,
which does nothing for a query that filters on `status` + `createdAt`. So the
query was a **full collection scan**, every morning, on the biggest table.

**Why it was hard to notice** — this is the "why was it challenging" answer:
it throws no error and returns correct results. It's a *silent* degradation.
With 10k rows it's a few ms; the COLLSCAN cost grows linearly with the
collection, so it only becomes a visible DB-CPU spike once the collection is
large — and it spikes at a **fixed time of day (8am)**, so it looks like a
mysterious recurring load event rather than a bad query. Nothing in normal
request-path testing ever exercises it.

### Investigation
Ran `.explain("executionStats")` on the exact query, seeded with 8,000 docs
(~40% `interested`, spread over 5 days). Measured **before** (original indexes
only) and **after** (new index + rewritten query):

| | Winning plan | nReturned | totalKeysExamined | totalDocsExamined |
|---|---|---|---|---|
| **Before** — `find(...)` | `COLLSCAN` | 687 | 0 | **8000** |
| **After** — `distinct("toUserId", ...)` | `PROJECTION_COVERED → DISTINCT_SCAN` | 687 | 688 | **0** |

The signature is textbook: `COLLSCAN` examining **every document** in the
collection to return 687, versus a **covered** `DISTINCT_SCAN` that examines
**zero documents** (reads index keys only). `totalDocsExamined` went `8000 → 0`,
and it stays 0 no matter how large the collection grows, because the scan is
bounded by the number of matching *keys*, not the collection size.

### Options considered
1. **Plain compound index `{status: 1, createdAt: 1}`.** Fixes the COLLSCAN
   (IXSCAN instead), but the query still fetches and populates full documents,
   and the index carries rows for *every* status even though only `interested`
   is ever queried this way.
2. **Partial index on `{status, createdAt}` + keep `.find().populate()`.**
   Smaller index (only `interested` rows), but still fetches documents and still
   populates `fromUserId` — which the cron never reads.
3. **Partial index on `{status, createdAt, toUserId}` + rewrite to
   `distinct("toUserId")` + one projected `User.find`.** (chosen)

### Decision — option 3
- **Partial index** (`partialFilterExpression: { status: "interested" }`): only
  `interested` rows are indexed, so we don't pay index storage / write
  amplification for the `ignored`/`accepted`/`rejected` rows this query never
  touches.
- **Trailing `toUserId` in the key** makes the `distinct` a *covered* query —
  MongoDB answers it entirely from the index, `totalDocsExamined: 0`.
- **Rewrite the query** from `.find().populate("fromUserId toUserId")` to
  `distinct("toUserId", ...)` → `User.find({_id: {$in: ids}}, {emailId: 1})`.
  This also fixes a latent bug: `fromUserId` was being populated but never used,
  and the cron only ever needed the recipients' email addresses.

### Outcome / estimate
`totalDocsExamined` 8000 → 0 on the seeded set, and — the important part — it is
now **independent of collection size**. Before, the daily cost scaled linearly
with total swipes ever made; after, it scales only with *yesterday's* interested
requests. At, say, 5M lifetime `ConnectionRequest` docs, the before-query
examines all 5M every morning; the after-query examines 0 documents and a few
hundred index keys.

---

## The follow-up: decouple the side effect (BullMQ)

Fixing the query removes *this* incident. Moving the email send off the cron path
removes the whole *class* of "a slow downstream dependency stalls our job/request"
problem — which is the stronger, forward-looking half of the story.

### What we did
- `src/queues/connection.js` — a factory returning a **dedicated** ioredis
  connection for BullMQ (`maxRetriesPerRequest: null`, which BullMQ's blocking
  commands require). Per the Phase 0 decision, BullMQ gets its own connections
  rather than reusing the shared `config/redis.js` client.
- `src/queues/emailQueue.js` — the `email` queue + an `addEmailJob()` helper.
  `defaultJobOptions`: **5 attempts, exponential backoff (5s → 80s)**,
  `removeOnComplete` capped, and `removeOnFail` kept (a poor-man's dead-letter
  set for inspection). This is the answer to "what happens when the email
  provider is down": the job retries, then parks in the failed set — it never
  silently vanishes.
- `src/workers/emailWorker.js` — the consumer. Calls `sendEmail.run()`, logs
  `completed`/`failed` (with attempt count). Runs in a **separate process**
  (`npm run worker`), so notification volume can't steal CPU from the API tier.
- **Cron becomes producer-only**: compute recipients (covered `distinct` + one
  projected `User.find`), enqueue one job per recipient, return immediately.

### Bug fixed along the way: `src/utils/sendEmail.js`
It **hardcoded the recipient** (`akshaysaini.in@gmail.com`) and ignored its
`toEmailId` argument, so every notification would have gone to the same inbox.
Since the worker enqueues one job per recipient, it *needs* per-recipient
delivery — so `run()` now uses `toEmailId` (and throws if it's missing rather
than silently mis-delivering). The sender is now `SES_FROM_ADDRESS` (env), with
the old address as fallback.

---

## Reusing the queue: hardening the payment webhook

`src/routes/payment.js`'s webhook had three real bugs, all fixed by moving the
work onto a second BullMQ queue (`src/queues/paymentQueue.js` +
`src/workers/paymentWorker.js`):

1. **It upgraded the user to premium on *any* event**, including
   `payment.failed`. Now the worker branches on `req.body.event` and only
   `payment.captured` sets `isPremium`.
2. **No null check** — it assumed `Payment.findOne(...)` and `User.findOne(...)`
   always returned a doc and would 500 on a null. The worker guards both.
3. **Not idempotent** — Razorpay redelivers webhooks. Two guards now:
   - **Queue-level:** the Razorpay event id (`X-Razorpay-Event-Id`) is used as
     the BullMQ `jobId`, so a redelivered event is de-duplicated by the queue
     itself (adding a job with an existing id is a no-op).
   - **Worker-level:** the worker applies an idempotent *end-state* (setting
     `isPremium = true` again is harmless), so even a redelivery that slipped
     past the jobId window (job already evicted from history) can't cause double
     effects.

And the throughput fix: once the signature is verified, the route **acks 200
immediately** and pushes the DB work onto the queue. This is the direct answer to
"how do you absorb a burst of webhook calls" (e.g. a promo/sale completing many
payments at once) — Razorpay's delivery never backs up waiting on our DB writes.

> Note: the payment router stays commented out in `src/app.js` locally (it
> depends on `RAZORPAY_KEY_ID` / `RAZORPAY_WEBHOOK_SECRET`, which aren't set on
> this machine — see the seed commit d757101). The hardened handler + queue +
> worker are complete and were verified against seeded data through the worker
> directly; enabling the route is a one-line uncomment once the Razorpay env
> vars exist.

---

## Design decisions (interview-ready)

**Why a partial index instead of a plain compound one?**
Only `status: "interested"` is ever queried by `createdAt` (the cron). Indexing
the other three statuses would grow the index and add write-amplification on
every non-interested write for zero query benefit. The partial index indexes
exactly the rows the query can return.

**Why `distinct` + a second query instead of `.find().populate()`?**
The cron only needs recipients' email addresses. `distinct("toUserId")` is a
covered query (0 docs examined) against the new index; a single projected
`User.find({_id: {$in}}, {emailId: 1})` then fetches just the emails. `populate`
was doing two joins' worth of work (both sides) and materialising full documents
to read one field — and it populated `fromUserId`, which was never used.

**Why BullMQ over doing the email inline (or over Kafka)?**
Inline coupling means a slow SES call stalls the cron (and, for the webhook, the
HTTP response). A queue decouples them and gives retries/backoff for free.
Kafka/SQS would be over-engineering at this volume — BullMQ runs on the Redis we
already stood up in Phase 0. The *signal* that would make me revisit (durability
/ replay / multiple consumer groups) is written down in the Phase 5 roadmap.

**Fail-open vs fail-closed if Redis is down?** For **email** (the cron): the job
enqueue is the whole point, so if Redis is down the cron logs and the run is
lost — acceptable, it's a best-effort daily nudge, and it'll catch the next day.
For the **payment webhook**: enqueue failure means we return 500 and Razorpay
retries — fail-*closed*, because we must not ack a payment we haven't durably
recorded. Same infra, opposite choice, because of what each path protects.

**Two separate queues (email, payment) but one worker process?**
Separate queues give independent retry semantics and let either be split into its
own deployment later without a code change. One worker process for now
(`npm run worker` requires both) is scale-appropriate — operationally "the
worker," logically two consumers.

**Idempotency: jobId vs a unique DB index on the event id?**
Using the event id as the BullMQ `jobId` de-dups redeliveries at the queue with
no schema change. Its one limit is history retention — once a completed job is
evicted, a much-later redelivery of the same id could re-enter. That's why the
worker *also* applies an idempotent end-state (defence in depth) rather than
relying on the jobId alone. A unique index on a stored `razorpayEventId` is the
stronger permanent guard and is the natural next step if redeliveries ever prove
to arrive outside the retention window.

---

## Verification

All verified **live** against the running Redis + Mongo:

- ✅ **`.explain("executionStats")` before/after** (8,000 seeded docs): `COLLSCAN`
  / `totalDocsExamined: 8000` → `PROJECTION_COVERED → DISTINCT_SCAN` /
  `totalDocsExamined: 0`. (Run in a throwaway collection; no real data touched.)
- ✅ **Queue enqueue** — `addEmailJob` / `addPaymentJob` land jobs in Redis;
  waiting counts confirmed.
- ✅ **jobId de-dup** — enqueuing the same Razorpay event id twice yields one job
  (same id, one waiting).
- ✅ **Email worker** — consumes jobs; the missing-`toEmailId` guard fails
  non-retryably; a real SES failure (no creds locally) is logged and retained in
  the failed set.
- ✅ **Payment worker (end-to-end, seeded user+payment)**:
  - `payment.captured` → `isPremium: true`, `membershipType: gold`, payment
    status/`paymentId` updated.
  - Redelivery (same event id) → deduped, state unchanged.
  - `payment.failed` → status recorded as `failed`, `isPremium` stays `false`
    (the original "any event upgrades" bug is gone).
- ✅ **Worker process boots** — `npm run worker` connects to Mongo and starts
  both consumers.

---

## Files added / changed

| File | Change |
|------|--------|
| `src/models/connectionRequest.js` | **+** partial covering index `{status, createdAt, toUserId}` |
| `src/utils/cronjob.js` | rewritten: covered `distinct` + projected `User.find`; producer-only (enqueues) |
| `src/utils/sendEmail.js` | honour `toEmailId` (was hardcoded); `SES_FROM_ADDRESS`; guard missing recipient |
| `src/queues/connection.js` | **new** — dedicated BullMQ Redis connection factory |
| `src/queues/emailQueue.js` | **new** — email queue + `addEmailJob`, retry/backoff, DLQ retention |
| `src/queues/paymentQueue.js` | **new** — payment queue + `addPaymentJob` (jobId = event id) |
| `src/workers/emailWorker.js` | **new** — email consumer, completed/failed logging |
| `src/workers/paymentWorker.js` | **new** — payment consumer, idempotent, event-type branching |
| `src/workers/index.js` | **new** — `npm run worker` entrypoint (both consumers + DB) |
| `src/routes/payment.js` | webhook: verify → ack 200 → enqueue; removed inline DB writes + unused `User` import |
| `package.json` | **+** `worker` / `worker:dev` scripts |
| `.env.example` | **+** `SES_FROM_ADDRESS`, `RAZORPAY_WEBHOOK_SECRET` |
| `docs/phase-1.md` | **new** — this write-up |

## Anticipated interviewer follow-up questions

**Q: How did you find the COLLSCAN?**
`.explain("executionStats")` on the cron query. The tell is `stage: "COLLSCAN"`
with `totalDocsExamined` equal to the collection size — it's reading everything
to return a handful of rows.

**Q: Why did it only show up at scale / at 8am?**
COLLSCAN cost is linear in collection size and correct-but-slow, so it's
invisible when the collection is small and produces no errors ever. It runs on a
fixed cron, so the symptom is a recurring DB-CPU spike at a fixed time — easy to
misread as "traffic" rather than "one bad query."

**Q: What's a covered query and how do you know this one is covered?**
The index contains every field the query needs (predicate *and* returned field),
so MongoDB never fetches documents. The proof is `totalDocsExamined: 0` with a
`PROJECTION_COVERED`/`DISTINCT_SCAN` plan.

**Q: What if the email provider is down?**
The send is a queued job with 5 exponential-backoff retries; after that it parks
in the failed set (logged), so it's recoverable, not lost — and it never blocked
the cron or a request in the first place.

**Q: How do you handle duplicate webhook deliveries?**
Two layers: the Razorpay event id is the BullMQ jobId (queue-level de-dup), and
the worker applies an idempotent end-state (so a redelivery outside the job's
retention window still can't double-apply). A unique index on a stored event id
is the documented next step if needed.

**Q: Why ack 200 before doing the work?**
To absorb bursts (a sale completing many payments at once) without Razorpay's
delivery timing out or backing up. We only ack *after* the signature is verified
and the job is durably enqueued — never before.

---

## Next: Phase 2
Membership-tier rate limiting (atomic Redis `INCR`+`EXPIRE`) + the
check-then-act duplicate-request concurrency fix + cursor-based feed pagination.
