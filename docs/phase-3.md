# Phase 3 — Chat at scale

**Talking point:** "Our chat stored every message of a conversation in one
embedded array on a single document. That design has a hard ceiling — MongoDB
refuses any document over 16MB — and it rewrote the entire history on every
message sent. We split messages into their own collection and cursor-paginated
the read path. While doing it we found the socket layer trusted the client for
the sender's identity, so we moved socket authentication onto the same JWT the
REST API uses, and added the authorization check that had been sitting there as
a TODO. We also added the Redis adapter, because Socket.io rooms are per-process
memory and the whole feature silently breaks the moment you run a second
instance."

Four changes. Ordered this way because each one depends on the one before it:

| # | Change | Why it had to come in this order |
|---|--------|----------------------------------|
| 0 | `Message` collection + migration | Everything else reads or writes messages; the storage shape has to settle first |
| 1 | Cursor-paginated history + no side effects on read | Now possible, because a page of history is an index range scan instead of an array slice |
| 2 | Socket authentication + authorization | The write path is being rewritten anyway — this is the moment to stop trusting the client for identity |
| 3 | Socket.io Redis adapter | The multi-instance answer, and it only makes sense once the room identity is the `Chat` row |

Two bugs surfaced while doing it that were not in the plan: a **check-then-act
race that could split one conversation into many `Chat` documents**, and the
fact that the **chat route created data on a GET**. Both are covered below.

---

## Item 0 — Messages out of the embedded array (Problem → Investigation → Options → Decision → Outcome)

### Problem

`src/models/chat.js` was:

```js
const chatSchema = new mongoose.Schema({
  participants: [{ type: ObjectId, ref: "User", required: true }],
  messages: [messageSchema],          // <- every message, forever, in one document
});
```

and the write path in `src/utils/socket.js` was:

```js
let chat = await Chat.findOne({ participants: { $all: [userId, targetUserId] } });
if (!chat) chat = new Chat({ participants: [userId, targetUserId], messages: [] });
chat.messages.push({ senderId: userId, text });
await chat.save();
```

Three distinct failures live in those five lines, and they get progressively
harder to notice:

1. **A hard 16MB ceiling.** MongoDB refuses to store a document larger than
   16MB. A conversation that reaches it doesn't degrade — it *stops accepting
   messages*, permanently, for that pair, and there is no fix that isn't the
   schema change in this phase.
2. **O(N) cost per message.** `push` + `save` sends the whole array back to the
   server. Appending message 10,000 means writing 10,000 messages. The document
   is rewritten in place, re-replicated to secondaries and written to the oplog
   in full, every time. The conversation gets more expensive to talk in the more
   you talk in it — the exact opposite of what you want.
3. **Reads can't be paginated.** `GET /chat/:targetUserId` returned the entire
   conversation with every sender populated. The server loads the whole document
   off disk regardless, and the client renders one screenful of it.

### Investigation

The cap is the claim that sounds like trivia, so it was worth reproducing rather
than asserting. Building V1-shaped documents of increasing size:

| Embedded messages (16KB each) | Document size | Result |
|---|---|---|
| 1,000 | ~15.63 MiB | **accepted** |
| 1,050 | ~16.41 MiB | **rejected** — `BSONObjectTooLarge`, code `10334` |

```
BSONObj size: 17286294 (0x107C496) is invalid.
Size must be between 0 and 16793600(16MB)
```

The same 1,050 messages written as 1,050 separate documents insert in 159ms with
no cap involved at all.

Worth knowing for the follow-up question: at a realistic ~200 bytes per message
the ceiling is roughly **80,000 messages in one conversation**. That is not an
absurd number for a pair of heavy users over a couple of years — it's reachable,
which is what makes it a real bug rather than a theoretical limit.

### Options considered

1. **Leave it; cap conversations at N messages.** Cheapest, and wrong: the
   product decision ("your history is now truncated") is being driven by a
   storage limitation nobody chose.
2. **Bucketing** — an array of messages per document, a new bucket document
   every ~500 messages. This is a legitimate, well-known MongoDB pattern, and it
   keeps the number of documents down. But it makes every read and write
   bucket-aware (which bucket is current? what happens to a page that straddles
   two?), and the wins it offers are for workloads that read a whole bucket at a
   time. Chat reads the newest 50 and then scrolls.
