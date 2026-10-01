# Now Connect — architecture overview

**What this document is:** the single cross-phase view of the system. Every other
document in `docs/` is scoped to one phase and written as a *change* story
(Problem → Investigation → Options → Decision → Outcome). This one describes the
system as it stands, in the order you would actually need to understand it, and
points at the phase docs for the reasoning behind each decision.

**Read this first** if you are new to the codebase, returning to it after a gap, or
preparing to explain it out loud. It is also the answer to the one interview
question the per-phase answer files do not cover: *"tell me about your project."*
There is a ready-to-say version at the [end](#the-two-minute-version).

---

## 1. The product in one breath

Sign up → get a feed of other users → swipe **interested** or **ignored** → when it
is mutual you are **connected** → connected users can chat in real time and see each
other's image posts. A premium tier raises the daily swipe ceiling.

Everything in the system hangs off that one relationship. The connection graph is
the authorization boundary for chat *and* for the posts feed, which is why it has
its own shared utilities rather than being re-queried per feature.

---

## 2. The process model

This is the part worth understanding before any individual route, because it
explains several decisions that otherwise look arbitrary.

```
┌─ API process ───────────────────────┐   ┌─ Worker process ─────────────┐
│  src/app.js        (npm run dev)    │   │  src/workers/index.js        │
│                                     │   │       (npm run worker)       │
│   Express REST  ┐                   │   │                              │
│   Socket.io     ┴ ONE http server   │   │   emailWorker                │
│                   ONE port (:7777)  │   │   paymentWorker              │
│                                     │   │   thumbnailWorker            │
│   + node-cron, in-process           │   │   (3 separate BullMQ queues) │
└──────────────┬──────────────────────┘   └──────────────┬───────────────┘
               │                                         │
      ┌────────┴──────────┬──────────────────┬───────────┘
      │                   │                  │
   MongoDB             Redis            S3 / MinIO
   source of truth     • feed exclusion cache    image bytes only
                       • swipe rate counters     (never through Node)
                       • BullMQ queues
                       • Socket.io pub/sub
```

**Two deployables, three backing services.**

- **The API tier is stateless** — identity is a JWT in a cookie, there is no
  server-side session. So horizontal scaling is "run another instance behind a load
  balancer", and the Socket.io Redis adapter is what makes that *correct* for
  websockets rather than merely possible (see [phase-3.md](phase-3.md)).
- **Express and Socket.io share one http server and one port.** `initializeSocket`
  is handed the same `http.createServer(app)` instance
  ([`src/app.js:38-44`](../src/app.js:38)), so the websocket upgrade happens on the
  same origin as the REST API — which is also why the auth cookie works for both.
- **The worker is a separate process on purpose.** A notification or upload spike
  cannot steal CPU from request handling. All three workers currently share that one
  process, but they are **separate queues**, so splitting any one out later is a
  deployment change rather than a code change
  ([`src/workers/index.js:5-18`](../src/workers/index.js:5)).

**One wrinkle to know before someone finds it:** the cron is `require`d *inside* the
API process ([`src/app.js:10`](../src/app.js:10)), so it runs in every API instance.
At two instances the 8 AM job fires twice. Fine today, wrong at scale, and the honest
answer is "it should be its own scheduled process or hold a lock."

### Local development

Redis and MinIO run natively via Homebrew on this machine (Docker Desktop is
unsupported on macOS 13); `docker-compose.yml` is kept as portable documentation
only. Setup is in [`README.md`](../README.md) and the reasoning in
[phase-0.md](phase-0.md). One env var — `S3_ENDPOINT` — switches MinIO ↔ real S3
with **no code branch**, which is why the same `src/config/s3.js` serves both.

---

## 3. Auth — the spine every request crosses

```
POST /signup | /login
   └─ bcrypt → user.getJWT() → token cookie (7d)

any protected route
   └─ userAuth: cookie → jwt.verify → User.findById → req.user

websocket handshake
   └─ io.use(authenticateSocket): same cookie → socket.user
```

`userAuth` ([`src/middlewares/auth.js`](../src/middlewares/auth.js)) is the most
executed code in the application — every feed page, swipe, message, like and post
passes through it.

**Sockets authenticate at the handshake, from the same cookie as REST**
([`src/utils/socket.js:156`](../src/utils/socket.js:156)). That is the Phase 3
change that matters most: `socket.user` becomes the *only* source of sender
identity, so a client-supplied `userId` in an event payload is ignored entirely.
Before it, anyone could send messages as anyone. See
[phase-3.md](phase-3.md).

Two known issues live right here and are worth naming rather than discovering:
the token is **signed** with a string literal in
[`src/models/user.js:86`](../src/models/user.js:86) while it is **verified** from
`process.env.JWT_SECRET`, and the cookie carries no `httpOnly` / `secure` /
`sameSite`. Both are open items in [`ISSUES.md`](../ISSUES.md).

---

## 4. The domain model

### `ConnectionRequest` **is** the edge

There is no separate "connections" table. One document per pair:

| Field | Meaning |
| --- | --- |
| `fromUserId` / `toUserId` | who swiped first, and on whom |
| `status` | `interested` · `ignored` · `accepted` · `rejected` |
| `userIdLow` / `userIdHigh` | the same two ids **sorted** — a canonical pair key |

**Direction is a historical artifact**, not a property of the relationship: whoever
swiped first is `fromUserId`. That single fact explains why every "my connections"
query is an `$or` across both directions, and why that `$or` needed two indexes
rather than one ([phase-4.md](phase-4.md)).

**The canonical pair exists so the database can enforce uniqueness.** Sorting the
two ObjectIds as hex strings gives a stable total order, so (A,B) and (B,A) produce
the same key — which a unique index can then reject. This is what replaced a
check-then-act race ([phase-2.md](phase-2.md)).

### Two read shapes, deliberately shared

| Util | Question | Callers |
| --- | --- | --- |
| [`connectionGraph.js`](../src/utils/connectionGraph.js) | "who am I connected to?" (one-to-many) | posts feed, `GET /user/connections` |
| [`connectionGuard.js`](../src/utils/connectionGuard.js) | "are A and B connected?" (one-to-one) | chat HTTP route, `joinChat`, `sendMessage` |

Both exist as utils for the same reason: **two copies of a graph traversal drift.**
One gets the index-friendly rewrite and the other does not; one remembers the
relationship is bidirectional and the other forgets. Since both answers are used as
*authorization* inputs, drift there is a security bug rather than an inconsistency.

### The rest

`User` (profile + `isPremium` / `membershipType`), `Chat` (participants, canonical
pair, `lastMessageAt`), `Message` (one document per message), `Post` (a caption plus
a **pointer** into object storage), `Like` (one document per like), `Payment`.

---

## 5. The four user-facing flows

### 5a. Feed and swiping

```
GET /feed
  └─ feedCache.getExcludedIds(me)        ← Redis set, else rebuild from Mongo
  └─ User.find({_id: {$nin: excluded}, _id: {$gt: cursor}}).limit(n)

POST /request/send/:status/:toUserId
  └─ userAuth → swipeRateLimiter → handler
  └─ insert; E11000 → 409
  └─ feedCache.addInteraction(me, them)   ← both sides
```

**The exclusion set** ([`feedCache.js`](../src/utils/feedCache.js)) is the "don't
show me this profile again" list. It used to be recomputed from the user's *entire*
interaction history on every feed page — a cost that grew for the life of the
account to produce an answer identical on every page of one scroll session. It is
now a Redis set kept current fan-out-on-write, with a 10-minute TTL, and it
**falls back to Mongo if Redis is unavailable**: a cache outage must not become a
feature outage.

**The rate limiter** ([`rateLimiter.js`](../src/middlewares/rateLimiter.js)) sits
*after* `userAuth` (it needs `req.user` for the tier) and *before* the handler, so a
rate-limited swipe costs one Redis `INCR` and **never reaches Mongo**. It is a Lua
script doing `INCR` plus a conditional `EXPIRE` atomically — one round trip, and no
race where two concurrent first-requests both set a fresh TTL. Ceilings come from
[`swipeLimits`](../src/utils/constants.js:14), and gold's `Infinity` means the
limiter skips Redis entirely rather than decoding a sentinel.

Then `POST /request/review/:status/:requestId` accepts or rejects a received
request. Reasoning: [phase-2.md](phase-2.md).

### 5b. Chat

```
GET /chat/:targetUserId?before=<messageId>&limit=50
  └─ connectionGuard → Chat (upsert, atomic) → Message.find({chatId, _id: {$lt}})

socket joinChat   → connectionGuard → socket.join(room)
socket sendMessage → connectionGuard (AGAIN) → Message.create → io.to(room).emit
```

History is cursor-paginated out of a flat `Message` collection indexed
`{chatId, _id: -1}`. The original design stored every message in one embedded array
on `Chat`, which rewrites the whole document on every message and has a hard 16MB
ceiling — reproduced as a real failure before being fixed
([phase-3.md](phase-3.md)).

Two details worth saying out loud:

- **`sendMessage` re-authorizes on every send** rather than trusting the join. A
  cached authorization would keep delivering after a connection was removed.
- **Emits go through the Redis adapter**, so a message reaches participants
  connected to *other* API instances. Without it, Socket.io rooms are an in-memory
  map per process and a second instance silently cannot deliver.

### 5c. Posts

The three-step upload is the centrepiece of the system.

```
1. POST /posts/upload-url   → presigned PUT URL + key   (content-type signed, 5-min TTL)
2. client → S3 directly     → bytes NEVER touch Node
3. POST /posts (claim)      → HeadObject (size + type) → create row → enqueue thumbnail
                              oversized? delete the object, 413
```

**Why:** proxying uploads through Express doubles every byte's journey (client → us
→ S3), holds an event-loop-bound process open for the length of a slow mobile
upload, and makes memory scale with concurrency × file size. With a presigned URL
our cost per upload is **constant regardless of image size**.

