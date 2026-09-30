# Phase 2 — Membership-tier rate limiting + feed scaling

**Talking point:** "We moved the hottest write path (swipes) off Mongo and onto
an atomic Redis counter so free-tier abuse can't hammer our primary datastore,
and we swapped skip/limit pagination for cursor-based pagination so feed latency
doesn't degrade on deep pages. Along the way we found a check-then-act race in
the swipe endpoint that no amount of manual testing would have surfaced, and
fixed it by making the database the authority instead of application code."

Three changes, in the order they were made — and that order matters, because
each one makes the next one safe or cheap:

| # | Change | Why it had to come first |
|---|--------|--------------------------|
| 0 | Canonical-pair unique index (concurrency fix) | Makes duplicate swipes impossible at the DB level — which is what later lets the feed cache be eventually consistent without risking bad writes |
| 1 | Per-tier Redis rate limiter | Small, self-contained Redis use case; blocks abuse *before* it reaches Mongo |
| 2 | Cursor pagination + cached exclusion set | The feed read path, now that the write path is correct and bounded |

---

## Item 0 — The check-then-act race (Problem → Investigation → Options → Decision → Outcome)

### Problem

`POST /request/send/:status/:toUserId` decided whether a connection request
already existed, and then created one, as **two separate database operations**:

```js
const existingConnectionRequest = await ConnectionRequest.findOne({
  $or: [
    { fromUserId, toUserId },
    { fromUserId: toUserId, toUserId: fromUserId },
  ],
});
if (existingConnectionRequest) {
  return res.status(400).send({ message: "Connection Request Already Exists!!" });
}
// ... gap ...
const data = await connectionRequest.save();
```

Between the read and the write there is a window. Two requests that both enter
that window see "nothing exists" and both insert. The result is two
`ConnectionRequest` documents for one relationship — which then corrupts
everything downstream that assumes one: the connections list shows the person
twice, `/request/review` can accept one row while the other stays `interested`
forever, and the feed's exclusion logic double-counts.

**Why it was hard to notice** — this is the part that matters:

1. **It is invisible to sequential testing.** Click once, then click again: the
   pre-check works perfectly and returns the right error. Every manual test,
   every Postman run, every "I tried it and it's fine" passes. The bug only
   exists when two requests overlap *in time*, which a human clicking a button
   cannot reliably produce.
2. **It has two triggers, and the second is not a bug at all.** The obvious one
   is a double-click or a retried request. The other is completely ordinary user
   behaviour: two people swipe on each other at the same moment. That's not
   abuse or a client defect — it's the product working as intended, and it
   produces a corrupt row.
3. **It doesn't error.** Nothing throws. There's no 500, no log line, no alert.
   You find out weeks later from a user saying "why is this person in my
   connections twice?", by which point the bad rows are already in the data.
4. **Even the obvious fix misses half of it.** The instinct is a unique index on
   `{fromUserId, toUserId}`. That catches the double-click and completely misses
   the mutual swipe, because (A→B) and (B→A) are two different index keys. A
   fix that closes the case you thought of and leaves the case you didn't is
   worse than no fix, because now you believe you're covered.

### Investigation

Found by reading the code rather than from a metric — there is no signal to
find, which is the point. Then reproduced deliberately against a throwaway
collection with the old collection shape (only the `{fromUserId, toUserId}`
index the original code had), running the old handler's exact sequence:

```
Sequential (what manual testing does):
  1st: created
  2nd: rejected-by-precheck
  docs: 1 ← looks correct, bug invisible

Concurrent, same direction (double-click):
  results: [ 'created', 'rejected-by-precheck' ]
  docs: 1 (did not reproduce this run)

Concurrent, opposite directions (mutual swipe):
  results: [ 'created', 'created' ]
  docs: 2 ← DUPLICATE CREATED ❌

Burst of 10 concurrent:
  created: 8 | blocked by pre-check: 2
  docs: 8 ← 8 DUPLICATES for one pair ❌
```