3. **One document per message.** More documents, an extra lookup for sender
   names, and a real migration to write. Appends become O(1), a page of history
   becomes an index range scan, and no cap exists at any conversation length.

### Decision — option 3

The workload is append-heavy and read-recent, which is precisely what a flat,
indexed collection is built for. Bucketing (option 2) is the right answer when
you routinely read a whole bucket at once and want to trade read granularity for
document count — a time-series or an analytics rollup. Chat doesn't do that, so
we'd have paid the complexity and not collected the benefit.

**The index is `{chatId: 1, _id: -1}`, not `{chatId: 1, createdAt: 1}`** — a
deliberate deviation from what the plan called for, and the reason matters:

`createdAt` is a millisecond timestamp, so it is **not unique**. Two messages
saved in the same millisecond tie. A cursor built on a non-unique sort key
cannot be exact: `createdAt < cursor` skips every message sharing the boundary
timestamp, and `<=` re-sends them. Under a fast back-and-forth — or any bulk
insert, like the migration itself — that is a **silently dropped or duplicated
message**, which is about the worst possible bug for a chat product, because
nothing surfaces it to the user except a conversation that doesn't quite make
sense.

`_id` has no ties. It is a **total, stable, unique** order, which is the property
a cursor actually requires, and its leading four bytes are a unix timestamp so it
is also chronological — **to second granularity**. Within the same second, the
remaining bytes (a per-process random value plus a counter) decide the order:
monotonic within one process, arbitrary across processes.

That is worth stating precisely rather than glossing, because it showed up in the
verification data. Two messages written by two different app instances in the same
second, 70ms apart, sort by `_id` in the *opposite* order to their `createdAt`.

It is still not an argument for `createdAt`, and the reason is the interesting
part: across instances, sub-second ordering is a function of clock skew, so a
"true" millisecond ordering between two processes isn't something either field
can give you. The difference is that `_id`'s ordering is **exact and stable** —
no message can be skipped or repeated at a page boundary — while `createdAt`'s is
neither.

So: **page by `_id`, display `createdAt`.** Correctness from the field that is
unique, precision from the field that is precise. It's also the same cursor
convention Phase 2 chose for the feed — one set of edge cases across the codebase
instead of two.

### The migration, and why it's a separate script

`src/scripts/migrateChatMessages.js` (`npm run migrate:chat`), following the
same shape as Phase 2's backfill: operator-run, not boot-time, because it is
one-shot, it touches user data, and it can partially fail in ways a human should
look at rather than a process that is also trying to serve traffic.

Two design points are load-bearing:

**It reuses each embedded message's existing `_id` as the new document's `_id`.**
Mongoose gives every subdocument an `_id` already. Reusing it makes the script
*idempotent by construction* — a second insert of the same message collides with
its own primary key and is skipped, so an interrupted run can simply be re-run.
It also means any message id a client already holds stays valid across the
migration.

**It copies before it deletes.** Messages are inserted and confirmed, and only
then is the embedded array `$unset`. An interruption anywhere leaves *duplicated*
data (harmless, and the re-run skips it) rather than deleted data.

One subtlety: the script reads through the **raw driver collection**, not the
`Chat` model. The model's schema no longer declares `messages`, so Mongoose would
strip the field out of every result and the script would see each chat as already
empty — quietly migrating nothing and reporting success. That is also why the
legacy array is *not* kept on the schema as a deprecated field: Mongoose would
keep hydrating it, and any code path that called `.save()` on a `Chat` would
write an empty array over data the migration hadn't moved yet.

### Outcome

`Chat` is now conversation metadata only — `participants`, the canonical pair,
and `lastMessageAt`. Messages are their own collection. Appending is one small
document insert plus one index entry, at any conversation length.

---

## Item 1 — Cursor-paginated history, and a read that stopped writing

### The pagination change

`GET /chat/:targetUserId?before=<messageId>&limit=50`.

The feed in Phase 2 pages *forward* (`_id > cursor`); chat is the mirror image —
a client opens at the newest message and scrolls up into the past — so it's
`_id < before` sorted descending. Both are an index range scan that positions
directly at the cursor.

