# Phase 3 — Spoken interview answers

> The *say-out-loud* versions, in Problem → Action → Outcome shape so they stay
> recallable under pressure. Say them in your own words — don't recite.
>
> **Deliberately light on numbers.** The interviewer is checking whether you can
> name the pattern, say why you chose it over the alternative, and say what it
> bought you. Talk in **directions and shapes** ("the cost used to grow with the
> length of the conversation, now it's flat") rather than figures. The measured
> numbers, query plans and the reproduced `BSONObjectTooLarge` are in
> [phase-3.md](phase-3.md) — and "I can show you the `.explain` output" is a
> stronger answer than a recalled statistic.

**The patterns this phase gives you, by name** — these are the words to actually
say out loud, because they're what's being tested:

| Pattern | Where |
|---|---|
| Unbounded embedded array → separate collection (the V1→V2 evolution) | Item 0 |
| Document size limits as a hard architectural constraint | Item 0 |
| Bucketing (named and *rejected*, with a reason) | Item 0 |
| Unique, monotonic sort key for exact keyset pagination | Item 0 |
| Keyset (cursor) pagination vs offset, backwards this time | Item 1 |
| Side-effect-free reads / idempotent GET | Item 1 |
| Check-then-act race → atomic upsert + unique constraint | Item 2 |
| Canonicalisation; why multikey unique indexes don't do what you want | Item 2 |
| Never trust the client for identity; authenticate at the edge | Item 3 |
| One shared authorization helper (don't let two paths drift) | Item 3 |
| Shared-nothing instances → external pub/sub for fan-out | Item 4 |
| Fail-open vs fail-closed, decided per path | Item 4 |
| Expand-and-contract migration; idempotent by construction | Item 0 |

---

## Q1 (primary) — "What's a challenge you faced and why was it hard?"

**This is the strongest answer in the whole project.** Lead with *why it was
invisible*, not with the fix. There are two invisible bugs here; the
multi-instance one is the better story.

**Problem.** "Our chat worked perfectly. Then I asked what happens when we run a
second instance of the API, and realised the whole feature quietly breaks.

Socket.io keeps its rooms in the process's memory. When you emit to a room,
you're emitting to the sockets *that process* is holding. So if two people in the
same conversation happen to connect to different instances — which is just what a
load balancer does — each one sees their own messages and none of the other's.

What makes it hard is that **nothing fails.** There's no error, no exception, no
failed request. The message is written to the database perfectly correctly. Only
the delivery silently doesn't happen. And it is *impossible* to see in
development, because development is one process — so it works flawlessly right up
until the day you scale out, which is usually the day you're already under load
and least want to be debugging your chat layer.

There was a second invisible bug in the same area. Opening a conversation did a
`findOne` for the chat and created one if it didn't exist — check-then-act. And
here the concurrent case is the *normal* case: when two people match, they both
open the conversation at the same moment. Both miss, both insert, and now the
conversation is split across two documents — each person is talking into a
different one and seeing half the history."

**Action.** "For the delivery bug I added the Socket.io Redis adapter, which
replaces that in-memory room map with Redis pub/sub, so a room spans every
instance. But the thing I'd actually call the work is that I *reproduced* both
first. I ran two real instances of the app on different ports, put one user on
each, and showed the message not arriving — and then showed the same test passing
with the adapter in. For the race, a twenty-way concurrent open of one
conversation, which produced seventeen chat documents.

For the race the fix was to make the database the authority rather than
application code: store the two participant ids in a canonical sorted order so
both directions produce one key, put a unique index on it, and use an atomic
upsert instead of find-then-create."

**Outcome.** "Cross-instance delivery works, verified both directions between two
running instances. And the same twenty-way concurrent test now produces exactly
one conversation with every caller agreeing on it.

The lesson I took is that the bugs worth hunting are the ones that don't raise
anything. Neither of these produces an error, a log line, or a failed request —
they just quietly do the wrong thing. So I went looking for them by asking 'what
does this assume?' rather than by using the app."

---

## Q2 (primary) — "Tell me about a performance problem you found and fixed."

**Problem.** "Our chat stored every message of a conversation in one array on one
document. Two things are wrong with that, and the second is worse than the first.

The obvious one is that MongoDB has a hard 16MB document limit. So a conversation
has a ceiling — and when you hit it, it doesn't get slow, it *stops working*.
Sending fails permanently for that pair, and there's no fix that isn't a schema
change and a data migration.

The one that bites earlier is that appending to an embedded array rewrites the
whole array. Adding message ten thousand means writing ten thousand messages —
the whole document gets rewritten, re-replicated to secondaries, and written to
the oplog in full. So the conversation gets more expensive to talk in the more
you talk in it, which is exactly backwards."

**Action.** "I moved messages into their own collection, one document per
message, indexed by conversation. And I checked the cap rather than asserting it
— I built documents of increasing size and found the exact point MongoDB rejects
them, so I could say 'at a realistic message size that's on the order of eighty
thousand messages in one conversation', which is a number a pair of heavy users
can actually reach.

I also rewrote the read side. It used to return the entire conversation; now it's
cursor-paginated — you get the newest fifty and page backwards with a cursor."

**Outcome.** "Appending is now one small insert regardless of conversation
length, and there's no ceiling at all. On the read side, the cost of a page used
to grow with how far back you scrolled — offset pagination makes the database
walk and discard everything you skipped. Now every page costs the same as the
first, which matters most for the users with the longest histories, who are the
ones you least want to make wait.

If you want the other useful detail: I checked that the compound index was
actually earning its place by forcing the same query onto the plain `_id` index
and comparing. It examines five times the keys — and that multiple is the
*inverse of how much of the collection that one conversation owns*, so it gets
worse the more conversations exist. That's the kind of thing that looks fine in
a test database with one conversation in it."

---

## Q3 — "Walk me through a design decision you made."

Two good options. **A** is the better answer if they want depth on data
modelling; **B** if the conversation is about security.

### Option A — embedded array vs separate collection vs bucketing

**Problem.** "Chat messages were an embedded array, which has a hard size cap and
an O(N) append. I had three real options."

**Action.** "Option one: leave it and cap conversations at some number of
messages. That's cheapest, and it's wrong — you'd be letting a storage limitation
make a product decision nobody chose.

Option two: bucketing. You keep an array, but you start a new document every few
hundred messages. It's the canonical MongoDB pattern for exactly this problem and
it keeps your document count down.

Option three: one document per message. More documents, an extra lookup to get
sender names, and a real migration to write.

I went with option three, and the reason I rejected bucketing is the part I'd
want to be judged on. Bucketing is the right answer when you routinely read a
*whole bucket at a time* — time-series data, analytics rollups — because you're
trading read granularity for fewer documents. Chat doesn't do that. Chat reads
the newest fifty messages and then scrolls backwards. So bucketing would have
made every read and write bucket-aware — which bucket is current, what happens to
a page that straddles two — to buy me a lower document count I wasn't being hurt
by. I'd have paid the complexity and not collected the benefit."

**Outcome.** "Appends are O(1) at any length, history is an index range scan, and
there's no cap. And I can say precisely *when* I'd switch to bucketing, which I
think is the actual point of the question."

**The detail that lands well if they push:** "There's a smaller decision inside
that one I'd defend just as hard. The obvious index and cursor for chat history
is `createdAt` — it's the timestamp, it's what you sort by. I used the document
`_id` instead, because `createdAt` is millisecond precision and therefore *not
unique*. Two messages in the same millisecond tie. And a cursor built on a
non-unique key can't be exact: 'less than the cursor' silently drops every message
sharing that boundary timestamp, and 'less than or equal' duplicates them. In a
chat app that's a silently lost message, which is about the worst bug you can
have, because the user can't even describe it. `_id` is unique, so the cursor is
exact — no message can be skipped or repeated at a page boundary — and it's also
time-ordered, because the first four bytes of an ObjectId are a timestamp.

The honest caveat, which I'd volunteer rather than wait to be caught on: that
timestamp is second-granularity, so within a single second the ordering comes
from a per-process counter and two instances can disagree. I actually hit that in
testing — two messages seventy milliseconds apart from different instances sorted
by `_id` opposite to their `createdAt`. But `createdAt` wouldn't have fixed it,
because ordering events across two machines to the millisecond is a clock-skew
problem, not an index problem. So I page by `_id` and display `createdAt` —
correctness from the field that's unique, precision from the field that's
precise."

### Option B — authenticating the socket layer

**Problem.** "The socket handlers took the sender's user id from the event
payload. So the client was telling the server who it was. Anyone could send a
message as anyone else by changing one field — no credentials involved — and it
would persist to the database attributed to the victim.

What I found interesting is *how* it happened. It wasn't carelessness. The HTTP
side was fine — it derives identity from a signed JWT in middleware. The socket
layer was just built separately and never got the same treatment. Which is the
general lesson: when you add a second entry point into your system, it doesn't
inherit the first one's security properties."

**Action.** "I moved authentication to the socket handshake, using the same JWT
cookie and the same secret as the REST middleware — deliberately the same
mechanism, not a second one invented for sockets. It runs once per connection
before any handler can fire, and rejects the connection outright if it fails.
After that, the authenticated session is the only source of the sender's
identity, and the client-supplied id is ignored entirely.

Then I added the authorization check that had been sitting in the code as a TODO
— you can only chat with someone you have an accepted connection with — and I
put it in one shared helper used by both the socket path and the HTTP path.
That's deliberate: an authorization rule enforced in two places drifts, one of
them gets a fix the other doesn't, and the weaker one becomes the way in."

**Outcome.** "I verified it by attacking it: I had one user's authenticated
socket send a message claiming to be a different user in the payload. The message
persisted under the *authenticated* user. The claim was ignored.

One design point I'd raise myself: I check authorization on *every* message, not
just when you join the conversation. Caching it on the connection would be
cheaper, but then someone who gets disconnected from you keeps writing into your
conversation until their tab closes. I could afford the correct version because
of an index I'd added in an earlier phase for a completely different reason — it
makes the check a single point lookup, right next to an insert I'm doing anyway."

---

## Q4 (primary) — "A trade-off between two options, and how it played out long-term."

**This is the phase's other headline answer**, because it's a *real* V1→V2
evolution that's visible in git history — not a hypothetical.

**Problem.** "The original chat design embedded all the messages in the
conversation document. I want to be fair to that decision, because it isn't
stupid: everything about one conversation lives together, so reading a
conversation is a single document fetch with no join, and writing is one
operation. For a chat that's short, it's genuinely the better design — it's the
'data that's accessed together should be stored together' instinct, which is the
right instinct in MongoDB."

**Action.** "The trade-off it makes is that it couples the cost of *every*
operation to the total size of the conversation. And that's fine until it isn't.
It became not-fine in two ways at once: appending started rewriting the entire
history on every message, and the whole thing runs into a hard 16MB document
ceiling that turns into a permanent failure rather than a slowdown.

So we split messages into their own collection. Now an append is O(1), a page of
history is an index range scan, and there's no ceiling. What we gave up is
exactly what the original design was buying: reading a conversation is no longer
a single document fetch, and we need a lookup to attach sender names."

**Outcome.** "The thing I'd want to say about how it played out: the original
trade-off was *correct for the scale it was made at* and became wrong later. That
transition is the normal life of a schema, not a mistake someone made.

What I'd do differently is not the choice — it's that there was nothing watching
for the transition. The failure mode of embedding is a cliff, not a slope: it
works fine, then hits a hard cap and stops. If I were making that call again I'd
still consider embedding, but I'd put a number on when it stops working and
monitor the distance to it, so the migration is something you schedule rather
than something you discover.

I also had to write the migration, which is where the real care went. It reuses
each embedded message's existing id as the new document's id — which makes the
whole script idempotent for free, because re-inserting the same message collides
with its own primary key and gets skipped. And it copies everything before it
deletes anything, so an interruption leaves duplicate data rather than missing
data. I tested that deliberately: I simulated a crash halfway through and re-ran
it, and it skipped every already-migrated message and finished cleanly."

---

## Q5 — "Have you dealt with load concentrated at a particular time?"

Phase 1 is the stronger answer here (the 8am cron spike). This phase's
contribution is the *shape* of chat load:

"Chat load is spiky in a different way from the rest of the app — it's bursty per
conversation rather than global. Two people going back and forth generate a tight
cluster of writes to the same conversation, and under the old embedded design
that was the worst possible case, because every one of those writes rewrote the
entire history and they were all contending on the same document. Splitting
messages out removes the contention entirely: concurrent messages in one
conversation are now independent inserts that don't touch each other."

---

## Q6 — "How would you scale this further?"

"Three things, roughly in the order the data would push me.

First, the message collection is now the fastest-growing thing in the system, and
it has an obvious shard key — the conversation id. That keeps a whole conversation
on one shard, so reading history stays a single-shard operation instead of a
scatter-gather.

Second, messages are read almost entirely when they're recent. Old messages are
archival. So there's a tiering story — a TTL, or moving old messages to cheaper
storage with a slower read path, since nobody expects instant access to a
three-year-old conversation.

Third, the conversation list. I already store a `lastMessageAt` on each
conversation and index it, so 'my conversations, most recent first' is one indexed
read. If that got hot it's a natural Redis cache, and it's the same
fan-out-on-write shape as the feed cache from the previous phase.

And on the socket side specifically — the Redis adapter gets you horizontal
scaling, but the next constraint is connection count per instance, because every
online user holds an open socket. That's when you'd separate the WebSocket tier
from the API tier so you can scale them independently, since they're bounded by
completely different things: one by connections, one by request throughput."

---

## Q7 — "Anything about failure modes / what happens when a dependency is down?"

**Good short answer that shows judgement rather than a rule:**

"We now depend on Redis in three places, and I deliberately did *not* make the
same call in all three.

The payment webhook fails **closed** — if we can't queue the work, we reject,
because a lost enqueue means we took someone's money and didn't record it.

The rate limiter fails **open** — if Redis is down we let the swipe through and
log it. The cost of being wrong is some extra free-tier usage for the length of
the outage; the cost of failing closed is taking the core feature of the product
offline because a cache is down.

The socket adapter also fails open — if Redis goes down, delivery keeps working
within each instance and stops working across them, so chat degrades rather than
dies.

Same infrastructure, three different defaults, decided each time by what that
specific path actually protects. The one I'd flag as a genuine risk is the socket
one, because it degrades *silently* — nobody gets an error, messages just stop
crossing between instances. So the error logs from the pub/sub clients are the
thing you alert on. A silent degradation you're not watching is effectively an
outage you haven't noticed yet."

---

## Bugs found and fixed along the way (good if asked "what else did you find?")

- **A GET request that wrote data.** Opening a conversation's history created a
  chat row if one didn't exist. Beyond being non-idempotent and uncacheable, it
  means it fails against a read replica — which is exactly where you'd want to
  send history reads as this grows. And it left rows behind for conversations
  that never happened.
- **An error handler that never responded.** The chat route's catch block only
  logged. The request just hung until the client timed out, which users report as
  "the app is slow", not "the app is broken" — so it's the kind of thing that
  never gets diagnosed.
- **The frontend opened a new WebSocket connection for every message sent.**
  Harmless-looking before; after I added handshake authentication it also meant a
  JWT verification and a database lookup per message.
- **No length limit on a message.** One sender could deliberately push a single
  conversation toward the 16MB document cap.

---

## 30-second version (the whole phase in one breath)

"Chat stored every message in one embedded array per conversation — which has a
hard 16MB ceiling and rewrites the whole history on every message. I split
messages into their own collection and cursor-paginated the read path, with a
migration that's idempotent because it reuses the existing message ids.

While I was in there I found two bugs that don't announce themselves: the socket
layer took the sender's identity from the client, so anyone could post as anyone,
and Socket.io rooms are per-process memory, so the entire feature silently breaks
the moment you run a second instance. I moved socket auth onto the same JWT the
REST API uses, added the connection check that had been a TODO, and put the Redis
adapter in — and I reproduced both failures with two real instances before fixing
them, rather than taking them on faith."