The price is that "upload" stops being one atomic operation and becomes three steps
across two systems — and every interesting edge case in
[`postStorage.js`](../src/utils/postStorage.js) follows from that trade. Notably: a
presigned PUT **cannot cap object size** (verified — a 24.7 MB upload against a 5 MB
policy returns `200`), so size is enforced at claim time instead, and the object is
deleted when refused.

```
GET /posts/feed
  └─ getAcceptedConnectionIds(me)
  └─ Post.find({userId: {$in: ids}, _id: {$lt: cursor}}).sort({_id: -1})
  └─ ONE batched "which of these did I like" query     ← not N queries
  └─ mint short-lived presigned GET URLs per post
```

Reads are signed too, not public: posts are visible only to accepted connections, so
a permanent public object URL would mean the access rule held in the API and not in
the storage layer. **An access control that only one of two doors enforces is not an
access control.**

**Likes** are their own collection with a unique `{postId, userId}` index, so a
double-like is idempotent *by index* rather than by an application check, plus a
denormalized `likeCount` maintained with `$inc` (read on every feed impression,
written once per like — hundreds-to-one, the textbook case for precomputing).

**Thumbnails** are generated on the worker. The design that makes that safe is
`thumbnailKey: null` being a **valid, renderable state** — clients render
`thumbnailUrl ?? imageUrl`, so a backed-up or crashed worker degrades image weight,
never availability. Reasoning: [phase-4.md](phase-4.md).

