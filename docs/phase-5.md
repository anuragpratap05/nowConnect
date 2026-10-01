# Phase 5 — Future scaling roadmap (write-up only, no code)

**One-line summary:** an ordered list of what would break next and what I would do
about it — each item with the signal that says it is due, the change, the cost, and
the reason it is *not* worth doing today — written so that "how would you scale
this further" has a first half that already shipped (Phases 1–4) and a second half
that is a plan rather than a list of technologies.

This phase deliberately produces no code. That is not a shortcut: the point of the
phase is to answer a question interviewers actually ask (Q6 in
[`project_enhancement_plan.md`](../project_enhancement_plan.md) — "how you scaled
it / would scale it further"), and the thing that makes that answer good is
ordering and justification, not implementation. A roadmap that lists Kafka,
Kubernetes and sharding is a worse answer than one that says "the next thing I
would fix is a `findById` in an auth middleware, and here is the metric that tells
me when it matters."

Because it is docs-only, this phase needs no local infrastructure — no Redis, no
MinIO, no worker process. Everything it asserts is grounded in artifacts that
already exist in the repo (see [Verification](#verification--what-grounds-each-claim)).

---

## How this roadmap is ordered

The ordering rule is **what breaks first**, which is not the same as what is
biggest. It is:

> frequency of the path  ×  how its cost grows with scale

A query that runs on every authenticated request and whose cost is constant still
outranks a sharding project, because the first is cheap to fix and compounds on
every single request, and the second is expensive, near-irreversible, and only
pays once a collection outgrows one machine.

Every item below has the same four fields, so that the list can be read as a
backlog rather than as prose:

- **Trigger** — the observable signal that says this item is now due. An item with
  no trigger is a preference, not a plan.
- **Change** — what I would actually do.
- **Cost / risk** — what it buys and what it breaks. Stated honestly, including the
  items where the fix weakens something else.
- **Why not now** — because "we didn't do it" and "it wasn't worth doing" are
  different answers, and only the second is a design decision.

The tiers are about *when*, not importance:

| Tier | Meaning |
| --- | --- |
| **Tier 0** | Outranks the whole roadmap — correctness and security debt |
| **Tier 1** | Due now or next; cheap, reversible, high-frequency paths |
| **Tier 2** | Due at the next order of magnitude of traffic or data |
| **Tier 3** | Due only when a specific shape changes (graph model, write volume, team size) |

---

## The half that already shipped

This table is the first half of any "how would you scale this" answer, and it is
the half that makes the second half credible. Each row is a real before/after with
a measured number, not an assertion.

| Problem | Fix | Measured outcome | Phase |
| --- | --- | --- | --- |
| Daily cron `COLLSCAN` on the fastest-growing collection | Partial covering index `{status, createdAt, toUserId}` + covered `distinct` query | `totalDocsExamined` 8,000 → **0** | [1](phase-1.md) |
| Email send blocking the cron path; provider outage = lost work | BullMQ queue + worker process, exponential backoff | Side effect off the request path entirely | [1](phase-1.md) |
| Razorpay webhook upgrading users on *any* event, non-idempotent | Branch on event, guard lookup, idempotency on redelivery, ack-then-enqueue | Redelivery is a no-op | [1](phase-1.md) |
| Feed re-reading the user's entire interaction history per page | Redis exclusion set, fan-out-on-write, 10-min TTL, fails open to Mongo | Unbounded read → bounded | [2](phase-2.md) |
| `skip`/`limit` pagination degrading on deep pages | `_id` cursor pagination | `keysExamined` at page 1000: 10,021 → **11** | [2](phase-2.md) |
| Duplicate connection requests under concurrency (check-then-act) | Unique partial index on canonicalised `{userIdLow, userIdHigh}` pair; `E11000` → `409` | 10-way burst: **8 rows → 1** | [2](phase-2.md) |
| Free-tier swipe abuse hitting Mongo | Atomic Redis `INCR` counter per tier, fails open | Hottest write path off the primary | [2](phase-2.md) |
| All chat messages in one embedded document (16MB cap) | `Message` collection indexed `{chatId, _id}` | Cap reproduced at 1,050×16KB (`BSONObjectTooLarge`); history `keysExamined` at depth 10,000: 10,110 → **50** | [3](phase-3.md) |
| Socket.io rooms in-memory — a second instance cannot deliver | `@socket.io/redis-adapter` pub/sub pair | Horizontal scaling of the socket tier becomes correct, not just possible | [3](phase-3.md) |
| No authz on chat; client-supplied sender identity | Handshake JWT auth (`io.use`) + shared `connectionGuard` on both HTTP and socket paths | Spoofed sender id ignored; unconnected pair refused | [3](phase-3.md) |
| Duplicate `Chat` documents under concurrency | Canonical-pair unique index + atomic `findOneAndUpdate(upsert)` | 20-way burst: **17 documents → 1** | [3](phase-3.md) |
| Image bytes proxied through Node | Presigned `PUT` direct to object storage | Upload cost to the API is constant regardless of file size | [4](phase-4.md) |
| `$or` `COLLSCAN` on a user-facing route | Two direction-specific indexes, trailing field chosen for coverage | `SUBPLAN → COLLSCAN` / 8,000 docs → `OR → IXSCAN` / **0 docs**, 126 keys | [4](phase-4.md) |
| Likes as an embedded array (the Phase 3 mistake, pre-empted) | `Like` collection, unique `{postId, userId}`, `$inc` counter | Idempotent by index, not by application check | [4](phase-4.md) |
| CPU-bound resize on the request path | BullMQ + `sharp` worker, `thumbnailKey: null` as a valid state | Backlog degrades image weight, never availability | [4](phase-4.md) |

Two things in that table matter more than the individual rows, and both are what
the roadmap below builds on:

1. **There is one pagination convention** (`_id` cursor, descending, `limit + 1` to
   detect the next page) used by the swipe feed, chat history and the posts feed.
   Three call sites, one convention — so a pagination change is one change.
2. **The queue infrastructure was built once and reused three times** (email,
   payment, thumbnails). The third consumer cost one queue file and one worker
   file. That is the property that makes several Tier 1 and Tier 2 items below
   cheap — they are new jobs on existing infrastructure, not new infrastructure.

---

## Tier 0 — What outranks this entire roadmap

An honest roadmap has to say this out loud: **there is open security debt that
outranks every scaling item below it.** [`ISSUES.md`](../ISSUES.md) still lists,
unannotated and therefore unfixed:

- **Hardcoded JWT secret** ([`src/models/user.js:86`](../src/models/user.js:86))
  signs tokens with a literal string that is committed to git, while
  [`src/middlewares/auth.js:11`](../src/middlewares/auth.js:11) verifies against
  `process.env.JWT_SECRET`. Anyone who can read the repo can forge a token for any
  user id.
- **Password hash returned to the client** — no `select: false` on the field, and
  signup / login / `/profile/view` / `/profile/edit` all return the full document.
- **Webhook signature validated against re-serialized JSON**
  ([`src/routes/payment.js:58`](../src/routes/payment.js:58)) instead of the raw
  request bytes Razorpay actually signs.
- **Auth cookie not hardened** — no `httpOnly`, `secure` or `sameSite`, and an 8h
  cookie expiry against a 7d token expiry.
- **Self-service email change** with no re-verification.
- **Secrets and PII in logs** — the signup password-hash log and the
  `/premium/verify` full-user log are both still there.

None of these is a scaling problem, and that is exactly why they belong at the top
of a scaling roadmap: **you do not shard a database whose tokens can be forged.**
Sharding `ConnectionRequest` behind a forgeable JWT makes a security hole faster
and more expensive to fix, not less severe.

There is also one that is simultaneously security debt and the Tier 1 scaling item
below it — the password hash leak and the per-request `findById` are the same
line of code, which is why fixing them in that order matters (see Item 1).

**Trigger:** none needed. This tier is due now.
**Why it is not in this phase:** Phase 5 is write-up only by design, and these are
code changes. They are named here so that the roadmap cannot be read as "the
project is secure, here is how to make it bigger."

---

## Tier 1 — Due now or next

### Item 1 — `userAuth` does a `User.findById` on every authenticated request

[`src/middlewares/auth.js:15`](../src/middlewares/auth.js:15), and
[`ISSUES.md`](../ISSUES.md) Scaling #4 — the one scaling finding from the original
review that is still open. It is first on this list because of pure arithmetic:
**it is the single most-executed query in the application.** Every authenticated
route — every feed page, every swipe, every chat history fetch, every posts feed
render, every like — pays one unprojected `findById` before its own work begins.

#### The part that is not obvious

The reflexive fix is "put the user's fields in the JWT and skip the database." That
is wrong here, and understanding why is the whole item.

The token already carries `_id`. The database read exists for two reasons that a
claim in a token cannot serve:

1. **Existence and standing.** A token is valid for 7 days. If the account is
   deleted or banned on day 1, a self-contained token keeps working until day 7.
   The `findById` is what makes revocation possible at all.
2. **`isPremium` is read as an authorization input, not as a display field.**
   Phase 2's tier rate limiter reads the membership tier to pick a ceiling from
   [`swipeLimits`](../src/utils/constants.js). A user who pays for Silver expects
   100 swipes *immediately* — not after their 7-day token rotates. Baking tier into
   the token means the upgrade a customer just paid for does not take effect, which
   is a billing complaint, not a cache miss.

So the read is load-bearing. The fix is not to remove it but to make it not hit
Mongo every time.

#### Change

A Redis cache-aside on `user:{id}`, in this order:

1. **First, add `select: false` to `password`** (Tier 0 above). This has to come
   first, because the middleware currently fetches the full document — so a naive
   cache of what it fetches would write password hashes into Redis. Fixing the leak
   before building the cache is the difference between one bug and two.
2. Cache **the projection the middleware actually needs**, not the document:
   `_id`, `isPremium`/membership tier, and whatever else `req.user` consumers
   genuinely read. Caching a whole Mongoose document also means caching something
   that is not a Mongoose document on the way back, so the projection boundary has
   to be explicit rather than accidental.
3. **Short TTL (~60s) *and* explicit invalidation on both writers.** There are
   exactly two paths that change the cached fields: `PATCH /profile/edit`, and the
   payment worker's premium upgrade. TTL alone would make a paid upgrade take up to
   a minute; explicit invalidation makes it immediate and leaves the TTL as a
   backstop for changes the app never saw (a manual DB fix, a script).
4. **Fail open to Mongo**, logging the miss — the same posture as
   [`feedCache`](../src/utils/feedCache.js) and the Phase 2 rate limiter. A Redis
   outage must degrade to "as slow as it is today", not to "nobody can log in."

#### Cost / risk

This is the one place in the codebase where I would cache something
authorization-adjacent, which sits in direct tension with the rule written into
[`src/utils/connectionGraph.js:65-87`](../src/utils/connectionGraph.js:65) — that
the accepted-connections list is deliberately *not* cached because it is the posts
feed's access-control boundary and a stale entry means showing a removed
connection's posts.

The distinction, and it is a real one rather than a convenient one:

- A stale **connection list** is a *visibility* boundary. Being wrong for 60
  seconds leaks another user's content, and the leak is invisible to everyone.
- A stale **tier flag** is a *capability* ceiling. Being wrong for 60 seconds means
  someone gets 100 swipes instead of 20 for a minute. Bounded, self-correcting, and
  not a privacy event.

The genuinely uncomfortable case is **deletion and banning**: a 60-second stale
cache means a banned account can act for up to a minute. That is why invalidation
is explicit on the writers rather than TTL-only — and it means a future
delete-account or ban path must drop the key as part of the operation. Worth noting
that the app has no account-deletion route today, so this is a constraint on
whoever writes one, recorded here rather than discovered later.

#### Why not now

It was out of scope for every earlier phase (each had a theme), and unlike the two
`COLLSCAN`s it has no pathological growth — the cost is one indexed primary-key
lookup, constant per request. It is first on this list because of *frequency*, not
because it is slow. Which also means it is the item most likely to be invisible
without the instrumentation in Item 4.

**Trigger:** when `findById` on `users` is a material share of the primary's total
op count — visible in `$indexStats`/`currentOp` sampling or Atlas's query profiler
— or when authenticated RPS grows to the point where the auth middleware's share of
p50 latency is measurable. The honest version: today nothing in the app would tell
you, which is Item 4's argument.

---

### Item 2 — Drop the dead `{fromUserId, toUserId}` index

[`src/models/connectionRequest.js:45`](../src/models/connectionRequest.js:45),
with the reasoning already written at
[lines 129–136](../src/models/connectionRequest.js:129). Phase 2 removed the only
query that used it — the `findOne` existence pre-check, replaced by letting the
canonical-pair unique index reject the duplicate — so it now costs a write on every
insert into the fastest-growing collection in the app, and serves no read.

#### The part that is not obvious

**"Dead" has to be proven from the database, not from the code.** Grepping for
queries is not sufficient: the planner can choose an index for a query shape nobody
wrote deliberately, and a one-off script, a migration, or the 8 AM cron can be the
only consumer. The procedure is:

```js
db.connectionrequests.aggregate([{ $indexStats: {} }])
```

`accesses.ops` is per-index usage since the last server restart. The index is
droppable when that number is `0` over a window that covers a **full business
cycle** — including the daily cron and any backfill script
([`src/scripts/backfillRequestPairs.js`](../src/scripts/backfillRequestPairs.js)
is exactly the kind of thing that would show up here).

It is also worth being precise about what this index is *not*: it is not subsumed
by the Phase 4 indexes. Its prefix `{fromUserId}` is covered by
`{fromUserId, status, toUserId}`, but a hypothetical query on `{fromUserId,
toUserId}` *without* `status` could not use that index efficiently, because
`status` sits between them. So the correct claim is "no current query needs it",
not "it is redundant" — and that is precisely why `$indexStats` is the evidence
rather than reasoning.

#### Cost / risk

The asymmetry is the whole reason this is its own change: **dropping is instant,
rebuilding is not.** On a large collection, re-adding it is a background index
build with real I/O cost and a long completion time. So the rollback for "we
dropped it and something regressed" is expensive even though it is possible — which
is the definition of a change that deserves its own deploy, its own verification,
and no other change riding along with it.

**Gain:** one fewer index write per insert on the collection that takes a write on
every swipe, plus the index's share of the working set.

#### Why not now

Phase 4 explicitly deferred it for this reason, and bundling an irreversible-ish
storage change into a feature phase is how a feature rollback becomes a storage
incident.

**Trigger:** `$indexStats.accesses.ops == 0` sustained across a full cycle. Then do
it alone.

---

### Item 3 — Split the thumbnail worker into its own deployment

[`src/workers/index.js:10-18`](../src/workers/index.js:10) already documents this,
and the design that makes it cheap was deliberate in Phase 1: all three workers run
in one process operationally, but they are **separate BullMQ queues**, so splitting
one out is a deployment change, not a code change.

#### The part that is not obvious

The thumbnail worker is the first workload in the app that is **CPU- and
memory-bound rather than network-bound**, and mixing those two kinds in one Node
process is specifically bad rather than generally untidy:

- Email and payment jobs are almost entirely *waiting* on someone else's API. They
  cost a socket and some memory.
- A thumbnail job holds a multi-megabyte buffer and saturates **libuv's
  threadpool** while `sharp` decodes and re-encodes. The default threadpool is 4
  threads, so a handful of concurrent resizes exhausts it — and once it is
  exhausted, *every other libuv consumer in the process queues behind image
  resizing*, including DNS resolution and file I/O for work that has nothing to do
  with posts.

So the coupling is not "thumbnails are slow", it is "thumbnails make unrelated jobs
slow through a shared resource that is invisible in the code."

#### Change

Run `thumbnailWorker` as its own deployment, and when splitting, set the two things
that only make sense once it is alone:

- `UV_THREADPOOL_SIZE` matched to the instance's core count, rather than the
  default 4.
- BullMQ `concurrency` set to roughly the core count rather than left high.
  Over-subscribing a CPU-bound worker does not increase throughput — it adds
  queueing latency and memory pressure, because the bottleneck is cores, not
  waiting.

The split deployment still needs Mongo (it writes `thumbnailKey` back onto the
`Post`), so it is not a pure compute box — and it still needs the S3 client. It is
a differently-shaped instance, not a different architecture.

#### Cost / risk

One more deployable to operate, build and monitor, for a workload that is currently
small. That is the entire reason it has not happened yet.

#### Why not now

Acceptable at this size, and said so in the code at the time rather than
retroactively. The infrastructure choice that matters was made in Phase 1 — separate
queues — and it is what keeps this a configuration decision instead of a
refactor.

**Trigger:** email or payment job latency correlating with upload volume. Concretely:
watch the `waiting` count and job age on the email queue against the thumbnail
queue's throughput. If email job age rises during upload bursts, the processes are
coupled and it is time to split. (Another thing nothing currently measures — see
Item 4.)

---

### Item 4 — Observability, because three designs degrade *silently* by choice

This item is not in the original plan, and it is the one I would actually argue for
hardest, because it is a prerequisite for the rest of this roadmap being executable
rather than aspirational.

#### The part that is not obvious

Every performance finding in Phases 1–4 was discovered by **reading code and then
running `.explain("executionStats")` by hand** against a seeded local database.
That method produced genuinely good results — the Phase 1 cron `COLLSCAN`, the
Phase 4 `$or` subplanner `COLLSCAN`, the 2,525-vs-11 `docsExamined` comparison on
the feed index — and it has one fatal property as a production practice:

> **Nothing in the application would have told me.** Both `COLLSCAN`s were found
> because I went looking. Neither would have raised an alert.

And it is worse than merely unmonitored, because **three separate Phase 1–4 designs
deliberately convert a failure into an invisible degradation**:

| Design | Degrades to | Who notices |
| --- | --- | --- |
| [`feedCache`](../src/utils/feedCache.js) fails open to Mongo on a Redis error | Correct results, unbounded reads — i.e. pre-Phase-2 performance | `console.error`, nobody |
| `thumbnailKey: null` is a valid renderable state ([`post.js:55-69`](../src/models/post.js:55)) | Full-size images in every feed render | Nobody; the feed looks fine and costs 10× the bandwidth |
| Socket.io Redis adapter down → local-instance delivery continues ([`socket.js`](../src/utils/socket.js)) | Messages deliver *within* an instance, silently not across | Users, eventually, as "chat is flaky" |

Each of those is the *right* availability decision. Each also means a real outage
presents as "the app feels normal". **Graceful degradation without instrumentation
is just an outage you have not noticed yet** — and that is the argument for this
being Tier 1 rather than a nice-to-have.

#### Change, in the order I would do it

1. **Mongo slow-query profiling** (`operationProfiling.slowOpThresholdMs`, or
   Atlas's profiler / Performance Advisor). This is the single highest-value one:
   it is the thing that would have surfaced *both* `COLLSCAN`s automatically, which
   is a concrete, falsifiable claim about its value rather than a general belief in
   monitoring.
2. **Per-route latency histograms** — p50/p95/p99 and error rate, not averages. An
   average hides exactly the deep-pagination and dense-graph cases Phases 2–4 were
   about.
3. **Queue health:** depth, oldest-job age, and failed-job count per queue. This is
   what makes the `thumbnailKey: null` design safe *to operate* rather than just
   safe to write — the backlog is invisible by construction, so it has to be
   visible by instrument.
4. **Cache hit rate** on `feedCache` and (after Item 1) the user cache. Both fail
   open, so a hit rate collapsing to zero is a silent full-cost fallback.

#### Cost / risk

Real work with no feature output, which is why it is the easiest item on this list
to keep postponing.

#### Why not now

Honestly: each phase had a theme and this was not one of them, and a local seeded
database with a script that prints `executionStats` was the right tool for building
*before/after evidence*. It is the wrong tool for knowing what to look at next.

**Trigger:** this one is unconditional. It is the item that produces the triggers
for every other item.

---

## Tier 2 — Due at the next order of magnitude

### Item 5 — Read replicas for read-heavy, eventually-consistent paths

**Change:** `readPreference: secondaryPreferred`, applied **per query** (Mongoose
supports `.read("secondaryPreferred")` on a query) on the paths that are read-heavy
and already tolerate staleness: the swipe feed, the posts feed, profile views.

#### The part that is not obvious

This is not safe to set globally, and the failure mode is **read-your-own-writes**,
which this app has in two concrete places:

- `POST /posts` → `GET /posts/feed`. The author expects to see the post they just
  made. A secondary read can miss it, and "my post vanished" is a worse bug than a
  slow feed.
- `PATCH /profile/edit` → `GET /profile/view`. Same shape.

So the correct granularity is per-query, and the paths where it is safe are the
ones whose staleness is *already* bounded by something else — the swipe feed, for
instance, already tolerates a ≤10-minute stale exclusion set by design
([`feedCache`](../src/utils/feedCache.js)), so a few hundred milliseconds of
replication lag changes nothing about its correctness envelope.

**Cost / risk:** cheap and reversible — no schema change, one line per query. The
risk is entirely in choosing the wrong queries, which is why the rule is "only
where staleness is already part of the contract."

**Honest limit:** replicas add read throughput, not write throughput. Nothing in
this app is write-bound yet; the heaviest write path is swipes, and Phase 2 moved
the *rate-limit counter* to Redis but the `ConnectionRequest` insert still goes to
the primary. So this item buys headroom on the read side only, and the write side
has no item until Tier 3's sharding.

**Trigger:** primary CPU or IOPS dominated by reads, with replication lag
comfortably under the staleness budget of the candidate paths.

---

### Item 6 — Cache-aside for `/profile/view`

**Change:** cache the public profile projection, short TTL, invalidate on
`/profile/edit`.

#### The part that is not obvious

**This is the same cache as Item 1, and that is the point.** The user record cached
by the auth middleware is already most of what `/profile/view` returns. Building a
second, independently-invalidated cache of the same document would mean two derived
copies, two TTLs and two invalidation paths over one source of truth — which is how
caches become correctness bugs.

So the actual design decision here is: **one `user:{id}` cache, two readers, one
invalidation path.** Item 6 is then not a new cache at all; it is a second consumer
of Item 1's, which is why it is cheap and why it must come second.

**Cost / risk:** the profile projection is larger than the auth projection, so
either the cached value covers both (and the auth path reads more than it needs) or
the key holds the union and each reader projects. The second is better and is worth
deciding deliberately rather than by accident.

**Why not now:** no measured pressure on `/profile/view`, and the rule from
[`connectionGraph.js:85-87`](../src/utils/connectionGraph.js:85) applies — *cache
to fix an access pattern whose cost is unbounded, not to shave a millisecond off
one that is already proportional to its result.* `/profile/view` is a primary-key
lookup. It qualifies on read:write ratio, not on unbounded cost, which makes it a
real but second-order win.

**Trigger:** `/profile/view` appearing as a top-N query by total time in the
profiler from Item 4.

---

### Item 7 — CloudFront + origin access control, replacing per-viewer presigned GETs

Already documented as the production answer at
[`src/utils/postStorage.js:186-191`](../src/utils/postStorage.js:186).

#### The problem, quantified

Reads are signed, not public, and that is deliberate: posts are visible only to the
author's accepted connections, and a public object URL is readable by anyone who
has it, forever — so making the bucket public would move the access rule into the
API only, and *an access control that only one of two doors enforces is not an
access control.*

The cost of that choice is cacheability. [`withViewUrls`](../src/routes/post.js:603)
signs an image URL **and** a thumbnail URL per post, so a default 10-post feed page
mints up to **20 presigned URLs**, each unique to that viewer and valid for one
hour ([`VIEW_URL_TTL_SECONDS`](../src/utils/constants.js:51)). Signing itself is
local HMAC — no network round trip, so this is not a latency problem on our side.
The problem is that **the URL is the cache key**: the same popular image fetched by
200 connections is 200 distinct URLs, so it is 200 origin fetches from S3, paying
S3 egress and request cost every time, with a CDN unable to help.

#### Change

A CloudFront distribution in front of the still-private bucket, with an **origin
access control** (OAC; "origin access identity" is the older name) so that only
CloudFront can read the bucket — and **signed cookies rather than signed URLs**.

That distinction is the entire value: a signed *cookie* authorizes a **path
pattern** for a session, so the URL embedded in `<img src>` becomes **stable and
shared across viewers** and therefore edge-cacheable, while the bucket stays
private. Signed URLs per object would keep the cache-busting problem and buy
nothing.

#### Cost / risk — and this is where it gets uncomfortable

The app's access rule is **per viewer, per author** ("can I see this post? only if
we are accepted-connected"). A signed cookie scoped to `/posts/*` is **coarser than
that rule**: it authorizes its bearer for any object under that path, not just
their connections' objects. Two ways out, and neither is free:

- **Narrow the cookie's path scope per author** — viable precisely because Phase 4
  made the user id a key *prefix* (`posts/<userId>/<random>.jpg`) rather than a
  suffix, for exactly this family of reasons. But a feed page spans many authors, so
  this means many cookies or frequent re-issuance.
- **Lean on unguessable keys** — 16 random bytes per object, disclosed only to
  viewers the API has already authorized. You can only fetch what you can name.

The second is the pragmatic answer and it is also, stated plainly, **a weakening**:
it moves part of the access control from *enforced* to *unguessable*. That is a
defensible trade for images behind a mutual-connection graph, and it is the honest
reason this item is Tier 2 rather than Tier 1 — the win is cost and latency, and the
price is paid in the security property the current design was specifically chosen to
have.

**Why not now:** it is infrastructure configuration, and crucially **nothing in
[`postStorage.js`](../src/utils/postStorage.js) would change** — the module already
isolates URL minting behind `createViewUrl`. That containment is why this can wait
without accruing design debt.

**Trigger:** S3 egress or GET request cost becoming a visible line item, or
image-load latency for geographically distant users.

---

### Item 8 — Presigned POST with `content-length-range`

[`ISSUES.md`](../ISSUES.md) Scaling #6, and the full reasoning at
[`postStorage.js:120-148`](../src/utils/postStorage.js:120).

**The known gap, verified rather than assumed:** a presigned `PUT` URL cannot cap
object size — size is unknown at signing time and there is no signable header that
bounds it (`ContentLength` would pin one exact value a client cannot know in
advance). Phase 4 verified the consequence: a **24.7 MB upload against a URL issued
under a 5 MB policy returns `200` and stores the object.**

What Phase 4 did instead was mitigate at claim time: `POST /posts` runs a
metadata-only `HeadObject`, refuses with `413`, and **deletes** the object so the
endpoint cannot be used as free unlimited storage (verified:
`present (24733712 bytes)` → `ABSENT (404)`). Residual exposure: the bandwidth and
transient storage of one oversized object per deliberate attempt by an
authenticated user.

**Change:** `createPresignedPost` with a `["content-length-range", 1,
MAX_IMAGE_BYTES]` policy condition — the only option where **S3 itself rejects the
bytes before storing them**.

**Cost / risk:** a new dependency (`@aws-sdk/s3-presigned-post`), and the client
goes from a one-line `fetch(url, {method: "PUT", body: file})` to a multipart form
with a dozen policy fields. That makes it a **two-repo change** — it ripples into
[`nowConnect-web`](https://github.com/anuragpratap05/nowConnect-web), which is a
real coordination cost, not just extra code. It also does **not** remove the
claim-time `HeadObject`, which still guards the other cases (object absent, or a
key the caller does not own). And it caps *size*, still not *content*: `sharp` in
the thumbnail worker remains the only thing that actually parses the bytes.

**Trigger:** when the residual exposure stops being "one oversized object per
deliberate attempt by an account holder" — i.e. open/untrusted signup, or tightly
metered egress.

---

### Item 9 — Orphan reaping

From [`phase-4.md`](phase-4.md#orphaned-objects). Two orphan sources survive today:

1. A presigned URL is issued, the client uploads, and never claims → an object with
   no `Post` row. (The common case is not abuse: it is a user closing the app
   mid-upload.)
2. A thumbnail is generated in the window after its post was deleted → a
   `thumbs/` object with no row.

#### The part that is not obvious

**An S3 lifecycle rule on the `posts/` prefix cannot do this job.** Lifecycle rules
act on age, and they cannot distinguish a claimed object from an unclaimed one — so
"expire `posts/` after 7 days" would delete the images of every live post older than
a week. The naive answer is not merely imperfect, it is destructive.

That leaves two real designs, and they are complements rather than alternatives:

- **Prefix-as-state.** Upload to a `staging/` prefix; on claim, server-side
  `CopyObject` into `posts/` and delete the staged object. Then a brutally simple
  lifecycle rule — *expire `staging/` after 1 day* — does all the reaping, with no
  job to write, monitor or get wrong. The cost is a copy plus a delete on every
  claim, which makes the claim step slower; the copy is server-side within S3, so
  no bytes return to Node and the Phase 4 central property is preserved. This is the
  one I would choose.
- **Reconciliation job.** List the prefix, left-anti-join against `Post.imageKey`,
  delete objects with no row. It has a **subtle correctness condition**: it must only
  consider objects older than the upload URL TTL plus claim latency
  ([`UPLOAD_URL_TTL_SECONDS`](../src/utils/constants.js:47) = 5 min), or it will
  race a legitimate in-flight upload and delete an object the user is about to
  claim. Infrastructure for it already exists — a BullMQ repeatable job, which is
  the fourth reuse of Phase 1's queue.

**Recommendation:** prefix-as-state for prevention, and the reconciliation job as a
periodic audit that **reports** rather than deletes until its numbers are trusted. A
job whose first production action is bulk deletion of user content is a job that
should report first.

**Why not now:** the volume is negligible and object storage is cheap, so this is
hygiene rather than scaling. It gets expensive at a scale the app is nowhere near.

**Trigger:** orphan count or bucket size growing out of proportion to `Post`
document count — which is a number nobody currently computes.

---

## Tier 3 — Due only when a specific shape changes

### Item 10 — Hybrid fan-out for the posts feed

Phase 4 chose **fan-out on read** knowingly
([`phase-4.md`](phase-4.md#the-feed-fan-out-on-read-chosen-knowingly)): the feed is
`{userId: {$in: connections}, _id: {$lt: cursor}}` served by
`{userId: 1, _id: -1}`, which opens one index cursor per followed author and
`SORT_MERGE`s the streams.

#### The part that is not obvious

**The scaling limit of that design is not the number of posts — it is the `$in`
cardinality**, i.e. the viewer's connection count, because that is the number of
index cursors the planner opens and coordinates per page. Phase 4 measured both
directions of this, and the measurement is the reason the index exists at all
(50,000 posts, one 10-post page, `docsExamined`):

| Graph density | `_id`-walk | SORT_MERGE |
| --- | --- | --- |
| viewer follows 120 of 400 authors (30%) | 36 | 11 |
| viewer follows 120 of 20,000 authors (0.6%) | 2,525 | 11 |

The merge's cost stays flat at 11 as the user base grows, which is why it is right
for the regime the app is heading into. But the merge pays to open and coordinate
121 cursors to get there — and at 5,000 connections that is 5,000 cursors per page.
(Phase 4 also recorded the honest wrinkle: in the *dense* regime the planner picks
the merge anyway and is measurably slower for it, 14ms vs 0ms, because its cost
model undercounts cursor coordination overhead.)

**This app's graph is mutual connections, not asymmetric follows**, so connection
counts stay in the hundreds to low thousands — which is exactly why fan-out-on-read
was the correct call and why this item is Tier 3. The item only becomes due **if
the product model changes to one-way follows**, because that is what creates
accounts with millions of followers and puts the problem on the other side.

#### Change — and why "hybrid"

- **Normal accounts:** fan out on write. Maintain a materialized feed list per
  viewer in Redis; a new post pushes its id onto each follower's list. Reads become
  one bounded list read.
- **High-follower accounts:** do **not** fan out. Writing to two million feed lists
  per post is a thundering-herd write that would make posting, not reading, the
  bottleneck. Instead read those authors' posts at query time and merge them with
  the precomputed list.

Hence hybrid: the decision is **per author, keyed on follower count**.

#### Cost / risk

- **Picking the threshold.** The crossover is where `followers × cost of a feed-list
  write` exceeds `readers × cost of a merge branch`. I would not invent a number —
  I would instrument write amplification and pick the knee, and make it **runtime
  configuration rather than a constant**, because the right value moves with the
  graph. (Published practice puts it in the tens of thousands of followers.)
- **Backfill on a new follow** — the new connection's recent posts have to be pulled
  into the follower's list, or the feed looks broken for exactly the user who just
  took an action.
- **Trim policy** — the per-user list must be capped (a few hundred to ~800 entries).
  An unbounded per-user list in Redis is a memory leak with a social graph attached.
- **Two code paths produce one feed**, which is a correctness surface (dedup, and
  consistent ordering across a precomputed list and a live merge).

**Trigger:** the product changing to asymmetric follows, or p95 feed latency rising
with viewers' connection counts rather than with collection size.

---

### Item 11 — Presence tracking, and splitting the WebSocket gateway

**Presence first**, because it is the cheap half and it has a non-obvious
correctness requirement.

#### The part that is not obvious

Presence is **not a boolean per user**. One user has several devices and tabs, so
"offline" means *the last socket disconnected*, not *a socket disconnected* — which
makes the right structure a set of socket ids (or a refcount) per user. And since
Phase 3 put the [Redis adapter](../src/utils/socket.js) in place so that sockets
span instances, presence has to live in Redis to be cluster-wide at all.

The failure mode that makes a naive implementation wrong: **a process that dies
without running its disconnect handlers leaves its entries behind forever**, and the
user shows as permanently online. So presence must be **self-healing — TTL plus a
heartbeat refresh** — rather than purely event-driven `SADD`/`SREM`. That is the
difference between presence that survives a deploy and presence that drifts upward
until someone flushes a key by hand.

#### Splitting the gateway

**Change:** run the Socket.io layer as its own service, separate from the API tier.

The usual argument is capacity — long-lived sockets and request handling compete for
the same event loop, and they scale on different axes (sockets with *concurrent
connected users*: memory and file descriptors; API with *requests per second*). That
argument is true but it is not the strongest one.

**The strongest argument is deployment.** An API deploy is a rolling restart nobody
notices. A gateway deploy **disconnects every socket simultaneously** and triggers a
reconnect storm — every client reconnecting at once, each re-authenticating at the
handshake and re-joining rooms. Today those are the same process, so *every API
deploy is also a mass client reconnect*. Splitting them means the API can ship
continuously while the gateway is deployed deliberately and infrequently, with
connection draining.

**Cost / risk:** another service, and the two now share authentication (the same JWT
cookie — which Phase 3 deliberately made true, so the handshake logic is already
shared-shaped rather than API-shaped) and the connection-authorization check
([`connectionGuard`](../src/utils/connectionGuard.js)). That shared module becomes a
cross-service dependency, which is the real cost: it has to stay in step across two
deployables.

**Trigger:** socket count per instance approaching memory or fd limits, or API
deploy frequency being constrained by reconnect impact.

---

### Item 12 — Archive old `Message` and terminal `ConnectionRequest` rows

**And this is the item where the obvious plan is wrong, which makes it the most
useful one in Tier 3.**

#### `ConnectionRequest` — you cannot archive these yet

The plan's instinct is that `rejected`/`ignored` requests are terminal and never
read, so they can be TTL'd or archived. **That is false in this codebase**, and the
reason is a coupling that is easy to miss:
[`feedCache.computeExcludedIds`](../src/utils/feedCache.js:66) reads **every**
connection request the user has ever been part of — *regardless of status* — because
that history **is** the "don't show me this profile again" set.

So deleting rejected requests would **un-hide every profile the user has ever
rejected**. The storage cleanup would present as a product regression: profiles the
user explicitly dismissed coming back.

The honest conclusion is an ordering constraint: **the exclusion set has to be
decoupled from the request history before any of it can be archived.** That means
making "seen" its own durable per-user set — the source of truth rather than a
derivation — after which the terminal request rows become genuinely cold and
archivable. Two changes, in that order, and the second is blocked on the first.

#### `Message` — genuinely cold, but do not use a TTL index

Old messages *are* cold: chat history pages backwards from the newest
([`{chatId, _id: -1}`](../src/models/message.js:89)), and almost nobody scrolls past
the recent window. Archiving by `chatId` + age to cold storage keeps the hot
collection small enough that its index stays comfortably in RAM.

But **a Mongo TTL index is the wrong mechanism here**, and the distinction is worth
stating: a TTL index *deletes*. Deleting users' chat history is a product and legal
decision, not a storage optimization. TTL indexes are right for things that are
ephemeral by nature — sessions, rate-limit rows, one-time tokens — and wrong for
user-authored content. The mechanism for content is **archive, then prune**, with the
archive readable.

**Trigger:** the `Message` working set outgrowing RAM — visible as the index no
longer fitting, and page faults on history reads.

---

### Item 13 — Sharding, and the constraint that dictates the shard key

Shard `ConnectionRequest` and `Message` — the two collections that take a write on
every swipe and every message. Not `User` or `Payment`: sharding the small,
slow-growing collections would be solving the wrong problem and would add a `mongos`
hop to every auth lookup.

#### The part that is not obvious, and it is a hard blocker

**In a sharded collection, a unique index is only enforceable if the shard key is a
prefix of it.** That single rule reframes this entire item, because this codebase's
correctness rests on unique indexes:

- Phase 2's canonical-pair unique index `{userIdLow, userIdHigh}` on
  `ConnectionRequest` — the thing that turned "8 duplicate rows from a 10-way burst"
  into 1.
- Phase 4's unique `Post.imageKey` — the idempotency key that makes a retried claim
  a no-op instead of a duplicate post.

So choosing a shard key for `ConnectionRequest` is not a free distribution decision:
**sharding it on hashed `fromUserId` would silently break the uniqueness guarantee
Phase 2's whole concurrency fix depends on.** The duplicate-request bug would come
back, and it would come back in the form it is hardest to notice — invisible in
sequential testing, as it was the first time.

Working through it honestly:

- **`Message`:** `{chatId: "hashed"}`. Every read is already scoped by `chatId`, so
  a hashed key makes every history page a **single-shard targeted query** rather
  than scatter-gather, and the `_id` range within a chat stays on one shard. Hashing
  on a user id would be wrong — a message has two users and the query filters on
  neither. `Message` has no unique index, so the prefix rule does not bind. This one
  is clean.
- **`ConnectionRequest`:** genuinely hard, and worth admitting rather than
  hand-waving. Its reads go in **both** directions (the two Phase 4 indexes,
  `{fromUserId, status, toUserId}` and `{toUserId, status, fromUserId}`), plus the
  pair-uniqueness check. **No single key targets both directions**, because the
  document is one edge serving two access patterns. Options:
  1. Shard on hashed `fromUserId` — targets "requests I sent", scatter-gathers
     "requests I received", **and breaks the unique index**. Disqualified by the
     prefix rule, not by the scatter-gather.
  2. Shard on `{userIdLow, userIdHigh}` (ranged) — satisfies the prefix rule and
     keeps uniqueness, scatter-gathers both list queries. The remaining wrinkle:
     **ObjectIds carry a timestamp prefix**, so `userIdLow` skews toward
     early-registered accounts and a ranged key risks chunk hot-spotting. A hashed
     key would fix the skew but cannot be unique, so it is unavailable here.
  3. Denormalize into two directed edge documents per connection, so each is
     targeted by its owner — fan-out-on-write applied to the graph. Doubles writes
     on the heaviest write path to make both reads targeted.

Option 2 is where the prefix rule forces you, option 3 is what you would do if its
skew turned out to be real, and **naming option 3 and declining it for now is the
right answer today.**

**Cost / risk:** config servers and `mongos`, a near-one-way door (resharding exists
in 5.0+ but is expensive and slow), and operational complexity that dwarfs every
other item on this list. This is the item that most needs real distribution
measurement rather than a confident answer — and the strongest argument for **not
sharding until forced**.

**Trigger:** write throughput or working-set size genuinely exceeding one replica
set, *after* Items 5 and 12 are exhausted. Not before.

---

### Item 14 — Kafka or SQS, and why BullMQ now is a decision rather than a gap

**Change:** move async processing to a log (Kafka) or a managed queue (SQS).

#### The part that is not obvious

The usual framing is "BullMQ for small scale, Kafka for large scale." That is the
weak version. The real distinction is **shape, not size**:

> **BullMQ is a job queue. Kafka is a log.** All three current queues are
> single-producer, single-consumer *command* queues — "send this email", "process
> this payment", "resize this image". Each job has exactly one thing that should
> happen to it, and once it has happened the job is finished and can be forgotten.
> A log is for *events*, which many independent consumers read at their own
> positions and may re-read.

Nothing in Phases 1–4 wants a log. The day a second service needs to react to "a
post was created" — a notification service, an analytics pipeline, a moderation
queue — *that* is an event with multiple independent consumers, and the log shape
starts paying for itself. Reaching for Kafka today would buy replay and consumer
groups that nothing uses, at the cost of a cluster to operate.

**The honest durability gap**, which is a better reason than scale and worth saying
before an interviewer finds it: **Redis-backed BullMQ can lose enqueued jobs if
Redis loses data**, unless persistence (AOF, or RDB with an accepted window) is
configured and verified. That is a real operational requirement of the current
design, not a hypothetical — and "we chose BullMQ and configured AOF" is a
materially stronger answer than "we chose BullMQ because it is simpler."

**Trigger:** a second independent consumer of the same stream, a need to replay
after consumption, per-key ordering guarantees, or durability requirements beyond
what Redis persistence provides.

---

## The deliberate non-goals

Things a scaling roadmap is *expected* to contain, that I would actively decline
here. Each would be defensible at 100× the traffic; each is a liability now, because
it buys operational surface against no current bottleneck.

| Not doing | Why not |
| --- | --- |
| **Splitting the API into services per domain** | The API tier is stateless and scales horizontally already. A service split buys independent deploys at the cost of network calls, distributed failure modes and distributed transactions across a connection graph that is currently one `$or` query. The only split with a real argument is the WebSocket gateway (Item 11), and that argument is about *deploy semantics*, not about domains. |
| **Kubernetes** | The deployment need is "run N stateless API instances behind a load balancer, plus a worker" — which every managed platform does directly. k8s would add a control plane to operate for a topology that does not need orchestrating yet. |
| **A search engine (Elasticsearch/OpenSearch)** | There is no search feature. Adding the infrastructure before the feature is the purest form of this mistake. |
| **Multi-region active-active** | Requires an answer to write conflicts on the connection graph and the message log. Enormous complexity for a latency win that CloudFront (Item 7) delivers for the *actual* heavy payload — images. |
| **GraphQL** | The clients are one React app whose needs the REST routes already fit. Would add a resolver layer and an N+1 surface to the exact queries Phases 2–4 spent their effort making index-covered. |

The sentence this table exists to support: **choosing BullMQ over Kafka, one Mongo
replica set over a sharded cluster, and a monolith over services are all the same
decision made three times** — match the infrastructure to the load you have, and
know the specific signal that says it is time to change.

---

## Verification — what grounds each claim

No code shipped this phase, so there is nothing to verify by running. What makes the
roadmap falsifiable instead is that **every item traces back to an artifact already
in the repo** — a measured number, a verified failure, or a limitation found by
trying to violate it.

| Item | Grounded in |
| --- | --- |
| 1. `userAuth` per-request `findById` | [`auth.js:15`](../src/middlewares/auth.js:15); [`ISSUES.md`](../ISSUES.md) Scaling #4 (still open). Tier coupling: [`constants.js` `swipeLimits`](../src/utils/constants.js:14) |
| 2. Dead `{fromUserId, toUserId}` index | [`connectionRequest.js:129-136`](../src/models/connectionRequest.js:129) — "dead weight… wants its own verified change", written at the time |
| 3. Split thumbnail worker | [`workers/index.js:10-18`](../src/workers/index.js:10); [`thumbnailQueue.js:15-28`](../src/queues/thumbnailQueue.js:15) on the 4-thread libuv pool |
| 4. Observability | Every `.explain()` number in Phases 1–4 was produced by a hand-run script. The three silent-degradation designs: [`feedCache.js:82-99`](../src/utils/feedCache.js:82), [`post.js:55-69`](../src/models/post.js:55), [`socket.js`](../src/utils/socket.js) adapter fallback |
| 5. Read replicas | Read-your-own-writes paths are real and nameable: `POST /posts` → `GET /posts/feed`; `/profile/edit` → `/profile/view`. Staleness budget precedent: [`EXCLUSION_TTL_SECONDS`](../src/utils/feedCache.js:36) |
| 6. Profile cache | The cache-or-not rule is already written down: [`connectionGraph.js:85-87`](../src/utils/connectionGraph.js:85) |
| 7. CloudFront + OAC | [`postStorage.js:186-191`](../src/utils/postStorage.js:186) names it as the production answer; URL count from [`withViewUrls`](../src/routes/post.js:603) × [`DEFAULT_LIMIT = 10`](../src/routes/post.js:24); prefix layout from [`buildUploadKey`](../src/utils/postStorage.js:72) |
| 8. Presigned POST | Verified in Phase 4: 24.7 MB PUT under a 5 MB policy → `200`; claim-time refusal → `present (24733712 bytes)` → `ABSENT (404)`. [`ISSUES.md`](../ISSUES.md) Scaling #6 |
| 9. Orphan reaping | [`phase-4.md`](phase-4.md#orphaned-objects); race window bounded by [`UPLOAD_URL_TTL_SECONDS`](../src/utils/constants.js:47) |
| 10. Hybrid fan-out | The measured density table in [`post.js:120-152`](../src/models/post.js:120) — 36 vs 11, and 2,525 vs 11 |
| 11. Presence + gateway split | [`socket.js:110-156`](../src/utils/socket.js:110) — adapter in place, handshake auth shared with REST |
| 12. Archival | The blocking coupling is in code: [`computeExcludedIds`](../src/utils/feedCache.js:66) reads all statuses |
| 13. Sharding | Unique indexes that would be at risk: [`connectionRequest.js:82`](../src/models/connectionRequest.js:82) (canonical pair), [`post.js:48`](../src/models/post.js:48) (`imageKey`) |
| 14. Kafka/SQS | Three queues, all single-consumer command queues: [`emailQueue`](../src/queues/emailQueue.js), [`paymentQueue`](../src/queues/paymentQueue.js), [`thumbnailQueue`](../src/queues/thumbnailQueue.js) |

**The honest closing observation, and the reason Item 4 is Tier 1:** of the 14
triggers above, **almost none can currently be observed.** There is no query
profiler, no route latency histogram, no queue-depth metric and no cache hit-rate
metric. So the roadmap's own first item is the prerequisite for knowing when any of
the rest are due — which is a better note to end a scaling plan on than a list of
technologies.

---

## Files added / changed

| File | Change |
| --- | --- |
| `docs/phase-5.md` | **Added** — this document |
| `docs/phase-5-answers.md` | **Added** — spoken interview answers (Problem → Action → Outcome) |
| `ISSUES.md` | **Changed** — Scaling #4 annotated with its roadmap position; a pointer to this phase added to the footer |

No source files changed. That is the phase's defining property, not an omission.

---

## Anticipated interviewer follow-up questions

**"If you could only do one thing from this list, which?"**
Observability (Item 4), and I would argue it even though it ships no feature. Every
finding in Phases 1–4 came from reading code and running `.explain()` by hand.
That found two `COLLSCAN`s, but it only works when you already suspect something. And
three of my designs deliberately fail *open* or degrade *silently* — the feed cache
falls back to Mongo, a missing thumbnail still renders, the socket adapter keeps
delivering locally. Those are the right availability choices, and each converts an
outage into something nobody notices. Without instrumentation I have built a system
that hides its own failures.

**"Why is a `findById` ahead of sharding?"**
Frequency times cost of fixing. The `findById` runs on *every* authenticated
request, and the fix is a Redis cache-aside with two invalidation points —
days of work, fully reversible. Sharding is a near-one-way door that pays only
once a collection outgrows a replica set, which it has not. Doing them in the other
order means operating a sharded cluster to serve a query I could have cached.

**"Why not just put the user's data in the JWT and skip the lookup?"**
Because two things that lookup provides cannot live in a token. First, revocation —
tokens last 7 days, so a self-contained token means a banned or deleted account
keeps working for up to a week. Second, `isPremium` is an authorization input, not a
display field: the rate limiter reads the tier to choose a ceiling, and a user who
just paid for Silver expects 100 swipes now, not after their token rotates. A stale
tier claim is a billing complaint. So the read is load-bearing — the fix is to stop
it hitting Mongo, not to remove it.

**"You said caching the connection list would be a privacy bug, but you want to
cache the user record. Isn't that the same risk?"**
No, and the difference is what the staleness does. The connection list is a
*visibility* boundary — the posts feed uses it as access control, so a stale entry
shows a removed connection's posts, and nobody sees it happen. The tier flag is a
*capability* ceiling — stale for 60 seconds means someone gets 100 swipes instead of
20, which is bounded and self-correcting. The case that genuinely worries me is
banning or deletion, where a stale record means a banned account acts for up to a
minute. That is why invalidation is explicit on the writers rather than TTL-only,
and why a future delete-account path has to drop the key as part of the operation.

**"How would you pick the hybrid fan-out threshold?"**
I would not pick a number in advance — I would measure write amplification per post
by follower count and find the knee, then make it runtime config rather than a
constant, because the right value moves with the graph. The more important point is
that this app does not need it: the graph is *mutual connections*, not one-way
follows, so connection counts stay in the hundreds. Fan-out-on-read was right
because the merge's cost stays flat at 11 documents examined per page while the
`_id`-walk alternative grows to 2,525 in a sparse graph. The item only becomes due
if the product moves to asymmetric follows.

**"What would you shard on?"**
`Message` on hashed `chatId` — every read is already scoped by `chatId`, so that
makes history a single-shard query. `ConnectionRequest` is genuinely hard, and the
reason is a constraint most people miss: in a sharded collection a unique index is
only enforceable if the shard key is a prefix of it. My canonical-pair unique index
is what fixed the duplicate-request concurrency bug in Phase 2, so sharding on
hashed `fromUserId` would quietly reintroduce that bug — in the form that is
hardest to catch, since it never shows up in sequential testing. That pushes the key
toward the canonicalised pair itself, which then has a distribution wrinkle: ObjectIds
carry a timestamp prefix, so the low id skews toward early-registered accounts and a
ranged key risks hot-spotting. That is the item I would least want to answer from
first principles and most want to measure.

**"Why not Kafka?"**
Because all three of my queues are command queues — "send this email", "resize this
image" — with one consumer and nothing to replay. Kafka is a log, and a log pays off
when several independent consumers read the same stream at their own positions. The
day a notification service and an analytics pipeline both need to react to "post
created", that is an event and the shape changes. What I would fix *now* in the
current design is less glamorous: Redis-backed BullMQ can lose enqueued jobs if
Redis loses data, so persistence needs to be configured and actually verified.

**"Isn't a roadmap with no code just a wish list?"**
It would be if the items had no triggers and no grounding. Each one here names the
observable signal that makes it due, and traces to something already in the repo —
a measured `explain` number, a verified failure like the 24.7 MB upload that
returned 200 against a 5 MB policy, or a limitation documented at the time I hit
it. And the last thing it says is that most of those triggers are currently
unobservable, which is why instrumentation is first. A wish list does not usually
conclude that its author cannot yet tell which item is due.

**"What would you do differently if you started over?"**
Instrument first. I spent four phases building before/after evidence with a
hand-run script, and the evidence is good, but I was choosing *what* to investigate
by reading code — which is why both `COLLSCAN`s were found by inspection rather
than reported by the system. I would also have made the "seen profiles" set its own
durable state instead of deriving it from connection-request history. That
derivation was the simplest correct thing at the time, and it is now the reason I
cannot archive terminal request rows without changing product behaviour — a
one-line convenience that became an ordering constraint on a storage decision two
phases later.

---

## Next: after Phase 5

The roadmap above *is* the next-steps list, so the only thing left to decide is
execution order. If the project continues as code rather than as interview
preparation, the order is the tier order, with one addition: **Tier 0 first.** The
security debt in [`ISSUES.md`](../ISSUES.md) — the committed JWT secret above all —
outranks every performance item here, and the password-hash leak is specifically a
prerequisite for Item 1, since the auth middleware's fetch is what a user cache
would be caching.

Concretely, the first three code changes would be:

1. `select: false` on `password`, and a real `JWT_SECRET` (Tier 0).
2. Mongo slow-query profiling plus queue-depth and cache-hit metrics (Item 4) — so
   the rest of the list stops being guesswork.
3. The `user:{id}` cache-aside in `userAuth` (Item 1), with `/profile/view` as its
   second reader (Item 6).

Also still open from the plan's own structure: `dev` → `main` has been deliberately
deferred since Phase 0, so `main` still holds Phase 0 only. That merge is the user's
call, not a roadmap item.
