# Phase 5 — Spoken interview answers

> The *say-out-loud* versions, in Problem → Action → Outcome shape so they stay
> recallable under pressure. Say them in your own words — don't recite.
>
> **This phase's answers are different in kind from Phases 1–4.** Those were "here
> is what I built and what it measured." This one is "here is how I decide what to
> build next" — so the thing being tested is **judgement and ordering**, not recall.
> The failure mode to avoid is listing technologies. The winning move is to name a
> *trigger*: the observable signal that says an item is due.
>
> Full reasoning, every trigger, and the grounding for each claim is in
> [phase-5.md](phase-5.md).

**The one structural idea behind every answer here:** a "how would you scale this"
answer has two halves — **what already shipped** (Phases 1–4, with measured
before/after) and **what I would do next, in order, with triggers**. Most candidates
only have the second half, which is why it sounds like a wish list. Always lead with
the first half; it is what makes the second credible.

**The patterns to actually say out loud:**

| Pattern | Where |
|---|---|
| Order by frequency × cost growth, not by size of the technology | Q1, Q2 |
| Every item needs a *trigger* — no trigger means it's a preference, not a plan | Q1, Q8 |
| Graceful degradation without instrumentation is an unnoticed outage | Q3 |
| Revocation and authorization inputs can't live in a self-contained token | Q4 |
| Capability staleness vs visibility staleness (when caching is safe) | Q5 |
| Cache unbounded cost; index proportional cost | Q5 |
| A unique index in a sharded collection must be prefixed by the shard key | Q6 |
| Job queue vs log — shape, not size | Q7 |
| Scale-appropriate choice ≠ gap (the same decision, made three times) | Q7 |
| Fix security debt before making the system bigger | Q9 |
| Prevention via prefix-as-state beats a reconciliation job that deletes | Q10 |
| Cheap+reversible before expensive+one-way | Q2, Q6 |

---

## Q1 (primary) — "How would you scale this further?"

**Lead with the half that already exists.** Then give the ordering *rule* before
giving the list, because the rule is the thing being assessed.

**Problem.** "Everything I'd done so far was reactive — I found a problem, measured
it, fixed it. The question 'what next' is different, because the honest answer is
that I'd be guessing unless I can say *why one item comes before another*."

**Action — half one, what already shipped.** "The first half of my answer isn't
hypothetical. We took a daily cron that was full-scanning our fastest-growing
collection down to zero documents examined with a partial covering index. We moved
email and payment side effects onto a job queue so a slow provider can't block a
request path. We replaced skip-based pagination with cursor pagination, which took
deep-page key examinations from ten thousand to eleven. We split chat messages out
of an embedded array that had a hard 16MB ceiling, and added a Redis pub/sub adapter
so sockets work across instances. And image uploads go directly to object storage, so
our cost per upload is flat regardless of file size."

**Action — the ordering rule.** "For what's next, I order by **how often the path
runs, times how its cost grows** — not by how big the technology is. That's why the
next thing I'd fix is an auth middleware doing a `findById` on every authenticated
request, and sharding is near the bottom. The `findById` is cheap and constant, but
it runs on *every single request*, and the fix is a cache with two invalidation
points — days of work, fully reversible. Sharding is a near-one-way door that only
pays once a collection outgrows one replica set, which ours hasn't."

**Action — and the thing I'd actually do first.** "Honestly, before any of it:
instrumentation. Every finding in those four phases came from reading code and then
running `.explain()` by hand. That worked, but it only works when you already
suspect something. Nothing in the app would have *told* me."

**Outcome.** "So the roadmap has tiers: security debt that outranks everything,
then cheap high-frequency fixes, then things that come due at the next order of
magnitude, then things that only matter if a specific shape changes — like the
graph becoming one-way follows. Each item names the signal that makes it due, so
it's a backlog rather than a list of technologies."

---

## Q2 — "What would break first?"

**Problem.** "Two different questions hide in that one: what degrades first, and
what *fails* first. They have different answers here."