### 5d. Payments

Razorpay order creation → webhook → verify signature → **ack immediately** → enqueue
the DB update (payment status + user upgrade) rather than doing it inline. That is
the answer to "how do you handle a burst of webhook calls without falling behind",
and the handler is idempotent against redeliveries ([phase-1.md](phase-1.md)).

> ⚠️ **Currently disabled.** The payment router is commented out at
> [`src/app.js:25`](../src/app.js:25) and [`:34`](../src/app.js:34). The code exists
> and Phase 1 hardened the webhook, but the routes are not mounted. Describe it as
> "built but currently disabled" — do not demo it.

---

## 6. Async and scheduled work

```
node-cron  "0 8 * * *"
  └─ ConnectionRequest.distinct("toUserId", {status, createdAt})   ← COVERED query
  └─ User.find({_id: {$in: ids}}, {emailId: 1})                    ← projection only
  └─ addEmailJob(...) per recipient                                ← never sends inline
```

The cron's only job is to compute recipients and enqueue. It does not send mail, so a
slow or down provider cannot block it — the Phase 1 point.

Three queues, with **retry policies tuned to different failure modes** rather than
one shared default:

| Queue | Attempts | Why |
| --- | --- | --- |
| `email` | 5, exponential | Rides out a provider outage, which can last minutes |
| `payment` | retry + backoff | Must not lose a webhook's effect |
| `thumbnail` | 3, 2s base | Failure is either a transient S3 blip (retry helps) or an undecodable image (retry **never** helps — marked non-retryable instead of burning attempts) |

