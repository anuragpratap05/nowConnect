# Phase 2 — Spoken interview answers

> The *say-out-loud* versions, in Problem → Action → Outcome shape so they stay
> recallable under pressure. Say them in your own words — don't recite.
>
> **These are deliberately light on numbers.** Interviewers at this level are
> checking whether you can name the pattern, say why you chose it, and say what
> value it added — not whether you memorised a benchmark. So the shape of the
> answer is always: *here's the pattern, here's the alternative I rejected,
> here's what it bought us.* Talk in **directions and shapes** ("the cost used to
> grow with history, now it's flat") rather than figures. The measured numbers
> and query plans are in [phase-2.md](phase-2.md) if someone asks to see them —
> and if they do, "I can show you the `.explain` output" is a stronger answer
> than a recalled statistic.

**The patterns this phase gives you, by name** — these are the words to actually
say out loud, because they're what's being tested:

| Pattern | Where |
|---|---|
| Check-then-act race / make the datastore the authority | Item 0 |
| Canonicalisation (normalise the key so the constraint becomes expressible) | Item 0 |
| Optimistic write + handle-the-conflict, vs pessimistic locking | Item 0 |
| Idempotency | Item 0 |
| Expand-and-contract migration (partial index + backfill) | Item 0 |
| Fixed-window counter; atomicity via a server-side script | Item 1 |
| Fail-open vs fail-closed (graceful degradation) | Item 1 |
| Reject at the edge / fail fast before the expensive layer | Item 1 |
| Cache-aside | Item 2 |
| Fan-out-on-write vs fan-out-on-read | Item 2 |
| Keyset (cursor) pagination vs offset pagination | Item 2 |

---

## Q1 (primary) — "What's a challenge you faced and why was it hard?"

This is the strongest answer this phase gives you. Lead with **why it was
invisible**, not with the fix.

**Problem.** "Our swipe endpoint had a check-then-act race. It did a `findOne` to
see whether a connection request already existed between two users, and then a
separate `save()` to create one. Those are two operations with a gap between
them — so two requests that overlap in that gap both see 'nothing exists' and
both insert. You end up with two rows representing one relationship, which then
corrupts everything downstream that assumes there's one: the connections list
shows someone twice, and accepting one row leaves the other stuck pending
forever.

The reason it was genuinely hard isn't the concurrency — it's that **nothing
tells you it's there.**

First, it's invisible to the way you naturally test. Click once, click again:
the pre-check works perfectly and returns exactly the right error. Every manual
test passes. Every Postman run passes. The bug only exists when two requests
overlap *in time*, and a human clicking a button can't reliably produce that.

Second — and this is the part I'd emphasise — **it has two triggers, and the
second one isn't a bug at all.** The obvious trigger is a double-click or a
retried request. The other is completely ordinary user behaviour: two people
swipe on each other at the same moment. That's not abuse and it's not a client
defect, it's the product working as intended, and it produces a corrupt row.

Third, it doesn't throw. No 500, no log line, no alert. You find out weeks later
from a user asking why someone appears twice in their connections — and by then
the bad rows are already in your data.

And fourth, the obvious fix only covers half of it. The instinct is a unique
index on `{fromUserId, toUserId}`. That catches the double-click and completely
misses the mutual swipe, because A→B and B→A are two different index keys to the
database even though they're the same relationship to the product. **A fix that
closes the case you thought of and leaves the case you didn't is worse than no
fix, because now you believe you're covered and you stop looking.**"

**Action.** "I found it by reading the code, not from a metric — there is no
metric, that's the point. Then I reproduced it deliberately: I stood up the old
collection shape in a throwaway database and fired concurrent requests at it.
Worth saying out loud: the two-request version *didn't reproduce reliably* —
whether you hit the window depends on scheduling. A bigger concurrent burst
reproduced it every time and produced multiple duplicate rows for a single pair.
That flakiness is itself the lesson: a bug that only reproduces half the time is
the kind you close as 'couldn't repro'.

The fix was to stop having application code be the authority and let the
**database** enforce it. But to do that I had to make the constraint
*expressible* first — that's the interesting bit. You can't uniquely index
`fromUserId`/`toUserId` directly, because those carry *who swiped on whom*, which
is real information I still need. So I added two derived fields holding the same
two ids **sorted** — a canonical, direction-independent pair — and put the unique
index on that. Both swipe directions now collapse to one identical key, so the
database rejects the second write whichever way it points.

Two other deliberate calls. I **removed** the pre-check rather than keeping it
as a fast path, because keeping it only *narrows* the window and never closes it,
while still costing a query on every swipe. And I translated the duplicate-key
error into a `409 Conflict` instead of letting it become a 500 — a duplicate key
here isn't a failure, it's the expected answer to 'does this already exist', and
the loser of a race gets exactly the same clean response a sequential duplicate
would."