**Action.** "What degrades first is read load on the primary, and the biggest single
contributor is the one query I run on every authenticated request — the user lookup
in auth middleware. It's an indexed primary-key read, so it's not slow; it's just
unavoidable and constant, multiplied by every request in the system.

What *fails* first is less obvious, and it's an operational failure rather than a
performance one: three of my designs deliberately degrade silently. The feed cache
fails open to Mongo on a Redis error, so a cache outage presents as 'the app got
slow again'. A missing thumbnail is a valid state the client renders around, so a
dead thumbnail worker presents as 'images feel heavy'. And the socket Redis adapter
failing means messages still deliver within an instance but silently not across
instances. Each of those is the right availability choice. Each also means an
outage looks like normal operation."

**Outcome.** "So my answer is: performance-wise, the auth lookup; operationally, any
of the three fail-open paths — and I can't currently tell when one of them has
fired. That's why instrumentation is the first item on my list even though it ships
no feature."

---

## Q3 — "What's missing from this project?"

Answer this one straight. The temptation is to defend; the stronger move is to name
the real gap precisely, because it shows you know what production needs.

**Problem.** "Observability, and I'd rather say it before you find it. I have good
*evidence* — query plans, before/after numbers, reproduced failures — and almost no
*signal*."

**Action.** "The distinction matters. Both of the full collection scans I fixed were
found by reading code and then confirming with `.explain`. Neither raised an alert,
because there's nothing to raise one. And it's worse than just unmonitored, because
I deliberately built three things that fail open or degrade quietly — the feed cache
falls back to Mongo, a null thumbnail still renders, the socket adapter keeps
delivering locally. Those were the right calls for availability. They also mean the
system hides its own failures.

So in order: Mongo slow-query profiling first, because that's the one thing that
would have surfaced both of those collection scans *automatically* — which is a
concrete claim about its value, not a general belief in monitoring. Then p95 and p99
route latency, not averages, because an average hides exactly the deep-pagination
and sparse-graph cases I spent two phases on. Then queue depth and oldest-job age,
which is what makes 'a missing thumbnail is fine' safe to *operate* rather than just
safe to write. Then cache hit rate, since a fail-open cache at zero percent hit rate
looks healthy."

**Outcome.** "The line I'd use: **graceful degradation without instrumentation is
just an outage you haven't noticed yet.**"

**Also honest, if they push:** "There's open security debt too — a JWT secret
committed to the repo, password hashes in API responses, a webhook signature checked
against re-serialized JSON instead of raw bytes. I've kept those documented rather
than quietly dropped, and they outrank every performance item. You don't shard a
database whose tokens can be forged."

---

## Q4 — "What's the single next thing you'd fix, and why that one?"

**Problem.** "The auth middleware does a `User.findById` on every authenticated
request — every feed page, every swipe, every message, every like. It's the most
executed query in the application."

**Action — and this is where the answer gets interesting.** "The reflexive fix is
'put the user's fields in the JWT and skip the database.' That's wrong here, and
knowing why is the actual content of the answer.

Two things that lookup provides can't live in a self-contained token. First,
**revocation**: tokens last seven days, so if an account is banned or deleted on day
one, a token-only check keeps it working until day seven. The database read is what
makes revocation possible at all. Second, **the membership tier is an authorization
input, not a display field** — my rate limiter reads it to pick a daily swipe
ceiling. A user who just paid for Silver expects their higher limit *now*, not when
their token rotates. A stale tier claim isn't a cache miss, it's a billing
complaint.

So the read is load-bearing. The fix is to stop it hitting Mongo, not to remove it:
a Redis cache-aside on the user record, short TTL *plus* explicit invalidation on the
only two writers — profile edit, and the payment worker's premium upgrade — and fail
open to Mongo so a Redis outage degrades to today's performance rather than to
nobody being able to log in."

**The ordering detail worth adding.** "One sequencing constraint: I'd fix the
password-hash leak *first*. The middleware currently fetches the whole user
document, so caching what it fetches would write password hashes into Redis. Adding
`select: false` before building the cache is the difference between one bug and
two."

**Outcome.** "Highest-frequency path in the app, fixed with a cache that has exactly
two invalidation points, fully reversible. That's why it's ahead of everything
bigger on the list."