Worth noting honestly: **the two-request case did not reproduce on that run.**
Whether the window is hit depends on scheduling, so a 2-way test is flaky — it
"passes" often enough to convince you nothing is wrong. The 10-way burst
reproduces every time and produced **8 duplicate rows for a single pair**. A bug
that fails to reproduce half the time is not a mild bug; it's a bug you will
close as "couldn't repro".

### Options considered

1. **A transaction (`findOne` + `save` in one `session`).** Correct, but it's a
   heavyweight tool for a two-document invariant, requires a replica set, adds
   latency to the hottest write path in the app, and still needs conflict
   handling on top. Reaching for a distributed transaction to enforce "this row
   is unique" is solving a constraint problem with a concurrency-control
   mechanism.
2. **A unique index on `{fromUserId, toUserId}`.** One line, no new fields —
   and **wrong**, for the reason above: it treats the two swipe directions as
   different rows, so it silently permits the mutual-swipe case. Rejected
   specifically because it *looks* sufficient.
3. **A Redis lock on the pair.** Works, but makes a correctness guarantee
   dependent on a cache being up, and introduces lock TTL/expiry questions. The
   uniqueness of a relationship is a property of the data; it belongs in the
   datastore that owns the data.
4. **A unique index on a canonicalised pair.** Store the two ids *sorted* into
   `userIdLow`/`userIdHigh` and uniquely index that. Both directions collapse to
   one identical key, so the database rejects the second write whichever way it
   points. Costs two derived fields.

### Decision — option 4

`src/models/connectionRequest.js` gains two derived fields and a unique partial
index; `src/routes/request.js` **deletes** the pre-check entirely and translates
the resulting duplicate-key error into `409 Conflict`.

```js
connectionRequestSchema.index(
  { userIdLow: 1, userIdHigh: 1 },
  { unique: true,
    partialFilterExpression: {
      userIdLow: { $exists: true }, userIdHigh: { $exists: true },
    } }
);
```

Three parts of that decision are deliberate:

**The pre-check is removed, not kept as a fast path.** Keeping it would only
*narrow* the window, never close it, while still costing a query on every
single swipe. Letting the write attempt be the check is both correct under
concurrency and one round trip cheaper. `fromUserId`/`toUserId` stay as they
are — they carry *who swiped on whom*, which is real information we still need;
the canonical pair is a separate, derived key for the constraint.

**`E11000` → 409, not 500.** This is what makes relying on the index safe rather
than merely correct. A duplicate-key error here is not a failure, it's the
expected answer to "does this already exist" — and the loser of a race gets
exactly the same clean response a sequential duplicate would. Without this
translation, fixing the data race would have traded a silent corruption for a
user-visible 500.

**The index is partial on `$exists`, which is a rollout decision, not a
performance one.** The collection already had rows written before these fields
existed. A plain unique index reads all of them as `(null, null)` — colliding
with each other — so the build fails outright and the constraint never takes
effect. Restricting it to documents that *have* the fields lets it build
instantly and start enforcing on every new write, while
`src/scripts/backfillRequestPairs.js` moves the legacy rows in behind it. That's
the difference between a fix you can deploy and a fix that fails on deploy.

### The backfill, and why it's a separate script

`src/scripts/backfillRequestPairs.js`, run with `node src/scripts/backfillRequestPairs.js`.
Cursor + batched `bulkWrite({ordered: false})`, idempotent, never loads the
collection into memory.

The reason it isn't a boot-time migration: **it can legitimately fail on some
rows, and a script must not decide what to do about that.** If the old race
already created duplicates, only the first row of a colliding pair can enter a
unique index. Those rows are *reported* for a human to resolve (keep the oldest?
keep the accepted one?) and never deleted:

```
Documents needing backfill: 6
Backfilled: 5

⚠️  1 document(s) could not be backfilled because another request already
occupies that pair in the unique index.
These are the duplicates the old check-then-act race created. Review and
resolve manually — this script will not delete data:

  _id: 6abcc3e81790fa0473fd3ded
```

It exits non-zero when there are conflicts, so it fails a deploy pipeline loudly
instead of quietly leaving rows outside the constraint.

### Outcome

Verified over real HTTP against the running app (see Verification below): 53
connection requests across 53 distinct pairs, **zero pairs with more than one
request**, including an 8-way simultaneous burst that produced exactly one `200`
and seven `409`s. The mutual-swipe case — the one a `{fromUserId, toUserId}`
index would have let through — returns one `200` and one `409`.

Cost: two `ObjectId` fields per document (24 bytes each) plus one index. In
exchange, the swipe path does **one** database round trip instead of two, so
the fix is net *faster* than the bug.

---

## Item 1 — Per-tier swipe rate limiting

`src/middlewares/rateLimiter.js`, `src/utils/constants.js`.

### Why Redis and not Mongo

A daily counter is close to the worst workload you can hand your primary
datastore: a read-modify-write on the same document, once per request, with
contention concentrated on exactly the heaviest users — and swipes are already
the hottest write path in the app. In Mongo that's a document per user per day
plus the write amplification of indexing it, on the same cluster serving the
feed. In Redis it's one atomic in-memory `INCR`, one round trip, and the key
deletes itself.

### Why a Lua script and not `INCR` + `EXPIRE`

This is the detail worth defending, because the naive version has a failure mode
that is *worse than no limiter*.

Two separate commands leave a window: if the process dies or the connection
drops after the `INCR` but before the `EXPIRE`, the key has **no TTL at all**.
The counter never resets, and that user is locked out of swiping permanently. A
limiter that fails into a ban is a worse bug than the abuse it was preventing.

`MULTI`/`EXEC` closes that window but **can't branch** — inside a transaction
you can't read the `INCR` result, so you'd have to `EXPIRE` unconditionally,
which pushes the reset forward on every request. Under continuous traffic the
window slides and never resets at all.

Lua is the smallest thing that is both atomic *and* able to branch on the
counter, so the TTL is set exactly once, by the request that created the key:

```lua
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {count, redis.call('TTL', KEYS[1])}
```

Returning the TTL alongside the count also means accurate `X-RateLimit-Reset`
and `Retry-After` headers without a second round trip. Registered via ioredis
`defineCommand`, so it ships as `EVALSHA` with automatic `NOSCRIPT` fallback —
the script body isn't re-sent on every request.

### Key shape and window

`swipe:{userId}:{YYYY-MM-DD}`, TTL to the end of the **UTC** day.

UTC rather than server-local is a multi-instance correctness decision: two API
instances in different timezones (or one instance whose `TZ` changes on a
redeploy) would otherwise disagree about which day it is and hand the same user
two separate buckets. TTL-to-midnight rather than a flat `86400` means the key
expires exactly when its name becomes unreachable, instead of lingering for a
day after it's useless.

It's a **fixed** window, not a sliding one — so in the worst case a user can
spend their limit at 23:59 and again at 00:01. For a daily engagement cap that's
fine; the limit exists to stop sustained free-tier abuse, not to smooth traffic.
A sliding window (sorted set of timestamps) would cost memory proportional to
the limit per user instead of a single integer, for a guarantee the product
doesn't need.

### Limits, and the `Infinity` detail

```js
const swipeLimits = { free: 20, silver: 100, gold: Infinity };
```

Kept beside the existing `membershipAmount` deliberately — price and limit are
two halves of one product decision and shouldn't be possible to change out of
step with each other.

`Infinity` isn't a sentinel the limiter has to decode. It reads it, sees no
finite ceiling, and **skips Redis entirely** — no counter, no key, no round trip.
Verified: a gold user doing 150 swipes creates zero Redis keys. "Unlimited"
costs nothing to enforce, and the highest-paying tier gets the fastest path.