Measured against a 100,120-message collection, with the conversation under test
holding 20,120 of them (20.1%) and **interleaved** through `_id` order, the way
concurrent conversations actually arrive:

| Page depth | Cursor `keysExamined` | Skip `keysExamined` | Cursor ms | Skip ms |
|---|---|---|---|---|
| 0 | 50 | 50 | 0 | 0 |
| 5,000 | 50 | 5,050 | 0 | 5 |
| 10,000 | 50 | 10,050 | 0 | 10 |
| 15,000 | 50 | 15,050 | 0 | 14 |
| 20,000 | 50 | 20,050 | 3 | 18 |

Skip's cost grows linearly with depth because `.skip(n)` does not jump — Mongo
walks and discards n index entries first, every time. The cursor is flat. That
matters most for exactly the users you least want to annoy: the ones with the
longest histories, scrolling back through them.

The compound index is doing real work here, which is easy to assert and worth
actually checking. Forcing the same cursor query onto the plain `_id` index:

| Index | keysExamined | docsExamined | nReturned |
|---|---|---|---|
| `chatId_1__id_-1` | 50 | 50 | 50 |
| `_id_` (forced) | 250 | 250 | 50 |

**5x** — which is exactly `1 / 0.201`, the share of the collection this
conversation owns. Walking `_id` alone means reading every other conversation's
messages and discarding them, so the penalty scales with how many *other*
conversations exist. At 100 active conversations instead of 9 it's not 5x, it's
~100x.

### The read that wrote

The old route did this:

```js
let chat = await Chat.findOne({ participants: { $all: [userId, targetUserId] } });
if (!chat) {
  chat = new Chat({ participants: [userId, targetUserId], messages: [] });
  await chat.save();          // <- a write. On a GET.
}
```

A `GET` that creates data is wrong on its own terms — not idempotent, not
cacheable, and it fails outright against a read-only replica, which is precisely
where you'd want to send history reads as this grows. Concretely it also meant
that merely *opening* someone's chat page left a `Chat` row behind for a
conversation that never happened.

The conversation is now created when someone actually opens it over a socket, on
a deliberate `joinChat`. A pair who has never spoken gets
`{ chatId: null, data: [], nextCursor: null, hasMore: false }` and no row is
written. Verified: `chats` count unchanged across the request.

---

## Item 2 — The `Chat` check-then-act race (not in the plan)

### Problem

Both the old GET route and the old `sendMessage` handler did the same thing:
`findOne` the chat for a pair, and create one if none came back. That is
check-then-act, the same shape Phase 2 found in `POST /request/send` — except
here **the concurrent case is the normal case**. When two users match, both open
the conversation at the same moment. Both miss, both insert.

The consequence is nastier than a duplicate swipe. Messages land in whichever
`Chat` document that particular request happened to find, so the conversation
**silently splits in two** and each user sees a different half of it.

### Investigation

20 concurrent opens of a single pair, half as `(A,B)` and half as `(B,A)`, against
the old code shape:

```
distinct chatIds returned: 17
Chat documents created   : 17   <-- one conversation split 17 ways
```

### Why `participants` can't just be uniquely indexed

The obvious fix is a unique index on `participants`. It doesn't work, and the
reason is a good thing to be able to explain: `participants` is an **array**, so
a unique index on it is a **multikey** index, and multikey uniqueness constrains
each individual *member* to appear in one document only. It would allow user A
exactly one conversation in total, with anyone. Not a subtle failure — but only
if you know how multikey indexes behave.

### Decision

The same canonicalised-pair trick Phase 2 introduced: two scalar fields,
`participantLow` / `participantHigh`, holding the two ids sorted, with a unique
partial index on the pair — so `(A,B)` and `(B,A)` produce one identical key that
the index can reject.

Paired with an atomic `findOneAndUpdate(..., {upsert: true})` rather than
find-then-create, so the match and the insert are a single server-side operation.
The `E11000` catch after it is **not** redundant: Mongo's upsert can still race
with itself — two upserts that both miss the index can both attempt the insert,
and the loser gets a duplicate-key error rather than the winner's document. The
documented remedy is to retry the read, which is guaranteed to find the winner's
row, so the loser converges on the same conversation instead of surfacing a 500
to a user who did nothing wrong.