---

## 7. The data layer — the indexes *are* the design

| Collection | Index | Serves |
| --- | --- | --- |
| `User` | `emailId` unique | login / signup uniqueness |
| `ConnectionRequest` | `{fromUserId, toUserId}` | **dead weight** — Phase 2 removed its only query; slated for removal |
| | `{status, createdAt, toUserId}` partial on `status: "interested"` | the 8 AM cron, as a *covered* `distinct` |
| | `{userIdLow, userIdHigh}` unique partial | one request per pair, enforced by the DB |
| | `{fromUserId, status, toUserId}` | "connections I initiated" — covered |
| | `{toUserId, status, fromUserId}` | "connections offered to me" — covered |
| `Chat` | `{participantLow, participantHigh}` unique partial | one conversation per pair |
| | `{participants, lastMessageAt: -1}` | "my conversations, newest first" (declared ahead of its route) |
| `Message` | `{chatId, _id: -1}` | one page of history, newest first |
| `Post` | `imageKey` unique | idempotency key for the claim step |
| | `{userId, _id: -1}` | the connection-scoped feed page |
| `Like` | `{postId, userId}` unique | like idempotency + "did I like this" |

Three facts about this table that are the real architecture:

1. **Both `$or` directions are indexed.** MongoDB's `$or` subplanner needs an
   indexed plan for *every* branch — a half-indexed `$or` performs exactly like an
   unindexed one, with no partial credit. That is why there are two indexes here
   rather than one, and it was verified by measuring the wrong fix first
   ([phase-4.md](phase-4.md)).
2. **The trailing field in each compound index is chosen so the query is covered** —
   answered from index keys with `totalDocsExamined: 0`. One extra field in a
   projection is the difference between covered and not.
3. **Four unique indexes do work that application code would otherwise do badly.**
   Every one of them replaced, or pre-empted, a check-then-act race.

---

## 8. The conventions that make this a system

If asked "what is the design of it?", this is the list to lead with — these are
cross-cutting, which is what distinguishes a system from a pile of features.

- **One pagination convention.** `_id` cursor, descending, `limit + 1` to detect the
  next page — used by the swipe feed, chat history and the posts feed. Three call
  sites, one convention, so a pagination change is one change. `_id` rather than
  `createdAt` because it is unique and tie-free, which is what correctness under
  concurrent inserts requires.
- **Correctness from the database, not from check-then-act.** Unique indexes on
  canonicalized pairs, and duplicate-key errors read as expected outcomes (`409`,
  "already claimed") rather than 500s.
- **Fail open on performance, fail closed on authorization.** Caches and rate
  limiters degrade to "correct but slower"; authorization checks refuse. A Redis
  outage must not be a feature outage — and must not be a security hole either.
- **Shared utilities wherever two callers ask the same question**, especially when
  the answer is an authorization input.
- **One env var, no code branch.** `S3_ENDPOINT` switches MinIO ↔ real S3.
- **Deferred work is only deferred where "not done yet" is a valid state.** That is
  why `thumbnailKey` is nullable, and it is the test for whether work genuinely
  belongs on a queue or was merely moved onto one.

---

## 9. Known gaps

Kept visible on purpose. The full ledger is [`ISSUES.md`](../ISSUES.md); the ordered
plan for the scaling half is `docs/phase-5.md`.

- **Security debt outranks everything else.** The hardcoded JWT signing secret,
  password hashes returned to clients, an unhardened auth cookie, and a webhook
  signature checked against re-serialized JSON rather than raw bytes.