### The asymmetric tier fallback

A premium user with an unrecognised `membershipType` is a data bug, and the two
ways to resolve it are not equally bad. Demoting a paying customer to free-tier
limits is user-visible harm and a support ticket; granting them the lowest
*paid* tier costs a handful of extra swipes. We take the cheap error, and log
loudly so the data bug is still visible.

### Fail-open, and why it's the opposite of Phase 1's call

If Redis is unreachable the limiter logs, sets `X-RateLimit-Bypass`, and calls
`next()`.

There are two ways to be wrong during a Redis outage: let some extra swipes
through, or take the core feature of the product offline for every user because
a cache is down. The first is a monetisation leak for the length of the outage.
The second is an outage. We pick the leak, and log it so it's alertable.

This is deliberately the **opposite** of the choice made in Phase 1 for the
payment webhook, which fails *closed* — there, a dropped enqueue means a payment
we took money for and never recorded. Same infrastructure, opposite default,
decided by what each path actually protects. Being able to state that difference
is the point.

### Middleware ordering

`userAuth` → `swipeRateLimiter` → handler. After auth because the key needs
`req.user`; before the handler so a rate-limited request costs one Redis `INCR`
and **never reaches Mongo at all**. Mounting it any later would mean the abuse
we're blocking still gets to do its database reads first.

One consequence worth stating: the limiter counts **attempts, not successes**.
A swipe that 404s or 409s still consumes quota. That's correct for abuse
prevention — otherwise an attacker gets unlimited free attempts by aiming at
invalid targets — and it also means the counter keeps climbing past the limit,
which is free visibility into how hard someone is hammering.

---

## Item 2 — Feed scaling: cursor pagination + cached exclusion set

`src/routes/user.js`, `src/utils/feedCache.js`.

### 2a. skip/limit → cursor

`.skip(n)` does not jump to the nth document. MongoDB positions at the start of
the index and **walks and discards n entries**, every time. The cost of a page
grows linearly with how deep into the feed you are, so latency degrades
precisely for the most engaged users — the ones who scroll furthest.

Measured with `.explain("executionStats")` over 20,000 seeded users, 10 per
page. The metric that moves is **`totalKeysExamined`**, not `totalDocsExamined`
— and that distinction is itself the interesting finding. The plan is
`LIMIT ← PROJECTION ← FETCH ← SKIP ← IXSCAN`: `SKIP` sits *above* `IXSCAN` but
*below* `FETCH`, so Mongo walks index keys it then throws away without ever
fetching their documents. Looking only at `totalDocsExamined` (a flat 10) would
have told you there was no problem at all.

| Page | skip | BEFORE keysExamined | AFTER keysExamined | Ratio | BEFORE ms | AFTER ms |
|------|------|--------------------:|-------------------:|------:|----------:|---------:|
| 1    | 0     | 31     | 32 | 1x     | 0  | 0 |
| 10   | 90    | 121    | 11 | 11x    | 0  | 0 |
| 100  | 990   | 1,021  | 11 | 93x    | 1  | 1 |
| 500  | 4,990 | 5,021  | 11 | 456x   | 3  | 0 |
| 1000 | 9,990 | 10,021 | 11 | 911x   | 6  | 0 |
| 2000 | 19,990| 20,000 | 9  | 2,222x | 12 | 0 |

The shape is the whole story: **BEFORE grows linearly with page depth; AFTER is
flat at ~`limit`+1 regardless of depth.** Page 1 is a wash (a cursor helps
nothing on the first page) — the win is entirely in not degrading.

The cursor is `_id`, with `sort({_id: 1})` and `_id > lastSeenId`. `_id` is the
natural choice because it's unique — no ties to break, so no page can silently
drop or repeat a row — and monotonic enough to sort by without a second tiebreak
field.