The index is `partialFilterExpression: {$exists: true}` on both fields, for the
same rollout reason as Phase 2: pre-existing documents have neither field, and a
plain unique index would read them all as `(null, null)`, collide them against
each other, and fail to build at all.

### Outcome

Same 20-way concurrent test, after the fix:

```
calls succeeded          : 20/20
calls threw              : 0
distinct chatIds returned: 1   (must be 1)
Chat documents in DB     : 1   (must be 1)
```

---

## Item 3 — Socket authentication and authorization

### The impersonation hole

V1's handler signature was the whole bug:

```js
socket.on("sendMessage", async ({ firstName, lastName, userId, targetUserId, text }) => {
```

**The client says who it is.** Any connected browser could send a message as any
user by editing one field — no credentials involved — and the message persists to
the database attributed to the victim. The HTTP side never had this problem,
because `userAuth` derives identity from a signed JWT. The socket side simply
never got the same treatment.

The fix is `io.use(authenticateSocket)`: the socket equivalent of that
middleware. It runs once per connection, before any event handler can fire, and
reads the *same* `token` cookie with the *same* secret as `src/middlewares/auth.js`
— one identity mechanism for the app, not a second one invented for sockets. A
`next(err)` rejects the connection outright. From there, `socket.user` is the only
source of the sender's identity and `userId` in a payload is ignored entirely.

Per-connection rather than per-event is the right granularity: a socket's
identity cannot change mid-connection, so verifying the token 500 times for 500
messages buys nothing. The cost is that a token expiring mid-session stays usable
until the socket drops — bounded, and the trade-off every WebSocket app makes.

### The authorization TODO

`src/utils/socket.js` carried `// TODO: Check if userId & targetUserId are friends`
(ISSUES.md, Security #5). Both socket events and the HTTP route now require an
`accepted` `ConnectionRequest` between the pair, through one shared helper,
`src/utils/connectionGuard.js`. Shared deliberately: an authorization rule
enforced in two places drifts, one of the two gets a fix the other doesn't, and
the weaker path becomes the way in.

**This is checked on every message send, not cached from `joinChat`** — and it is
affordable precisely because of Phase 2. That phase added a unique index on
`{userIdLow, userIdHigh}` to stop duplicate swipes; it happens to be exactly the
index an authorization check on a pair needs. Querying it is a single point
lookup against a unique index — one key, at most one document — next to a
document insert we're doing anyway.

Without that index the query would have been an `$or` over `{fromUserId,
toUserId}` in both directions, and "verify on every message" would have been
expensive enough to push toward caching the decision on the socket. That cache is
where the bug lives: a user who gets disconnected from you keeps writing into the
conversation for as long as their tab stays open. Phase 2's index is what let us
take the correct option instead of the cheap one.

### Also hardened

- Message text is validated and bounded at 2,000 characters. V1 had no
  per-message limit, which made the 16MB document cap reachable by one determined
  sender rather than only by a genuinely long conversation.
- Handlers take `(payload = {})`. Without the default, an event emitted with no
  payload throws on destructuring — and an exception thrown synchronously out of a
  socket handler is *not* caught by the try/catch inside it.
- `targetUserId` is shape-validated before it reaches Mongo, so a malformed id
  returns "Invalid user id" instead of a CastError surfacing as a generic failure.
- Failures now emit `chatError` back to the sender. V1 swallowed them in a bare
  `console.log`, so a failed send looked identical to a successful one from the
  client's side — the message just never appeared.

---

## Item 4 — Socket.io Redis adapter (multi-instance delivery)

### Problem

Socket.io rooms are, by default, a `Map` in the process's memory. With one Node
process that is invisible. With two it breaks, in the way that is hardest to
catch: `io.to(room).emit(...)` on instance A reaches only the sockets A itself
holds. If the two participants' browsers connected to different instances, each
sees their own messages and none of the other's — and **no error is raised
anywhere**. The message is persisted correctly. Only delivery is lost.

It works perfectly in development on one process, and starts dropping messages
the moment you add a second pod behind a load balancer.

### Reproduced, both ways

Two real instances of the app on `:7801` and `:7802`, one user connected to each,
same conversation:

**Adapter disabled:**
```
same-instance  (:7801 -> :7801): ✅ delivered ("cross-instance probe")
cross-instance (:7801 -> :7802): ❌ NOT delivered (timed out after 5s)
```

**Adapter enabled** (identical test):
```
same-instance  (:7801 -> :7801): ✅ delivered ("cross-instance probe")
cross-instance (:7801 -> :7802): ✅ delivered ("cross-instance probe")
```

### The implementation detail worth knowing

The adapter needs **two separate Redis connections**, not the shared client from
`src/config/redis.js`. A Redis connection in subscriber mode may only issue
`(P)SUBSCRIBE`/`UNSUBSCRIBE` — so a client used for `SUBSCRIBE` cannot also serve
the rate limiter's `INCR` or BullMQ's commands. `redisClient.duplicate()` gives
new connections that inherit the same URL and options, so there is still exactly
one place configuring how we reach Redis.

Both duplicated clients get explicit `error` listeners. Without them an ioredis
connection error surfaces as an unhandled `'error'` event and takes the process
down — the adapter being unavailable would become *the API* being unavailable.

### Failure mode, stated honestly

If Redis goes down, the adapter keeps delivering to sockets on the local instance
and silently stops delivering across instances. That is **fail-open**, and it's
the right default for chat — a degraded conversation beats a dead one — but it is
a *silent* degradation. The error logs are the only signal, and in production this
is what you alert on.

Note this is the third distinct call on the same question in this project, and
they don't all go the same way: Phase 1's payment webhook fails **closed** (a lost
enqueue is money taken and not recorded), Phase 2's rate limiter fails **open** (a
cache outage must not take the core feature offline), and this fails open for the
same reason. Same infrastructure, decided each time by what the path actually
protects.