**Outcome.** "The invariant is now enforced where the data lives, so it holds no
matter how many app instances are running or how requests interleave — which a
pre-check could never give me. The value beyond correctness: the swipe path does
**one** database round trip instead of two, so the fix is actually *faster* than
the bug. That's the version of this I like — the correct design was also the
cheaper one."

---

## Q3 — "Walk me through a design decision you made."

Two good options. Pick based on what the interviewer seems to care about.

### Option A — enforcing an invariant (pairs well with Q1)

"The decision was **where to enforce uniqueness**, and I had four real choices.

A **transaction** around the read and the write. Correct, but it's a heavyweight
tool for a two-document invariant — needs a replica set, adds latency to my
hottest write path, and still needs conflict handling on top. And conceptually
it's the wrong tool: 'this row is unique' is a *constraint*, not a
concurrency-control problem. Transactions are for multi-document atomicity; this
isn't that.

A **unique index on `{fromUserId, toUserId}`**. One line, no new fields — and
wrong, because it treats the two swipe directions as different rows.

A **Redis lock on the pair**. Works, but it makes a correctness guarantee depend
on a cache being up, and adds lock-TTL and expiry questions. The uniqueness of a
relationship is a property of the data, so it belongs in the datastore that owns
the data — not in a cache that's allowed to be down.

What I picked: a **unique index on a canonicalised pair**. It costs two derived
fields, and in exchange the guarantee lives at the storage layer where it can't
be bypassed, with no session, no replica-set requirement, and no added latency."

**If they ask the follow-up that separates seniors from mids — "how do you add a
unique index to a collection that already has data?"** This is worth
volunteering even if they don't ask:

"Carefully, because the naive version fails on deploy. My new fields didn't exist
on existing rows, and a plain unique index reads all of those as `(null, null)` —
which all collide with each other, so **the index build fails outright and the
constraint never takes effect at all.** So I made the index *partial*: it only
covers documents that actually have the fields. That builds instantly and starts
enforcing on every new write, and then a separate backfill script moves the
legacy rows in behind it. It's the expand-and-contract idea — add the new thing
alongside, migrate, then rely on it. The difference between a fix you can deploy
and a fix that fails on deploy.

One detail I'd point at in the backfill: it can *legitimately* fail on some rows,
because if the old race already created duplicates, only one row of a colliding
pair can enter a unique index. So the script **reports** those rows and exits
non-zero rather than deleting anything. Which of two duplicate requests to keep
is a product decision — keep the oldest? keep the accepted one? — and a migration
script has no business deciding that silently."

### Option B — the atomic counter (pairs well with Q6)

"We needed per-tier daily swipe limits. The first decision was **where the
counter lives**. A daily counter is close to the worst workload you can hand your
primary database: a read-modify-write on the same document, once per request,
with contention concentrated on exactly your heaviest users — and swipes were
already the hottest write path. So it went to Redis: one atomic in-memory
increment, one round trip, and the key deletes itself on expiry. The value is
that abuse of a free-tier feature now costs us a cache operation instead of load
on the datastore that's also serving the feed.

The second decision is the one I'd actually want to be asked about, because the
naive version has a failure mode **worse than having no limiter at all.**

The obvious implementation is increment, then set an expiry — two commands. But
that leaves a window: if the process dies or the connection drops between them,
the key has **no expiry at all**. The counter never resets, and that user is
locked out of swiping *permanently*. A rate limiter that fails into a permanent
ban is a far worse bug than the abuse it was preventing.

The usual answer is a transaction — but a Redis transaction **can't branch**.
You can't read the increment's result inside it, so you'd have to set the expiry
unconditionally on every request, which pushes the reset forward each time. Under
continuous traffic the window slides and never resets.

So I used a small server-side Lua script. It's the smallest thing that's both
atomic *and* able to branch on the counter, so the expiry gets set exactly once —
by the request that created the key. Value: the limit is correct under
concurrency, there's no window where it can fail into a ban, and it's still a
single round trip."

**If they ask "fixed or sliding window?"** — "Fixed, and I know the consequence:
someone can spend their limit just before midnight and again just after. That's
acceptable for a daily engagement cap — the goal is stopping *sustained* abuse,
not smoothing traffic — and a sliding window costs memory proportional to the
limit per user, a sorted set of timestamps, instead of a single integer. If the
goal were protecting a fragile downstream I'd want the sliding window or a token
bucket; for a product quota, it isn't worth it."

**Small detail worth dropping if it fits** — "the unlimited tier skips Redis
entirely. There's no counter, no key, no round trip. So the highest-paying tier
also gets the fastest path, and 'unlimited' costs nothing to enforce."

---

## Q4 (primary) — "A trade-off between two options, and how it played out."