`limit + 1`: fetching one extra row is how we learn whether another page exists
without a second `count` query. `nextCursor` is `null` at the end, so the
client's stop condition is "the server said there's nothing after this" rather
than "I got fewer rows than I asked for" — which becomes an unreliable signal
the moment any post-query filtering is added.

**A correctness win that came along for free.** skip/limit wasn't just slow, it
was *wrong* under concurrent writes: a user inserted mid-scroll shifts every
subsequent offset, so a profile appears on two pages or on none. A cursor is
anchored to a value rather than a position, so inserts before your cursor can't
disturb you. Verified end-to-end: paging through the whole feed returned 62 rows
across 8 pages, 62 distinct — no duplicates, no gaps.

**What we gave up, honestly:** no random access to "page 37" and no total count.
For an infinite-scroll feed, no client asks for either. `page` is gone from the
API; the Postman collection is updated.

### 2b. The cached exclusion set (the stretch item)

The feed also re-read **every connection request the user had ever been part
of**, on every single feed call, purely to build a list of ids to exclude. That
read grows without bound for the life of the account: a user with 5,000 swipes
pays a 5,000-document read to render 10 profiles, and it gets worse every time
they swipe. The exclusion set is also identical on every page of the same scroll
session, so we were recomputing an unchanged answer once per page.

This is the **fan-out-on-read vs fan-out-on-write** trade-off:

- *Fan-out-on-read* (the old code): recompute from source on every read. Always
  fresh; cost scales with history, forever.
- *Fan-out-on-write* (now): maintain the answer incrementally as swipes happen.
  Reads are `SMEMBERS` from memory; the cost is keeping a derived copy correct.

We took the second, with Mongo still the source of truth so a wrong cache is
always recoverable by dropping the key.

**Staleness is safe here by construction, and that's the part worth noticing.**
The worst a stale set can do is let an already-swiped profile reappear in the
feed. If the user swipes it again, **item 0's unique index rejects the write and
the route returns a clean 409.** The concurrency fix is what makes this cache
affordable to be eventually consistent — the two changes in this phase are
load-bearing for each other. That's not a happy accident; it's why item 0 was
sequenced first.

**Three design details that each fix a specific trap:**

1. **The set always contains the requester's own id.** Not a detail — it's what
   makes a populated set never empty, which is the only way to distinguish
   "cache populated, this user has no interactions yet" from "cache missing"
   (`SMEMBERS` returns `[]` for both). Without it, every brand-new user misses
   the cache on every feed call forever. It also folds the old separate
   `{_id: {$ne: loggedInUser._id}}` clause into the same `$nin`, so the query
   has one exclusion mechanism instead of two.

2. **`SADD` is guarded on `EXISTS`, via Lua.** This is the one genuinely
   dangerous edge in the whole cache. A plain `SADD` on a missing key *creates*
   it — with exactly one member. That one-member set is **indistinguishable from
   a fully-populated cache**, so every later feed call would trust it and show
   the user profiles they'd already swiped on, until the TTL expired. Guarding on
   `EXISTS` means a cold cache stays cold and gets built properly from Mongo on
   the next read. Verified explicitly.

3. **`addInteraction` never throws.** It runs *after* the connection request is
   durably in Mongo. The write has succeeded; failing to update a derived cache
   must not turn a successful swipe into an error response.

**What the 10-minute TTL is actually for.** Not freshness —
`addInteraction` updates *both* sides of the pair, so the set stays current as
swipes happen in either direction. The TTL buys two other things: **memory
reclamation** (without it, every user who ever loaded a feed keeps a set in
Redis forever, including accounts that never come back) and a **backstop** for
changes the app never saw — the backfill script, a manual DB fix, or an
incremental `SADD` dropped during a transient Redis error, which are swallowed
by design.