---

## Q5 — "How do you decide when to add a cache?"

This is the strongest *judgement* answer in the phase, because the interesting part
is the case where the answer was **no**.

**Problem.** "I've got two caches and one deliberate refusal, and the refusal is the
one that shows the rule."

**Action — the rule.** "**Cache to fix an access pattern whose cost is unbounded —
not to shave a millisecond off one that's already proportional to its result.**

The feed's exclusion set qualified: it was reading *every* connection request the
user had ever made, on every feed page, to build a list of profiles to hide. That
cost grew for the life of the account and produced an identical answer on every page
of the same scroll. Caching converted an unbounded read into a bounded one.

The connections list did *not* qualify, even though it looks like the same shape.
After I indexed it properly, its cost is proportional to the number of connections —
which is the size of the answer itself, so there's nothing to amortise. A cache
would buy one avoided round trip and cost a second source of truth to invalidate on
every accept, every disconnect, every account deletion. And those are exactly the
paths where staleness stops being a performance detail: the posts feed uses that
list as its **access-control boundary**, so a stale entry means showing a removed
connection's posts. An index was the right fix there; a cache was the right fix on
the other one."

**The follow-up they'll ask, so pre-empt it.** "Which raises the obvious objection:
I just said I want to cache the user record, and the membership tier is an
authorization input too. The difference is what staleness *does*. A stale connection
list is a **visibility** boundary — being wrong leaks another user's content, and
nobody sees it happen. A stale tier flag is a **capability ceiling** — being wrong
for a minute means someone gets a hundred swipes instead of twenty. Bounded,
self-correcting, not a privacy event.

The case that genuinely worries me is banning and deletion, where a stale record
means a banned account can act for up to a minute. That's why invalidation is
explicit on the writers rather than TTL-only — and it means whoever writes the
account-deletion route has to drop that key as part of the operation."

**Outcome.** "So: unbounded cost justifies a cache; proportional cost wants an
index; and if the cached value is an authorization input, the question becomes what
staleness costs — a capability you can bound, or a visibility boundary you can't."

---

## Q6 — "How would you shard this?"

**Problem.** "If we outgrew one replica set, the two collections worth sharding are
connection requests and messages — those take a write on every swipe and every
message. Sharding users or payments would be solving the wrong problem; they're
small and slow-growing, and you'd add a routing hop to every auth lookup."

**Action — the constraint most people miss.** "The shard key isn't a free
distribution choice, because **in a sharded collection a unique index is only
enforceable if the shard key is a prefix of it.** That rule dictates everything
here, because my correctness depends on unique indexes — the canonicalised-pair
unique index is literally what fixed the duplicate-connection-request bug under
concurrency, where a ten-way burst was creating eight rows for one pair.

So sharding connection requests on a hashed sender id — the obvious choice, good
distribution — would **silently reintroduce that bug**. And it'd come back in the
form that's hardest to catch, since it never shows up in sequential testing. That's
disqualifying on correctness grounds, before you even get to the fact that it
scatter-gathers the 'requests I received' direction."

**Action — the honest working-through.** "Messages are clean: hash on the chat id.
Every read is already scoped by chat id, so that makes history a single-shard
targeted query, and there's no unique index to constrain the key. Hashing on a user
id would be wrong — a message has two users and the query filters on neither.

Connection requests are genuinely hard, and I'd rather say that than invent
confidence. The unique-index rule pushes the key toward the canonicalised pair
itself, which keeps uniqueness but scatter-gathers both list directions. And it has
a distribution wrinkle: ObjectIds carry a timestamp prefix, so the lower of the two
ids skews toward early-registered accounts, which risks chunk hot-spotting on a
ranged key — and a hashed key would fix the skew but can't be unique. The way out,
if that skew turned out to be real, is to denormalise into two directed edge
documents so each direction is targeted by its owner — fan-out-on-write applied to
the graph, doubling writes on the heaviest write path to make both reads targeted."

**Outcome.** "I'd name that option and decline it for now. This is the item I'd
least want to answer from first principles and most want to measure — resharding
exists but it's expensive and slow, so it's effectively a one-way door. Which is
itself the strongest argument for exhausting read replicas and archiving *first*."