The best one here is **fan-out-on-write vs fan-out-on-read** on the feed,
because it's a genuine trade-off where I took the riskier-sounding option and
can explain exactly what made it safe.

**Problem.** "Our feed needed to exclude everyone you'd already interacted with.
The original code rebuilt that exclusion list from scratch on every single feed
call — it read *every* connection request you'd ever been part of, just to
produce a list of ids to filter out. That read grows without bound for the life
of the account: a heavy user pays a read proportional to their entire swipe
history to render ten profiles, and it gets worse every time they swipe. And
because the exclusion set is identical on every page of the same scroll session,
we were recomputing an unchanged answer once per page."

**Options.** "That's the classic fan-out trade-off.

**Fan-out-on-read** — what we had. Recompute from the source of truth on every
read. Always fresh, dead simple, no invalidation to get wrong. But the cost
scales with history, forever.

**Fan-out-on-write** — maintain the answer incrementally as swipes happen, and
read it from memory. Reads become cheap and, more importantly, **flat** — but now
you own a derived copy, and derived copies can be wrong."

**Decision.** "I took fan-out-on-write — cache-aside, with Mongo still the
source of truth so a bad cache is always recoverable by just dropping the key.

But the reason I was comfortable with it is the part I'd actually want credit
for: **staleness is safe here by construction.** The worst thing a stale
exclusion set can do is let an already-swiped profile reappear in your feed. And
if you swipe on it again, the canonical-pair unique index from the other half of
this phase rejects the write and returns a clean 409. So the failure mode of the
cache is a *cosmetic repeat*, not bad data.

That's not luck. It's why I sequenced the concurrency fix **first**. The
constraint is what makes the cache affordable to be eventually consistent. If I'd
built the cache without it, a stale set could have produced duplicate rows —
the same corruption I'd just spent the earlier work eliminating."

**How it played out / what I'd warn someone about.** "Two traps, and I'd
volunteer both because they're the ones you only find by building it.

The first: adding a member to a Redis set **creates the key if it's missing** —
with exactly one member. And a one-member set is **indistinguishable from a
fully-populated one**. So a cold cache getting a single incremental write would
look complete, and the feed would confidently hide only your most recent swipe
and show you everything else you'd already seen. I guard the write on 'does this
key already exist', so a cold cache stays cold and gets built properly from the
database on the next read.

The second, related one: the set always contains **your own id**. That sounds
like a detail but it's load-bearing — reading an empty set and reading a missing
key look the same, so without a guaranteed member you can't tell 'cached, and
this user has no interactions yet' from 'not cached'. A brand-new user would miss
the cache on every call forever. It also folded the old separate 'exclude
myself' clause into the same filter, so the query has one exclusion mechanism
instead of two."

**If they ask about the TTL** — worth getting right, because the obvious answer
is wrong: "The TTL isn't really about freshness — the incremental writes handle
that, on both sides of the pair. It's there for **memory reclamation**: without
it, every user who ever loaded a feed keeps a set in Redis forever, including
accounts that never come back. And secondarily it's a backstop for writes the
application never saw — a migration script, a manual database fix, or an
incremental update I dropped during a transient Redis error, which I swallow on
purpose because the swipe has already succeeded and a derived cache failing must
not turn a successful write into an error response."

---

## Q2 (secondary) — "Tell me about a performance problem you found and fixed."

Phase 1's collection scan is the stronger answer for this one. Use the feed
pagination fix as a **second, different-flavoured** example — and the interesting
part here is genuinely about *which metric you look at*.

**Problem.** "Our feed used offset pagination — page number, skip, limit. The
thing people miss about `skip` is that it doesn't *jump* to the nth document. The
database positions at the start of the index and **walks and discards** n entries,
every single time. So the cost of a page grows linearly with how deep into the
feed you are. Which means latency degrades **precisely for your most engaged
users** — the ones who scroll furthest. That's the worst possible distribution
for that cost to have."

**Action.** "I replaced it with keyset — cursor — pagination: sort by `_id`, and
ask for `_id` greater than the last one you saw. That turns the walk-and-discard
into an index seek, so every page costs about the same as the first regardless of
depth.

`_id` is the natural cursor because it's unique, so there are no ties to break —
which matters, because ties are how rows silently get dropped or repeated at page
boundaries.

And a detail I'd mention: I fetch one row more than the page size. That's how you
know whether another page exists without running a second count query. Then the
response returns an explicit 'next cursor', null at the end — so the client's
stop condition is 'the server said there's nothing after this' rather than 'I got
fewer rows than I asked for', which becomes an unreliable signal the moment you
add any post-query filtering."

**Outcome + the actual insight.** "The shape is the whole story: the old cost
grew linearly with page depth; the new one is flat. Page one is a wash — a cursor
buys you nothing on the first page — the entire win is in **not degrading**.