- **No observability.** Every problem in Phases 1–4 was found by reading code and
  then confirming with `.explain()`. Nothing in the system would have reported any
  of it — and three designs deliberately degrade *silently* (the feed cache falls
  back to Mongo, a null thumbnail still renders, the socket adapter keeps delivering
  locally), so an outage can look like normal operation.
- **`userAuth` hits Mongo on every request** — the most-executed query in the app,
  and the next thing worth caching.
- **The cron runs in every API instance**, so it double-fires at two instances.
- **Payments are not mounted.**

---

## 10. Where to read more

| Document | Covers |
| --- | --- |
| [phase-0.md](phase-0.md) | Shared infra: Redis, S3/MinIO clients, env, local setup |
| [phase-1.md](phase-1.md) | The cron `COLLSCAN` incident; BullMQ; webhook hardening |
| [phase-2.md](phase-2.md) | Tier rate limiting; cursor pagination; the duplicate-request race |
| [phase-3.md](phase-3.md) | Chat at scale: the 16MB cap, socket authz, the Redis adapter |
| [phase-4.md](phase-4.md) | Posts: presigned uploads, the `$or` `COLLSCAN`, async thumbnails |
| `phase-5.md` | The forward-looking scaling roadmap (tiers, triggers, non-goals) |
| `phase-N-answers.md` | Spoken Problem → Action → Outcome answers, per phase |
| [`ISSUES.md`](../ISSUES.md) | Every finding, with fixed items annotated in place |

The phase docs are *change* stories and assume the "before" state; this document is
the "now". Read this one first, then the phase doc for whichever decision you need
the reasoning behind.

---

## The two-minute version

For "tell me about your project". Roughly 310 words — about two minutes spoken. Say
it in your own words; the **structure** is the part that matters: product in one
line → what the work actually was → three concrete wins → the one you are proudest
of → the honest gap.

> Now Connect is a social networking backend — Node, Express and MongoDB. Users sign
> up, get a feed of people, swipe to show interest, and when it is mutual they become
> connected. Connected users can chat in real time over websockets and share image
> posts. There is a premium tier that raises the daily swipe limit.
>
> It started as a working CRUD app. What I actually spent my time on was taking it
> from "works on my machine" to something that would hold up under real data growth —
> and I did that in five phases, each one a real before-and-after you can see in the
> git history.
>
> The pattern was the same every time: find what breaks as data grows, measure it,
> fix it, measure again. So — there was a daily cron job doing a full collection scan
> on our fastest-growing collection. I found it with `.explain()` and fixed it with a
> partial covering index: documents examined went from eight thousand to zero. Chat
> was storing every message in one embedded document, which has a hard 16MB ceiling —
> I reproduced the actual failure, then moved messages into their own collection with
> cursor pagination. And image uploads now go straight from the client to object
> storage using a presigned URL, so the API never handles image bytes at all.
>
> The two I am most pleased with are concurrency bugs that do not show up in ordinary
> testing. Both were check-then-act races — one creating duplicate connection
> requests, one splitting a conversation across duplicate chat documents. A ten-way
> concurrent test produced eight rows where there should have been one. I fixed both
> by letting the database enforce it, with a unique index on a canonicalized pair,
> instead of checking first in application code.
>
> The last phase is a written roadmap of what I would do next and what signal would
> tell me it is due. The honest gap is observability — I found all of this by reading
> code, not because the system told me.

**Delivery notes.**

- **Pause after the first paragraph.** Interviewers often jump in with "okay, tell me
  about the chat part" — and then you are in a conversation instead of a monologue,
  which is the goal.
- **The hooks are deliberate.** `.explain()`, "16MB ceiling", "presigned URL",
  "check-then-act", "observability" — each opens a door into a question that already
  has a prepared answer in a `phase-N-answers.md` file.
- **Cut to 60 seconds** by keeping paragraphs 1, 2 and the concurrency one, and
  reducing the three examples to just the cron `COLLSCAN`.
- **One number per story.** 8,000 → 0 and 8 → 1 are memorable; three numbers in a row
  is a recital.
- **Do not claim payments work** — see §5d.