---

## Q7 — "Why not Kafka? / Why not microservices? / Why not Kubernetes?"

**Treat all three as one question**, because they have one answer, and saying so is
the point.

**Problem.** "These usually get asked as gaps. I'd argue they're the same decision
made three times, deliberately."

**Action — Kafka, and the sharper framing.** "The weak version is 'BullMQ for small
scale, Kafka for large scale.' The real distinction is **shape, not size**:
**BullMQ is a job queue, Kafka is a log.** All three of my queues are
single-consumer *command* queues — send this email, process this payment, resize
this image. One thing should happen to each job, and then it's finished. A log is for
*events* that many independent consumers read at their own positions and may
re-read. Nothing I've built wants that. The day a notification service and an
analytics pipeline both need to react to 'a post was created', that's an event, and
the log shape starts paying for itself.

What I *would* fix in the current design is less glamorous and more real:
Redis-backed BullMQ can lose enqueued jobs if Redis loses data, unless persistence
is configured and actually verified. 'I chose BullMQ and configured AOF' is a much
stronger answer than 'I chose BullMQ because it's simpler.'"

**Action — services and orchestration.** "A service-per-domain split buys
independent deploys at the cost of network calls and distributed failure modes,
across a connection graph that's currently one indexed query. The API tier is
already stateless — JWT auth, no server-side session — so horizontal scaling is
'add an instance behind a load balancer', and the Redis socket adapter is what makes
that *correct* for websockets rather than just theoretically possible.

The one split with a real argument is pulling the websocket gateway out, and notably
the argument isn't throughput — it's **deploy semantics**. An API deploy is a rolling
restart nobody notices. A gateway deploy disconnects every socket at once and causes
a reconnect storm. Right now they're the same process, so every API deploy is also a
mass client reconnect. Splitting them lets the API ship continuously.

Kubernetes I'd decline for the same reason: my deployment need is 'N stateless API
instances and a worker', which every managed platform does directly. k8s adds a
control plane to operate for a topology that doesn't need orchestrating yet."

**Outcome.** "The line: **match the infrastructure to the load you have, and know
the specific signal that says it's time to change.** Choosing BullMQ over Kafka, one
replica set over a sharded cluster, and a monolith over services are all the same
decision — and a scale-appropriate choice isn't a gap."

---

## Q8 — "How would you know when to do any of this?"

Short answer, and it's the one that separates a plan from a wish list.

**Problem.** "An item without a trigger is a preference, not a plan. So every item
on my list has one."

**Action.** "Some examples. For dropping an index I believe is dead: `$indexStats`
showing zero accesses sustained across a full business cycle — including the daily
cron and any backfill script. Not a grep; the planner can pick an index for a query
shape nobody wrote deliberately.

For splitting the thumbnail worker out: email job age rising during upload bursts.
That correlation *is* the coupling — it means a CPU-bound workload is stealing the
libuv threadpool from network-bound ones in the same process.

For hybrid fan-out on the feed: p95 feed latency scaling with viewers' *connection
counts* rather than with collection size. That's the specific thing that would mean
the merge's cursor coordination has become the cost.

For read replicas: primary CPU dominated by reads, with replication lag comfortably
inside the staleness budget of the paths I'd move."

**Outcome — and close with the honest part, because it's the strongest note.** "The
uncomfortable observation is that **almost none of those triggers is currently
observable.** No query profiler, no latency histograms, no queue-depth metric, no
cache hit rate. So the first item on my roadmap is the prerequisite for knowing when
any of the rest are due. I'd rather end a scaling plan there than on a list of
technologies."

---

## Q9 — "What's the first thing you'd do if this went to real production tomorrow?"

**Problem.** "Not a performance item. There's a JWT secret committed to the
repository."