But the thing I actually learned, and the bit I'd lead with if they seem
technical: **I was nearly looking at the wrong metric.** In the query plan, the
skip stage sits *above* the index scan but *below* the document fetch. So the
database walks index **keys** and throws them away before ever fetching their
documents. That means 'documents examined' stays completely flat as you page
deeper — it looks like there's no problem at all — while 'keys examined' climbs
linearly. If I'd only checked documents examined, I'd have concluded the query
was fine.

And one thing that came along for free: offset pagination wasn't just slow, it
was **incorrect** under concurrent writes. A new row inserted while you're
scrolling shifts every subsequent offset, so a profile shows up on two pages or
on none. A cursor is anchored to a *value* rather than a *position*, so inserts
before your cursor can't disturb you. I went in for the latency and got a
correctness fix as well."

**If they ask what you gave up** — "Random access to an arbitrary page, and a
total count. Neither matters for infinite scroll. It is a breaking API change
though — the page parameter is gone, so any client calling it has to move to
cursors. That's a real cost and worth being upfront about; I'd never quietly
change a pagination contract."

---

## Q5 — "Have you dealt with load concentrated at a particular time?"

Phase 1 has the stronger version of this (the scheduled cron spike, and bursty
payment webhooks). Phase 2 adds the **organic** flavour:

"The other kind is organic rather than scheduled — a social feed has a daily peak
when people are actually on their phones, evenings for us. What matters there
isn't that the peak exists, it's that **nothing in the hot path should have a
cost that grows with how much data you already have**, because the peak and the
growth compound. Both of this phase's feed changes were about exactly that: the
exclusion set was proportional to a user's entire swipe history, and offset
pagination was proportional to scroll depth — and deep scrolling is *what people
do at peak*. Now both are flat. Peak traffic still costs more in aggregate,
obviously, but the per-request cost stopped climbing month over month, which is
the part that actually turns a peak into an incident.

The rate limiter also helps here, and it's partly *why* I put it before the
handler in the middleware chain rather than inside it. A rate-limited request
costs one Redis increment and **never reaches the database at all.** If you check
the limit after you've already done your database reads, the abuse you're trying
to block still gets to do the expensive part first — you've bought yourself
nothing under load."

---

## Q6 — "How would you scale this further?"

Phase 2 gives you the "already done" half of that answer — say it as a
*principle*, not a list:

"The thread through everything I've described is turning costs that **scale with
accumulated data** into costs that are **flat**. The collection scan scaled with
total rows; offset pagination scaled with scroll depth; the exclusion set scaled
with swipe history. Each fix made the cost bounded instead of growing.

And the infrastructure choices deliberately lean on being **stateless**. The API
tier holds no session state, the rate limiter's state lives in Redis rather than
in process memory — which is what actually makes 'add another instance' correct
rather than just theoretically possible. That's also exactly why the UTC day
boundary on the rate-limit window matters: if I'd used server-local time, two
instances in different timezones would disagree about what day it is and hand
the same user two separate quotas. It's a one-line decision that only shows up as
a bug once you're running more than one box."

---

## Bugs found and fixed along the way (good if asked "what else did you find?")

- **An error handler that hung the request.** One route's catch block called
  `req.statusCode(...)` instead of `res.status(...)` — which isn't a function.
  So *any* error in that route threw a second error from inside its own catch,
  meaning the request got **no response at all** and hung until the client timed
  out. A good one to mention: the error path was never tested, because error
  paths usually aren't.
- **The Mongo connection string logged on every boot**, credentials included.
  Harmless against a local database; a credential leak into log aggregation
  anywhere else.
- **A startup log hardcoded to the wrong port**, so it reported one port while
  listening on whatever was configured — small, but exactly the kind of thing
  that costs someone twenty minutes during an incident.

---

## 30-second version (the whole phase in one breath)

"Three things. I found a check-then-act race in our swipe endpoint — a `findOne`
followed by a separate `save`, so concurrent requests could both create the same
relationship. It was invisible to sequential testing and, importantly, one of its
triggers was ordinary user behaviour rather than abuse: two people swiping on
each other simultaneously. I fixed it by making the database the authority, with
a unique index on a *canonicalised* pair, since indexing the raw direction
columns would have missed that mutual case entirely — and rolled the index out
partially so it didn't fail to build against existing data. Then I moved
per-tier swipe limits onto an atomic Redis counter, so free-tier abuse costs a
cache operation instead of load on the database serving the feed, and it rejects
before the handler rather than after. And I replaced offset pagination with
cursor pagination and cached the feed's exclusion set fan-out-on-write, which
turned two costs that grew with a user's history into flat ones. The sequencing
mattered: the unique index is what made the cache safe to be eventually
consistent, because the worst a stale cache can do is show a repeat, and
re-swiping it just hits the constraint."