### Room naming

V1 derived the room as `sha256(sorted([userId, targetUserId]))` — a way to get a
name both sides agree on without a database lookup. That's gone: the `Chat`
document is now the pair's canonical identity, and we load it anyway to write the
message, so the room is `chat:<chatId>`. One notion of "which conversation is
this" instead of two — and when you're debugging delivery across instances, a
readable room name is worth a great deal and an opaque hash tells you nothing.

---

## Verification

All verified **live** against running Redis + Mongo, using the real Express stack,
real login cookies, and the real Socket.io protocol. Two actual app instances were
run for the multi-instance tests.

### Item 0 — storage split & migration

- ✅ **16MB cap reproduced** — 1,000 × 16KB embedded messages (~15.63 MiB)
  accepted; 1,050 (~16.41 MiB) rejected with `BSONObjectTooLarge` code `10334`.
  Same content as separate documents: inserted, 159ms, no cap.
- ✅ **Migration dry-run** — reported 1 chat / 120 messages and wrote nothing
  (confirmed by re-reading the collection).
- ✅ **Migration real run** — 120 messages moved, `messages` array unset,
  `participantLow/High` set, `lastMessageAt` = newest message's timestamp
  (`2026-09-01T11:59:00.000Z`, the real value, not the run time).
- ✅ **Idempotent** — immediate re-run: "Nothing to do."
- ✅ **Interrupted-run recovery** — restored the embedded array while the
  `Message` documents already existed (simulating a crash before `$unset`), then
  re-ran: **0 inserted, 120 skipped**, no duplicates, cleanly finished.
- ✅ **Indexes actually built** —
  `messages`: `chatId_1__id_-1`.
  `chats`: `participantLow_1_participantHigh_1` (unique, partial) and
  `participants_1_lastMessageAt_-1`.

### Item 1 — read path

- ✅ **Cursor vs skip at depth** — see the table above; cursor flat at 50
  `keysExamined`, skip linear to 20,050.