**Fails open to Mongo.** If Redis is unreachable the feed is still correct, just
as expensive as it was before this phase. A cache outage must not become a
feature outage. `feedCache.invalidate(userId)` is the operator escape hatch.

---

## Verification

All verified **live** against the running Redis + Mongo. Every database test ran
against a throwaway `devTinder_phase2_verify` database, dropped afterwards; the
real local DB was untouched (confirmed before and after).

### Item 0 — concurrency

- ✅ **Canonicalisation** — A→B and B→A produce identical `(userIdLow, userIdHigh)`.
- ✅ **"Before" evidence reproduced** — old handler shape, no unique index: the
  mutual-swipe case created 2 rows, a 10-way burst created **8 rows for one
  pair**. Sequential testing showed 1 row and looked correct.
- ✅ **Concurrent identical swipes** (model level) — 1 doc created.
- ✅ **Concurrent mutual swipes, opposite directions** — 1 doc created (the case a
  `{fromUserId, toUserId}` index misses).
- ✅ **10-way burst** — 1 `ok`, 9 `E11000`, 1 document.
- ✅ **Controls** — distinct pairs still insert freely; self-request still rejected.
- ✅ **Safe rollout** — legacy rows with no pair fields are accepted by the
  partial index; the build isn't blocked.
- ✅ **Backfill script** — 6 legacy rows incl. one duplicated pair → 5 backfilled,
  1 conflict *reported and not deleted*, exit code 1. Re-run: 0 to do
  (idempotent).
- ✅ **Backfill on the real local dev DB** — 7/7 rows backfilled, 0 conflicts;
  re-run is a no-op.
- ✅ **End-to-end over HTTP** (real Express stack, real auth cookies):
  - two simultaneous identical swipes → `200` + `409`
  - simultaneous **mutual** swipe → `200` + `409`
  - 8 simultaneous swipes on one pair → **one `200`, seven `409`**
  - final state: 53 requests / 53 distinct pairs / **0 pairs with >1 request**

### Item 1 — rate limiter

- ✅ **Free-tier boundary** — 20 allowed, first `429` on request **#21**, correct
  body and `Retry-After`.
- ✅ **Headers** — `X-RateLimit-Limit/Remaining/Reset` count down correctly.
- ✅ **TTL set once, never extended** — TTL > 0 immediately after the first
  `INCR` (no lost-expire window), and *decreasing* on later requests, confirming
  a fixed rather than sliding window. TTL matches seconds-to-UTC-midnight.
- ✅ **Atomicity under concurrency** — 40 *simultaneous* requests on a free
  account: **exactly 20 allowed**, 20 blocked. No over-admission.
- ✅ **Silver tier** — exactly 100 allowed.
- ✅ **Gold tier** — 150/150 allowed, `X-RateLimit-Limit: unlimited`, and
  **zero Redis keys created**.
- ✅ **Unrecognised `membershipType` on a premium user** — resolves to silver
  (100), not free; warning logged.
- ✅ **Fail-open** — with `incrWithTtl` fault-injected to reject, 30/30 requests
  allowed, `X-RateLimit-Bypass: redis-unavailable`, each failure logged.
- ✅ **End-to-end over HTTP** — free account: 30 swipes → 20×`200`, 10×`429`,
  first `429` on #21. Gold account: 30 swipes → 30×`200`.

### Item 2 — feed

- ✅ **`.explain("executionStats")` before/after** over 20,000 users — the table
  above. `keysExamined` 10,021 → 11 at page 1000; AFTER is flat with depth.
- ✅ **Cursor paging end-to-end** — full feed in 8 pages, 62 rows, **62 distinct**
  (no duplicates, no gaps across boundaries), `hasMore`/`nextCursor` terminate
  correctly.
- ✅ **Malformed cursor** → 400, not a 500 from a cast error.
- ✅ **Cache cold read** — 1 Mongo read, correct ids, includes self, key created
  with a 600s TTL.