**Action.** "The token signing secret is a literal string in the source, and the
middleware verifies against an environment variable — so they only match if that
variable is set to the same string. Anyone who can read the repo can forge a token
for any user id. Alongside it: password hashes are returned in API responses because
the field has no `select: false`, the auth cookie has no `httpOnly`, `secure` or
`sameSite`, and the payment webhook validates its signature against re-serialized
JSON rather than the raw bytes the provider actually signed — so valid webhooks can
fail and the check is weaker than it looks.

I've kept all of those in an issues document rather than quietly dropping them,
annotated as fixed where a phase fixed one, which is also what makes the before/after
stories checkable."

**Outcome.** "**You don't shard a database whose tokens can be forged.** Sharding
behind a forgeable JWT makes a security hole faster and more expensive to fix, not
less severe. So Tier 0 is security debt, and the performance roadmap starts after
it — with one ordering detail: the password-hash fix is a *prerequisite* for the
user cache, since caching what the middleware currently fetches would write hashes
into Redis."

---

## Q10 — "You mentioned orphaned objects. How would you clean those up?"

A small question that's a good test of whether you reach for the obvious wrong
answer.

**Problem.** "Uploads go straight to object storage via a presigned URL, then a
second call claims the object and creates the row. Which means a client can upload
and never claim — usually not abuse, just someone closing the app mid-upload — and
you get an object with no row."

**Action.** "The obvious answer is a storage lifecycle rule: expire objects in the
posts prefix after N days. **That's not imperfect, it's destructive** — lifecycle
rules act on age and can't tell a claimed object from an unclaimed one, so it would
delete the images of every live post older than a week.

So either you make the state visible in the key layout, or you reconcile. I'd do the
first: upload to a `staging/` prefix, and on claim do a **server-side copy** into the
posts prefix and delete the staged object. Then a brutally simple lifecycle rule —
expire `staging/` after a day — does all the reaping, with no job to write, monitor
or get wrong. The copy happens inside the object store, so no bytes come back
through Node, which preserves the whole point of the design.

The reconciliation alternative — list the prefix, anti-join against the posts
collection, delete what has no row — has a subtle correctness condition worth
naming: it must only consider objects older than the presigned URL's lifetime plus
claim latency, or it races a legitimate in-flight upload and deletes an object the
user is about to claim."

**Outcome.** "I'd use prefix-as-state for prevention, and run the reconciliation job
as a periodic audit that **reports** rather than deletes until its numbers are
trusted. A job whose first production action is bulk-deleting user content is a job
that should report first."

---

## If asked "so what did you actually do in this phase?"

Don't dress it up. "No code — it's a written roadmap, and that was the point. The
deliverable is an ordered backlog where every item names the observable trigger that
makes it due, the cost, and the reason it isn't worth doing yet. Each one traces
back to something concrete in the repo: a measured query plan, a limitation I
documented when I hit it, or a verified failure — like finding that a presigned PUT
genuinely can't cap file size, because a 24MB upload against a 5MB policy returned
200 and stored the object.

The thing writing it down actually changed: I found an ordering constraint I hadn't
noticed. I wanted to archive old rejected connection requests as cold data — except
the feed's 'don't show me this again' set is *derived* from that same request
history, regardless of status. So deleting them would un-hide every profile the user
ever rejected. The storage cleanup would have shipped as a product regression. That
means 'seen profiles' has to become its own durable state *before* any of those rows
can be archived — two changes, in that order, and I only found it by writing the
roadmap rather than by building the next thing."

---

## 30-second version (the whole phase in one breath)

"Phase 5 is the forward-looking half of 'how would you scale this' — written as an
ordered backlog rather than a list of technologies. The ordering rule is frequency
times cost growth, which is why the next thing I'd fix is an auth middleware doing a
user lookup on every authenticated request, and sharding is near the bottom: one is
cheap and reversible on the hottest path, the other is a one-way door that only pays
once we outgrow a replica set. Security debt outranks all of it — there's a JWT
secret committed to the repo, and you don't shard a database whose tokens can be
forged. But the item I'd argue hardest for is instrumentation, because three of my
designs deliberately fail open or degrade silently, and graceful degradation without
instrumentation is just an outage nobody has noticed. Every item names the signal
that makes it due — and the honest conclusion is that almost none of those signals
is currently observable, which is why that one comes first."