- ✅ **Compound index is load-bearing** — same query forced onto `_id_` examines
  250 keys instead of 50 (5x, matching the conversation's 20.1% share).
- ✅ **40 pages walked over HTTP** — 2,000 messages, **0 duplicates**, page
  boundaries exactly contiguous, latency flat (49ms on page 1, 30ms on page 40).
- ✅ **Authorization** — `GET /chat/<connection>` 200; `GET /chat/<non-connection>`
  **403**; no cookie **401**.
- ✅ **Validation** — malformed user id and malformed cursor both **400** with a
  clear message.
- ✅ **No side effects on read** — connected pair that has never spoken returns an
  empty page; `chats` document count unchanged.

### Item 2 — concurrency

- ✅ **"Before" evidence** — 20 concurrent opens, old code shape: **17 `Chat`
  documents** for one pair.
- ✅ **After** — same test: 20/20 calls succeeded, 0 threw, **1 distinct chatId,
  1 document**.
- ✅ **Mixed direction** — half the calls as `(A,B)`, half as `(B,A)`; all
  converged on the same conversation.

### Item 3 — socket auth & authz

- ✅ **No cookie** → handshake rejected (`UNAUTHORIZED: no cookie sent`).
- ✅ **Forged token** → handshake rejected (`UNAUTHORIZED`).
- ✅ **Valid cookie** → connected.
- ✅ **`joinChat` with a non-connection** → denied.
- ✅ **`joinChat` with an accepted connection** → `chatJoined` with a chatId.
- ✅ **Impersonation attempt** — Elon's authenticated socket sent
  `{userId: <Modi's id>, firstName: "Narendra", ...}`. The persisted and broadcast
  message carried **Elon's** id and **Elon's** name. The payload's claim was
  ignored entirely.
- ✅ **Writing into a non-connection's conversation** → denied.
- ✅ **Validation** — empty message, whitespace-only message, 2,500-character
  message, and an entirely empty payload all rejected with a specific `chatError`.
- ✅ **Payload shape** — broadcasts now carry `_id` and `createdAt`, so clients can
  de-duplicate and use the newest `_id` as a cursor.

### Item 4 — multi-instance

- ✅ **Without the adapter** — cross-instance delivery fails silently (5s timeout),
  same-instance works. The exact production failure mode.
- ✅ **With the adapter** — both directions deliver (`:7801 → :7802` and
  `:7802 → :7801`).
- ✅ **Both instances resolved the same `chatId`** for the pair — the canonical
  pair index doing its job across processes.
- ✅ **Redis pub/sub confirmed live** — `socket.io-request#/#` and
  `socket.io-response#/#` channels present, 1 pattern subscription.
- ✅ **`lastMessageAt` maintained** — matches the newest message after live socket
  traffic.

### End-to-end through the real React app

Not just the API — the actual client, in a browser, against the running backend:

- ✅ **Logged in** through the app's own login form; the socket authenticated off
  that same cookie with no extra steps.
- ✅ **History rendered** from the paginated endpoint, correctly attributed
  (own messages right-aligned, the other user's left-aligned).
- ✅ **Migrated messages show their ORIGINAL timestamps** (01/09/2026 17:2x), not
  the migration's run time — the visible proof that the migration preserved
  history rather than collapsing it into one moment.
- ✅ **Sent a message from the UI** — persisted, attributed to the authenticated
  user, and rendered live over the socket.
- ✅ **"Load older messages"** walked the 120-message conversation in three cursor
  pages (120→71, 70→21, 20→1); the button disappeared exactly when the history
  was exhausted (`hasMore: false`), and message #1 was at the top.
- ✅ **Scroll behaviour** — opens pinned to the newest message; loading older
  messages prepends them *without* yanking the viewport back down.

### Cleanup

The 100,000 synthetic messages used for the query-plan measurements were deleted
afterwards; the 120 genuinely-migrated messages and the messages written by the
live socket tests remain. `lastMessageAt` was recomputed from what actually
remains — which is itself a demonstration that the field is derived and
repairable at any time.

---

## Files added / changed

### Backend (`devTinder`)

| File | Change |
|------|--------|
| `src/models/message.js` | **new** — one document per message; `{chatId, _id: -1}` index; 2,000-char bound; the `_id`-vs-`createdAt` cursor reasoning |
| `src/models/chat.js` | **rewritten** — embedded `messages` array removed; `+` `participantLow`/`participantHigh` + unique partial index; `+` `lastMessageAt` + `{participants, lastMessageAt}` index; `+` atomic `findOrCreateForPair` static |
| `src/routes/chat.js` | **rewritten** — cursor pagination (`before`/`limit`, `nextCursor`/`hasMore`); `+` authorization; **removed** the write-on-GET; `+` id/cursor validation; catch block now responds instead of hanging |
| `src/utils/socket.js` | **rewritten** — `+` JWT-cookie handshake auth (`io.use`); `+` authorization on both events; `+` Redis adapter on duplicated pub/sub clients; message insert replaces array push; `+` `lastMessageAt` maintenance; `+` input validation and `chatError` responses; sha256 room id → `chat:<chatId>` |
| `src/utils/connectionGuard.js` | **new** — shared `areConnected`, one point lookup against the Phase 2 canonical-pair index |
| `src/scripts/migrateChatMessages.js` | **new** — idempotent (`_id`-reusing) embedded→collection migration, `--dry-run`, copies before deleting, reports failures without deleting data |
| `src/app.js` | socket wiring re-enabled (it had been commented out for local dev) |
| `package.json` | `+` `cookie` dependency (was only a transitive dep of express); `+` `migrate:chat` script |
| `ISSUES.md` | Security #5, Correctness #5, Scaling #3 annotated as fixed; **new** Correctness #9 (duplicate `Chat` documents) |
| `postman/devTinder.postman_collection.json` | Chat folder rewritten: first page, cursor page, and the 403 case; `+` `messageCursor` / `unconnectedUserId` variables |
| `docs/phase-3.md` | **new** — this write-up |
| `docs/phase-3-answers.md` | **new** — spoken interview answers |

### Frontend (`devTinder-web`, separate repo)

Required, not optional: the backend now authenticates sockets from a cookie, so
without `withCredentials` every handshake from the browser would be rejected.

| File | Change |
|------|--------|
| `src/utils/socket.js` | `+` `withCredentials: true` so the browser attaches the auth cookie to the handshake |
| `src/components/Chat.jsx` | updated to the `{chatId, data, nextCursor, hasMore}` response shape; `+` "Load older messages" cursor paging; **one** socket per page via a ref (it previously opened a new connection on *every* send); `+` de-duplication on server-assigned `_id`; `+` `chatError`/`connect_error` surfacing; stops sending `userId`/`firstName` (the server ignores them now); real timestamps instead of a hardcoded "2 hours ago"; `+` scroll-to-newest that deliberately does *not* fire when prepending older pages |

## Bugs found and fixed along the way

- **Duplicate `Chat` documents under concurrency** — check-then-act in two
  places, where the concurrent case is the *normal* one (both users open the
  conversation when they match). 20 concurrent opens produced 17 documents.
- **`GET /chat/:targetUserId` created data** — a `.save()` on a read path, so
  opening a chat page wrote a row for a conversation that never happened.
- **The chat route hung on error** — the catch block only called `console.error`,
  so the request never got a response and the client waited for its own timeout.
  Reads as "the app is slow", not "the app errored" (ISSUES.md, Correctness #5).
- **The frontend opened a new socket per message sent** — `createSocketConnection()`
  was called inside `sendMessage`, so every message opened a fresh connection that
  had never joined the room. Harmless-looking before; after this phase it also
  means a JWT verify and a user lookup per message.
- **No per-message length limit** — one sender could push a single conversation
  toward the 16MB cap on purpose.

---

## Anticipated interviewer follow-up questions

**Q: Why not bucketing? That's the canonical MongoDB pattern for this.**
It is, and it's the right answer for a workload that reads a whole bucket at a
time — time-series, analytics rollups. Chat reads the newest 50 and then scrolls
backwards. Bucketing would have made every read and write bucket-aware (which
bucket is current, what happens to a page straddling two) to buy a lower document
count we weren't being hurt by. We'd have paid the complexity and not collected
the benefit.

**Q: You're doing an extra lookup for sender names now. Isn't that worse?**
For a page of 50 it's one `populate` — an `$in` over 50 ids, usually 2 distinct
users in a one-to-one chat. If it ever mattered we'd denormalise the sender's
display name onto the message, which is standard for chat because a name at send
time is arguably the *correct* value to display historically anyway. We didn't,
because we have no evidence it's a problem and denormalising has its own
consistency cost.

**Q: Why `_id` as the cursor instead of `createdAt`?**
`createdAt` is millisecond-precision and therefore not unique. Two messages in the
same millisecond tie, and a cursor on a non-unique key can't be exact — `<` drops
messages at the boundary, `<=` duplicates them. Silent message loss in a chat app
is unacceptable and nearly impossible for a user to report coherently. `_id` is
unique *and* time-ordered (its first four bytes are a unix timestamp), so it gives
exactness and chronology together.

**Q: What happens when two messages arrive in the same millisecond?**
For pagination, nothing — they get different `_id`s, they sort deterministically,
and the cursor walks them one at a time with no ambiguity. That's the reason for
choosing `_id`.

I'd be precise about what it does *not* give you, though. An ObjectId's timestamp
is second-granularity, so within one second the order comes from a per-process
counter — monotonic inside a process, arbitrary across processes. I have a real
instance of that in my verification data: two messages 70ms apart, written by two
different instances in the same second, sort by `_id` opposite to their
`createdAt`. But `createdAt` wouldn't have saved me either, because ordering
events across two machines to the millisecond is a clock-skew problem, not an
index problem. If I genuinely needed a total causal order across instances I'd
need a logical clock — a sequence per conversation, or something Lamport-ish. For
rendering a chat, second-granularity ordering with an exact, stable cursor is the
right trade.

**Q: Your cursor is `_id`-based — what if a client sends a cursor from a
different conversation?**
The query is `{chatId, _id: {$lt: cursor}}`. `chatId` comes from the
authorization-checked lookup, not from the client, so a foreign cursor can only
ever shift *where in this conversation* the page starts — it can't read another
conversation. Worst case the user gets an odd page; there's no data exposure.

**Q: Why check authorization on every message rather than just on join?**
Because caching it on the socket means someone who gets disconnected from you
keeps writing into the conversation until their tab closes. It's affordable
because Phase 2's unique index on the canonical pair makes the check a single
point lookup, next to an insert we're doing anyway. If that index didn't exist,
the query would have been an `$or` in both directions and we'd have been pushed
toward caching — which is where the bug would have been.

**Q: The Redis adapter is a single point of failure now, isn't it?**
It's a shared dependency, and it fails open: if Redis goes down, delivery still
works within each instance and stops working across them. So it degrades rather
than dies. It *is* a silent degradation, which is the real risk, so the error
logs from the pub/sub clients are what you alert on. If we needed to remove the
dependency, the next step would be sticky sessions at the load balancer so both
participants land on the same instance — cheaper, but it makes rebalancing and
deploys disruptive, and it doesn't help group chat.

**Q: How would you scale this further?**
Three things, in order of what the data would tell us. First, the `Message`
collection is the fastest-growing thing in the system — it's a natural shard key
candidate on `chatId`, which keeps a conversation on one shard and makes the
history query a single-shard operation. Second, messages are read almost
exclusively when recent, so old ones are archival: a TTL or a tiered move to
cheaper storage. Third, the conversation list would use the
`{participants, lastMessageAt}` index we already declared, and if that got hot
it's a natural Redis cache — the same fan-out-on-write shape as the Phase 2 feed
cache.

**Q: You changed the API response shape. How would you have shipped that without
breaking clients?**
Here I changed the client in the same change, because it's one app and one team.
In a real deployment with clients we don't control, this is a versioned endpoint
or an additive response — keep returning `messages` while adding `data` +
`nextCursor`, ship the client, then remove the old field once telemetry shows
nobody reads it. The storage migration underneath is independent of that and
already safe to run ahead of time, because it copies before it deletes.

**Q: What was the hardest part?**
The two invisible ones. The multi-instance socket bug produces no error at all —
messages persist correctly, delivery just silently doesn't happen, and it is
impossible to see on one process, which is exactly how development runs. And the
`Chat` race needs two simultaneous opens to reproduce, so sequential manual
testing shows one conversation and looks completely correct. Both needed to be
reproduced deliberately — two real instances for one, a 20-way concurrent burst
for the other — rather than found by using the app.

---

## Next: Phase 4

Posts with images: a `Post` model plus likes as their own collection (the same
embedded-array growth problem, now fixed twice — don't reintroduce it),
pre-signed S3/MinIO upload URLs so the backend never proxies image bytes, and a
cursor-paginated posts feed scoped to accepted connections.