- ✅ **Cache warm read** — 10 feed calls → **0 Mongo reads**.
- ✅ **Fan-out-on-write** — `addInteraction` updates *both* users' sets.
- ✅ **The partial-cache trap** — `addInteraction` on a cold key does **not**
  create it; the next read rebuilds the full set from Mongo.
- ✅ **Zero-interaction user** — populated set is non-empty (self), so the second
  call hits the cache instead of missing forever.
- ✅ **Fail-open** — with `smembers` fault-injected, the feed is still correct via
  the Mongo fallback.
- ✅ **`invalidate`** — key removed.
- ✅ **End-to-end** — a gold user who swiped 30 profiles sees **0** of them in a
  subsequent feed call.

### Error handling

- ✅ malformed target id → `400 Invalid user id`
- ✅ valid-but-absent user → `404 User not found!`
- ✅ invalid status → `400 Invalid status type`
- ✅ duplicate swipe → `409`, never `500`

---

## Files added / changed

| File | Change |
|------|--------|
| `src/models/connectionRequest.js` | **+** `userIdLow`/`userIdHigh` derived fields, `pre("validate")` hook, unique partial index on the canonical pair |
| `src/routes/request.js` | **removed** the check-then-act `findOne`; `E11000` → `409`; `+` rate limiter; `+` ObjectId validation; projected `User.findById`; `+` feed-cache fan-out |
| `src/middlewares/rateLimiter.js` | **new** — per-tier daily limiter, Lua `INCR`+conditional `EXPIRE`, UTC window, fail-open, rate-limit headers |
| `src/utils/constants.js` | **+** `swipeLimits` |
| `src/utils/feedCache.js` | **new** — cache-aside exclusion set, `EXISTS`-guarded `SADD`, fan-out-on-write, fail-open, `invalidate` |
| `src/routes/user.js` | `/feed`: cursor pagination replacing skip/limit, cached exclusion set, `hasMore`/`nextCursor`; fixed `req.statusCode` → `res.status`; removed a debug `console.log` |
| `src/scripts/backfillRequestPairs.js` | **new** — idempotent batched backfill; reports pair conflicts without deleting data; non-zero exit on conflict |
| `src/config/database.js` | stopped logging the connection string (carries credentials outside local dev) |
| `src/app.js` | boot log now reports the actual port instead of a hardcoded `7777` |
| `postman/devTinder.postman_collection.json` | `/feed` updated: `page` → `cursor` |
| `docs/phase-2.md` | **new** — this write-up |

## Bugs found and fixed along the way

- **`src/routes/user.js`** — the error handler in `/user/requests/received`
  called `req.statusCode(400)` instead of `res.status(400)`. `req.statusCode`
  isn't a function, so *any* error in that route threw a second
  `TypeError` inside the catch block, escaping as an unhandled rejection rather
  than a response. The route could hang instead of returning an error.
- **`src/config/database.js`** — logged the full Mongo connection string on every
  boot, credentials included. Harmless against local Mongo, a credential leak
  into log aggregation anywhere else.
- **`src/app.js`** — boot log hardcoded "port 7777" regardless of `process.env.PORT`.
- A stray `console.log(connectionRequests)` in `/user/connections` printing every
  connection on every request.

## Anticipated interviewer follow-up questions

**Q: Why not just use a transaction?**
The invariant is "this row is unique", which is a *constraint*, not a
concurrency-control problem. A unique index enforces it at the storage layer for
the cost of one index, with no session, no replica-set requirement and no added
latency on the hottest write path. Transactions are for multi-document atomicity
— this isn't that.

**Q: Why a canonicalised pair instead of a unique index on `{fromUserId, toUserId}`?**
Because that index treats (A→B) and (B→A) as different keys, so it catches the
double-click and silently permits the mutual swipe — two users swiping on each
other at the same instant, which is ordinary product behaviour, not abuse. A fix
that covers the case you thought of and misses the one you didn't is dangerous,
because you stop looking.

