# Phase 4 — Spoken interview answers

> The *say-out-loud* versions, in Problem → Action → Outcome shape so they stay
> recallable under pressure. Say them in your own words — don't recite.
>
> **Deliberately light on numbers.** The interviewer is checking whether you can
> name the pattern, say why you chose it over the alternative, and say what it
> bought you. Talk in **directions and shapes** ("our cost per upload is now flat
> regardless of file size") rather than figures. The measured numbers, query plans
> and the verified 24.7MB upload are in [phase-4.md](phase-4.md) — and "I can show
> you the `.explain` output" is a stronger answer than a recalled statistic.

**The patterns this phase gives you, by name** — these are the words to actually
say out loud, because they're what's being tested:

| Pattern | Where |
|---|---|
| Keep large payloads off the application process (presigned / direct-to-storage upload) | Q1, Q3 |
| Trading atomicity for throughput, then guarding each new seam | Q1 |
| Structuring an identifier so it carries its own authorization claim | Q1, Q7 |
| Enforcing what you can't prevent (post-hoc verification + cleanup) | Q1, Q7 |
| "Verify the constraint by trying to violate it" | Q1 |
| `$or` needs an index on **every** branch — no partial credit | Q2 |
| Covered queries (projection chosen so no document is fetched) | Q2 |
| Selectivity decides whether an index helps at all | Q2, Q6 |
| Fan-out on read vs fan-out on write, and which direction breaks | Q3 |
| Keyset (cursor) pagination — third use of one convention | Q3 |
| Unique index as the idempotency mechanism (no check-then-act) | Q4 |
| Atomic `$inc` vs lost-update read-modify-write | Q4 |
| Denormalised counter: read:write ratio justifies a second source of truth | Q4 |
| Deferring work is only safe when "not done yet" is a valid state | Q5 |
| Write ordering across two systems with no transaction | Q5 |
| Retryable vs non-retryable failures, separated explicitly | Q5, Q8 |
| Idempotent consumers under at-least-once delivery | Q5 |
| Knowing when *not* to cache | Q6 |
| Authorize what creates state, not what withdraws your own | Q7 |

---

## Q1 (primary) — "Walk me through a design decision you made."

**This is the strongest answer in this phase.** Lead with what you *refused* to
do, because the naive version is what most candidates describe.

**Problem.** "We were adding image posts. The obvious implementation is a
multipart upload to an Express route that buffers the file and forwards it to S3 —
and I didn't want that, for a reason that isn't really about speed.

Node is single-threaded. A user on a phone uploading a few megabytes takes maybe
five or eight seconds, and for that whole time you're holding a connection, a
request slot, and a multi-megabyte buffer on the process. A few hundred
concurrent uploaders on bad connections isn't unusual traffic, and it's enough to
starve the instance. So the symptom isn't 'uploads are slow' — it's that *the API
gets slow for everyone who isn't uploading anything*. That's the part worth
saying, because it's the non-obvious failure mode. And memory scales with
concurrency times file size, so under a spike the process gets OOM-killed."

**Action.** "I used presigned URLs. The backend signs a URL with its credentials
and hands it to the client; the client uploads the bytes directly to object
storage. So our involvement is two small JSON calls that never touch the payload
— give me a URL, and then, here's the key, make it a post.

The honest cost is that upload stops being one atomic operation and becomes three
steps across two systems, and every new seam needs a guard. The one I'd highlight
is ownership: the key is server-generated as `posts/<the authenticated user's
id>/<random>`, and the client never gets to influence the prefix. So when they
come back to claim it, the check is just 'does this key start with your own
prefix'. That's *why* the key is structured rather than opaque — the structure
carries the authorization claim, so I don't need a separate pending-uploads
table to look it up in. It also kills path traversal for free.

The other thing I'd mention is that I verified the constraints by trying to break
them rather than trusting the docs, and that found two real things. One: a
presigned PUT genuinely cannot cap file size — there's no signable header that
bounds it — so I uploaded a 24MB file against a 5MB-policy URL and it returned
200. Two, and this one was a genuine bug in my own code: passing ContentType to
the command doesn't actually put it in the signature. The URL comes back signing
only the host header. So a URL I'd issued for a JPEG happily accepted a
`text/plain` upload and stored it as text/plain. Both needed fixing and only one
was fixable the way I expected."

**Outcome.** "Our cost per upload is now flat — the same two small requests
whether the image is 50KB or 5MB — and the instance is never in the data path, so
upload traffic can't degrade the rest of the API.

For the size gap, since I couldn't prevent it at the URL I enforced it after the
fact: at claim time I do a HeadObject, which is metadata-only so checking a 5MB
file doesn't cost 5MB, and if it's oversized I refuse the post *and delete the
object*. The delete is the important half — without it, the endpoint is free
unlimited storage for anyone with an account. I'd also volunteer the proper fix:
presigned POST supports a content-length-range condition that S3 enforces before
storing. I didn't take it because it adds a dependency and turns a one-line client
fetch into a multipart form with a dozen policy fields, but that's the upgrade
path if uploads ever became untrusted."

---

## Q2 (primary) — "Tell me about a performance problem you found and fixed."

**Problem.** "This one I found by accident, which is part of the story. I was
building a posts feed scoped to your connections, so I needed 'the ids of
everyone I'm connected to' on a hot read path. That query already existed — the
connections screen had been running it since the app was written. I ran
`.explain()` on it before building on top of it, and it was a full collection
scan.

And it was scanning the fastest-growing collection in the system — the connection
requests table, one row per swipe. I'd already fixed a collection scan on that
same collection in an earlier phase, on a daily cron job. This one was worse in
one specific way: the cron ran once a day, off the request path. This was a
user-facing screen, synchronously, on every single load."

**Action.** "The query is an `$or` — 'accepted requests where I'm the sender, or
accepted requests where I'm the recipient' — because a connection is stored once
and directionally. Whoever swiped first is the sender; there's no separate edge
list. So 'my connections' always has to look both ways.

Now, here's the part that's actually interesting, and it's the bit I'd want to
explain: there *was* an index that could serve one of the two branches. And it
didn't help at all. MongoDB's `$or` planner needs an indexed plan for *every*
branch — if even one branch has nothing usable, it gives up on index selection
for the whole `$or` and does a single scan, because one scan beats one scan per
branch. So a half-indexed `$or` performs exactly like an unindexed one. There's no
partial credit.

I proved that rather than asserting it — I added an index covering just the first
branch, re-ran it, and the documents-examined count was completely unchanged. Then
I added the second one, one per direction, and it dropped to zero.

Zero, not 'fewer', because I picked the key order so the query is *covered*: both
id fields and the status are equality matches, and I put the remaining field the
projection needs at the end of the index. So MongoDB answers entirely out of
index keys and never fetches a document at all."

**Outcome.** "It went from scanning the whole collection to examining exactly as
many index keys as it returns rows, and fetching zero documents. Before, the cost
grew with the total size of the collection; now it's proportional to the number of
connections you actually have — which is the size of the answer, which is the
best you can do.

Two things I'd add. It incidentally fixed a second screen — pending received
requests — which was scanning for exactly the same reason. And I pulled the query
into one shared helper, because it was about to have two callers and a graph
traversal with two copies drifts: one gets the index-friendly rewrite, the other
doesn't, and the one that didn't becomes the slow path nobody notices."

---

## Q3 — "How did you design the feed? / How would you scale it?"

**Problem.** "A posts feed scoped to your connections is the classic fan-out
question, so the decision is read-time or write-time."

**Action.** "I compute it at read time — get your connection ids, then ask for
the newest posts by anyone in that set, paginated with a cursor.

The alternative is fan-out on write: every user gets a materialised timeline, and
when you post, you push the id into all your connections' timelines. Cheap reads,
expensive writes, and a derived copy per user you have to keep correct.

What I'd want to get across is *which direction each one breaks*, because they're
not symmetric. Fan-out on write breaks when one **author** has a huge following —
one post becomes millions of inserts, the celebrity problem. Fan-out on read
breaks when one **reader** follows a huge number of authors, because then your
`$in` is a huge merge.

And read-time is right *here* specifically because connections in this app are
mutual and require an accepted request. You can't have fifty thousand accepted
mutual connections without it being socially absurd, so the fan-out is bounded in
the hundreds by the shape of the product. That's why the same choice would be
wrong on Twitter, where follows are one-way and unbounded."

**Outcome.** "Page cost is proportional to your connection count plus the page
size, with no term that grows with the total number of posts. And I'd volunteer
the scaling answer rather than waiting to be asked: at real scale this goes
hybrid — fan-out on write for ordinary accounts, read-time merge for the handful
of high-fan-out ones. You don't pick one globally, you pick per account.

One more thing I checked that I think is the more interesting half: I tested
whether my feed index was actually earning its place, and the answer was 'only
in the regime we're heading into'. Without it the query isn't a scan — Mongo can
walk the `_id` index backwards, which already satisfies the sort and the cursor,
and just filter by author. When I simulated a dense graph where the viewer follows
a third of all authors, that filter hits often enough that the plain `_id` walk
*beats* my index. When I made it realistically sparse — under one percent — the
walk had to examine a couple of thousand documents to fill one ten-post page,
because almost everything it walks past belongs to someone you don't follow, and
that number grows with the user base while the indexed version stays flat.

So the index is right, but for a reason that's about selectivity, not about
indexes being good. And the metric I cared about was documents examined, not
milliseconds — at test-database size everything's in cache and the timings are
noise."

---

## Q4 — "How do you handle concurrent or duplicate requests?"

**Problem.** "Likes are the obvious place. Someone double-taps a heart, that's two
requests in flight at once; a flaky mobile connection retries, same thing. The
naive implementation is 'look up whether they've already liked it, and if not,
insert' — and that's check-then-act. Both requests do the lookup, both see
nothing, both insert. One of them gets a 500 for doing nothing wrong, and if
you're also incrementing a counter alongside it, the count ends up wrong in a way
no later request will ever correct."

**Action.** "I put a unique compound index on post-plus-user and then wrote no
check at all. The handler just inserts, and if the database comes back with a
duplicate-key error, that *is* the answer — they already liked it — so I return a
200 with the current count rather than treating it as a failure.

That's the mental shift I'd want to convey: the index isn't there to catch a bug
in my code, it's there so the code doesn't need to make the decision. The database
is the only thing that can decide atomically, so let it.

The counter is `$inc`, never read-modify-write. Two likers both reading five and
both writing six loses a like; `$inc` is applied on the server, so N concurrent
increments always sum to N. And I only touch the counter when the insert actually
succeeded — the duplicate path returns before it — so a retry can't inflate it."

**Outcome.** "I tested it with eight simultaneous likes from one user on one post:
one 201, seven 200s, final count exactly one. Liking twice and unliking twice are
both no-ops that report success, so a double-tap, a retry, and two devices acting
at once all converge on the same state.

The thing I'd point out is that this is the third time in this project I've hit
the same bug class — duplicate connection requests in one phase, duplicate
conversation documents in another, and likes here. Same shape every time:
check-then-act where the concurrent case is ordinary user behaviour, not abuse.
By this point the reflex is to reach for a unique constraint before writing the
guard."

---

## Q5 — "Tell me about something you moved to a background job."

**Problem.** "Thumbnails. Posts are full-size phone photos, and a feed rendering
twenty of them at full resolution is a lot of bandwidth for the viewer. So you
want a resized version — but resizing is the wrong thing to do on the request."

**Action.** "It's on a queue, reusing the job infrastructure I'd built two phases
earlier. Worth noting that adding a whole new async workload cost me one queue
file and one worker file, because the connection handling, the retry policy shape
and the worker process already existed — that's the payoff for having built it
properly the first time.

Two reasons it can't be inline. The image library is native and CPU-bound, and it
runs on libuv's thread pool, which is four threads by default — so a handful of
concurrent uploads saturates it, and then *everything else in the process queues
behind image resizing*, including DNS lookups for requests that have nothing to
do with posts. And it would mean downloading the full image back onto the API
instance, which undoes the whole point of having kept the bytes off it.

But the design decision I'd actually lead with is what makes deferring it *safe*:
the thumbnail field is nullable, and null is a valid renderable state. The client
renders the thumbnail if it's there and the original if it isn't. So a backed-up
worker, a crashed worker, or Redis being down degrades image weight — never
availability. If I'd made that field required, the resize would have had to be
inline and the upload would be exactly as slow as the slowest image.

That's the test I'd apply generally: work belongs on a queue when 'not done yet'
is a state the system can be in correctly. Otherwise you haven't made it async,
you've just hidden a dependency."

**Outcome.** "The post is live the instant the row is written, and the thumbnail
lands a second or two later at roughly a tenth the size.

Two details I'd offer if they want depth. First, ordering: the worker uploads the
thumbnail bytes and *then* points the database row at them. There's no transaction
across object storage and Mongo, so one write can land without the other, and the
ordering picks which inconsistency you can have. My order leaves an unreferenced
object in the bucket — a few kilobytes, invisible, and the retry recomputes the
same key and overwrites it. The other order leaves a row pointing at a thumbnail
that doesn't exist, which is a broken image in every viewer's feed. Wasted bytes
beat a dangling pointer.

Second, I separated retryable from non-retryable failures. If storage blipped,
retrying in two seconds fixes it. If the object isn't a decodable image, retrying
never fixes it — so that one fails immediately instead of burning three attempts
and two backoff delays re-proving that a PDF isn't a JPEG. And that turned out to
matter for a reason I didn't plan: the image library is the *only* thing in the
whole pipeline that actually parses the bytes. The signed content type and the
metadata check both only see the label the client claimed. So the worker is where
'is this actually an image' is genuinely answered, and I leave the post alive with
no thumbnail rather than deleting it — deleting someone's content because a
resize failed is a moderation decision, not a resize worker's call."

---

## Q6 — "When would you *not* add a cache?"

**A good question to invite**, because the obvious follow-up to "I cached the feed
exclusion set" is "so why not this too?"

**Problem.** "In an earlier phase I'd cached a derived set in Redis. In this phase
I had a structurally similar query — the connection list — on a hot read path, and
the reflex answer is to cache that too. I didn't."

**Action.** "The distinction I drew is *what the cost is proportional to*. The
thing I cached earlier had a cost proportional to the user's entire interaction
history — every swipe they'd ever made, re-read on every page of a scroll
session, growing without bound for the life of the account, to produce an answer
that was identical on every one of those pages. That's an unbounded read producing
a repeated answer, which is exactly what a cache is for.

The connection list, once I'd indexed it properly, costs in proportion to the
number of connections — which is the size of the answer itself. There's nothing to
amortise. A cache would save me one round trip and cost me a second source of
truth.

And the downside isn't symmetric, which is the deciding factor. The posts feed
uses that connection list as its *access-control boundary*. So a stale entry
isn't a slightly stale feed — it's showing someone the posts of a connection they
removed. Staleness in the other cache was safe by construction; here it's a
privacy bug."

**Outcome.** "The rule I'd state is: cache to fix an access pattern whose cost is
unbounded, not to shave a millisecond off one that's already proportional to its
result — and be much more reluctant when the cached value is what an authorization
check reads. An index was the right fix in one place and a cache in the other, and
they're not interchangeable."

---

## Q7 — "How did you think about security here?"

**Problem.** "Direct-to-storage uploads move a trust boundary. The client is
talking to the object store without me in the middle, so anything I used to be
able to check by inspecting the request, I now have to check some other way."

**Action.** "Four things, and I'd frame them as four separate questions.

*Can they write where they shouldn't?* No — the key is server-generated from the
authenticated session and they never influence the prefix, so a signed URL can
only ever write into that user's own space.

*Can they claim something that isn't theirs?* That's the one that would actually
have been a data leak. The key arrives in a request body when they come back to
create the post, so it's attacker-controlled — without a check they could claim
any key in the bucket and publish someone else's private photo as their own post.
The prefix check closes it in one line, which is the payoff of having structured
the key.

*Can they write something too big, or something that isn't an image?* Size I
can't prevent at the URL, so I verify at claim time and delete what fails.
Content type I *thought* I'd pinned into the signature and hadn't — that took
explicitly adding it to the signed headers. And whether the bytes are really an
image, nothing on the request path can answer; the resize worker is the first
thing that parses them.

*Can they read what they shouldn't?* The bucket is private and read URLs are
short-lived signed GETs, minted only after I've checked the connection graph. A
public bucket would be cheaper and faster, but a public object URL is readable by
anyone who has it, forever — so the access rule would live in my API and not in
storage, and one shared link bypasses it. An access control that only one of two
doors enforces isn't one."

**Outcome.** "The trade I accepted is that per-viewer, time-bound URLs aren't
cacheable at a CDN edge the way stable public ones are, and the production fix for
that is CloudFront with an origin access identity — same private bucket, cached at
the edge, no application change.

One design detail I like from this: like and unlike are deliberately
*asymmetrically* authorized. Liking needs an accepted connection, because post ids
get handed out in feed responses and without the check strangers could inflate
posts they were never allowed to see. Unliking has no check, because it only ever
removes a row you created yourself — and gating it would strand that row and leave
the counter permanently inflated if you'd been disconnected in between. The rule
is: authorize the action that creates state, not the action that withdraws your
own."

---

## Q8 — "What happens when a dependency is down?"

Short, per-dependency, and the point is that each answer is *different*:

- **Redis / the queue is down at post time.** The post still succeeds. The enqueue
  is wrapped separately and after the row is durably written, so a queue failure
  is logged and swallowed — the cost is a post that renders from its original
  image instead of a thumbnail, which is exactly the degradation the nullable
  field was designed to make safe. Redis being down must never turn a successful
  post into a 500.
- **Object storage is down at claim time.** The post is refused, and it should be
  — there's nothing to point at. That one's fail-closed, unlike the queue.
- **Object storage blips during a resize.** Retried with backoff, three attempts.
- **The object isn't a decodable image.** Failed immediately, not retried, and
  explicitly marked non-retryable so it doesn't burn attempts. The post stays
  alive with no thumbnail.
- **The worker dies mid-job.** At-least-once delivery means the job comes back.
  It's idempotent three ways: a deleted post is treated as success-by-vacancy, an
  already-generated thumbnail is skipped, and the final update is guarded so two
  concurrent deliveries can't both write. The derived thumbnail key is what makes
  the retry clean — it recomputes the same key rather than orphaning a new object
  each attempt.
- **A user deletes a post while its job is queued.** Handled as the first case
  above. Without it the worker would generate and upload a thumbnail for a
  nonexistent post, orphan the object, then burn all three attempts failing the
  update.

---

## Bugs and gaps found along the way (good if asked "what else did you find?")

1. **A user-facing screen had been doing a full collection scan since it was
   written** — the connections list. Found only because I ran `.explain()` on a
   query I was about to reuse rather than assuming an existing query was fine.
2. **A partially-applicable index was buying nothing**, because `$or` needs every
   branch indexed. Easy to believe you'd fixed it and not have.
3. **My own presigned URLs weren't enforcing content type.** Passing it to the
   command isn't enough; it has to be in the signed headers. Found by trying to
   upload a mismatched type, not by reading the code.
4. **An index that had become dead weight** — an earlier phase removed its only
   query, so it now costs a write on every insert and serves no read. I flagged it
   rather than dropping it: removing an index is irreversible in production and
   deserves its own change with its own verification, not a drive-by deletion in a
   feature branch where a rollback would also revert the feature.

---

## 30-second version (the whole phase in one breath)

"Image uploads go straight from the client to object storage using a presigned
URL, so the API never touches image bytes and our cost per upload is flat
regardless of file size. That trade turns one atomic operation into three steps,
so each new seam needed a guard — I structured the storage key so it carries its
own ownership claim, and I verified the constraints by trying to violate them,
which found that a presigned PUT can't cap file size and that my own URLs weren't
actually enforcing content type. Size is enforced after the fact with a
metadata-only check that deletes what it rejects. The feed is fan-out on read,
which is right here because mutual connections bound the fan-out — and while
indexing it I found a full collection scan on a user-facing screen that had been
there since the app was written, caused by `$or` needing an index on every branch
to use one at all. Likes are idempotent by unique index rather than by
application-level checks, and thumbnails are generated on a worker, which is only
safe because 'no thumbnail yet' is a valid state the client renders around."