**Q: How do you add a unique index to a collection that already has data?**
Make it partial on `$exists` for the new fields. It builds instantly and starts
enforcing on all new writes, while a separate idempotent backfill script moves
the legacy rows in behind it. A plain unique index would read every legacy row as
`(null, null)`, collide, and fail the build — so the constraint would never take
effect at all.

**Q: What if the backfill finds duplicates that already exist?**
It reports them with their `_id`s and exits non-zero; it never deletes data.
Which of two duplicate requests to keep is a product decision (the oldest? the
accepted one?), not something a migration script should decide silently.

**Q: Why Lua instead of `INCR` then `EXPIRE`?**
Two commands leave a window where the process can die between them, leaving the
key with no TTL — so the counter never resets and the user is banned forever. A
limiter that fails into a permanent ban is worse than the abuse it prevents.
`MULTI` closes the window but can't branch on the `INCR` result, so you'd have to
`EXPIRE` unconditionally and the window would slide and never reset. Lua is the
smallest thing that's atomic *and* can branch.

**Q: Fixed or sliding window, and why?**
Fixed. A user can therefore spend their limit at 23:59 and again at 00:01. That's
acceptable for a daily engagement cap — the goal is stopping sustained abuse, not
smoothing traffic — and a sliding window costs memory proportional to the limit
per user (a sorted set of timestamps) instead of one integer.

**Q: Fail-open or fail-closed if Redis is down?**
Fail-open here: a swipe limit is not payment-critical, so the choice is between
a monetisation leak for the length of the outage and a full feature outage. We
log and alert on the leak. Note this is the *opposite* of the Phase 1 payment
webhook, which fails closed — there a lost enqueue means a payment we charged
for and never recorded. Same infrastructure, opposite default, driven by what
each path protects.

**Q: Why does `totalDocsExamined` stay flat while skip gets slower?**
Because `SKIP` sits above `IXSCAN` and below `FETCH` in the plan — Mongo walks
index *keys* and discards them before ever fetching documents. `keysExamined`
goes 31 → 10,021 from page 1 to page 1000 while `docsExamined` stays at 10.
Watching only `docsExamined` would tell you there's no problem.

**Q: What does cursor pagination give up?**
Random access to an arbitrary page, and a total count. Neither matters for
infinite scroll. In exchange you also get *correctness*: skip/limit shifts every
offset when a row is inserted mid-scroll, so profiles get shown twice or skipped.
A cursor is anchored to a value, not a position.

**Q: Isn't the cached exclusion set a correctness risk?**
The worst case is an already-swiped profile reappearing in the feed, and if the
user swipes it again the canonical-pair unique index rejects the write and
returns a 409. So the failure mode is a cosmetic repeat, not bad data — which is
exactly why the concurrency fix was sequenced before the cache.

**Q: What's the trap with caching a set in Redis?**
`SADD` on a missing key creates it with one member, and a one-member set looks
identical to a fully-populated one — so the cache would confidently hide only the
most recent swipe and show everything else the user had already seen. The `SADD`
is guarded on `EXISTS` so a cold cache stays cold and rebuilds from source.
Relatedly, the set always includes the user's own id, so a populated set is never
empty and "no interactions yet" is distinguishable from "cache missing".

**Q: What's the TTL for, if writes keep the set current?**
Memory reclamation, mainly — otherwise every user who ever loaded a feed keeps a
set in Redis forever. Secondarily it's a backstop for writes the app never saw:
the backfill script, a manual DB fix, or an incremental `SADD` we dropped during
a transient Redis error.

---

## Next: Phase 3
Chat at scale: split messages out of the embedded `Chat` array into their own
collection (the 16MB document cap + whole-array rewrite on every message),
cursor-paginate history, add the Socket.io Redis adapter for multi-instance
delivery, and close the authorization `TODO` in `src/utils/socket.js`.
