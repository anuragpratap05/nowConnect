# Phase 1 — Spoken interview answers

> These are the *say-out-loud* versions, grounded in the real files, index names,
> and `.explain()` numbers from this phase. They're written in Problem → Action →
> Outcome shape so they stay recallable under pressure. Say them in your own
> words — don't recite. The reference detail lives in [phase-1.md](phase-1.md).

---

## Q2 (primary) — "Tell me about a performance incident and how you fixed it."

**Problem.** We had a daily cron job that, at 8am, emailed everyone who'd
received a connection request the day before. It queried our `ConnectionRequest`
collection — which is the fastest-growing table in the whole system, one row per
swipe — filtering on `status` and `createdAt`. The only index on that collection
was on `{fromUserId, toUserId}`, which is useless for that filter. So every
morning we were doing a **full collection scan on our biggest table**.

The nasty part is *why it was hard to catch*: it threw no errors and returned
correct results. It was a silent, linear-in-collection-size slowdown that only
became a visible database-CPU spike once the collection got big — and because it
was on a cron, the spike showed up at a fixed time every day, so at first it
looked like a mysterious recurring load event rather than one bad query.

**Action.** I reproduced it with `.explain("executionStats")` on the exact
query. The plan came back as a `COLLSCAN` with `totalDocsExamined` equal to the
entire collection — reading every document to return a few hundred. The fix had
two parts. First, a **partial compound index** on
`{status: 1, createdAt: 1, toUserId: 1}` with a partial filter of
`status: "interested"` — partial because that's the only status this query ever
looks at, so I'm not paying index cost for the other three. Second, I **rewrote
the query**: instead of `.find(...).populate("fromUserId toUserId")`, which
materialised full documents and even populated the `fromUserId` side that the
job never used, I switched to `distinct("toUserId", ...)` followed by a single
projected `User.find` for just the email addresses.

**Outcome.** Because I put `toUserId` at the tail of the index, the `distinct`
became a **covered query** — MongoDB answers it entirely from the index and never
touches a document. In the `.explain`, `totalDocsExamined` went from **8,000 to
0** on my seeded set, `COLLSCAN` became `PROJECTION_COVERED → DISTINCT_SCAN`. And
the important part isn't the one number — it's that the cost is now bounded by
*yesterday's* interested requests instead of the *entire history* of the
collection. At five million lifetime rows, the old query scans all five million
every morning; the new one still examines zero documents.

---

## Q1 (secondary) — "What's a challenge you faced and why was it hard?"

Lead with the *silence*. "The hardest bugs I've dealt with weren't the ones that
threw errors — they were the ones where everything looked fine. The cron
collection-scan is a good example: correct results, no exceptions, fast in
testing because the collection was small. It only shows up as a problem at scale,
and only at a fixed time of day, so the signal is a recurring CPU spike with no
obvious cause. The challenge was less 'fix the query' and more 'realise there was
a query to fix' — which is why I now reach for `.explain` on anything that runs
against a fast-growing collection, rather than trusting that correct output means
healthy output."

---

## Q3 — "Walk me through a design decision you made."

The one I'd pick here is **moving the email send off the cron path onto a job
queue**, and specifically *why BullMQ and not something heavier*.

"Once I'd fixed the query, the email send was still happening inline in the cron
loop — so a slow or down mail provider would stall the whole job. I moved it onto
a BullMQ queue on the Redis we already run: the cron's only job now is to compute
recipients and enqueue, and a separate worker process does the actual send with
retries and exponential backoff. The deliberate decision was *not* reaching for
Kafka or SQS. At our volume that's over-engineering — BullMQ gives me retries,
backoff, and a failed-job set for free on infrastructure I already have. I wrote
down the specific signal that would make me revisit it — needing replay,
durability guarantees, or multiple consumer groups — so deferring it is a
reasoned choice, not a gap."

If they push on *fail-open vs fail-closed*: "It depends on what the check
protects. For the email cron, if Redis is down I log and drop the run — it's a
best-effort daily nudge, it'll catch people tomorrow. For the payment webhook I
reused the same queue but made it fail-*closed*: if I can't enqueue, I return 500
and let Razorpay retry, because I must never ack a payment I haven't durably
recorded. Same infrastructure, opposite decision, driven by what's at stake."

---

## Q4 — "A trade-off between two options, and how it played out."

Use the **idempotency** decision on the payment webhook.

"Razorpay redelivers webhooks, so the handler has to be idempotent. The
lightweight option was to use the Razorpay event id as the queue's job id, so a
redelivered event is de-duplicated by the queue itself with no schema change. The
heavier option was a unique index on a stored event id in the database — a
permanent guard, but more moving parts. I went with the job-id approach *plus*
making the worker apply an idempotent end-state — setting `isPremium = true`
again is a harmless no-op. The trade-off I was accepting is that job-id de-dup
only holds within the queue's history-retention window; a redelivery arriving
long after the job was evicted would slip past it. That's exactly why the
worker's end-state idempotency is the backstop, and I documented the DB unique
index as the next step *if* we ever observe redeliveries outside that window —
rather than paying for it up front."

---

## Q5 — "Have you dealt with load concentrated at a fixed time?"

Two examples, both from this phase.

"Yes — two flavours. One is the **8am cron spike** I already described: load
concentrated at a fixed clock time because a scheduled job hit a bad query. The
fix was the index and covered query, so the job's cost no longer scales with the
collection.

The other is **bursty payment webhooks** — think a promo or sale where a lot of
payments complete in a short window. There, the fix is structural: once I've
verified the webhook signature, I **ack 200 immediately** and push the actual
database work onto the queue, instead of doing the payment-status update and user
upgrade inline. So a burst of webhook calls can't make Razorpay's delivery back
up or time out waiting on our database — we absorb the spike in the queue and
drain it at our own pace with a worker running in its own process."

---

## Bugs found and fixed along the way (good to mention if asked "what else?")

- **`sendEmail` ignored its recipient argument** — it hardcoded a single address,
  so every notification would have gone to the same inbox. Surfaced naturally
  once the worker needed genuine per-recipient delivery.
- **The webhook upgraded users to premium on *any* event**, including
  `payment.failed`, and had no null-check on the payment lookup. Now it branches
  on the event type and only a successful capture upgrades.
- **The cron populated `fromUserId`** (the sender) even though it only ever used
  the recipient's email — extra join work for data that was thrown away.

---

## 30-second version (if they want the whole phase in one breath)

"We had a daily cron doing a full collection scan on our fastest-growing table —
silent, no errors, just a CPU spike at 8am. I root-caused it with `.explain`,
fixed it with a partial covering index and a rewritten covered query so it
examines zero documents regardless of table size, and then moved the email send
off the cron onto a BullMQ queue so a slow mail provider can't stall it. I reused
that same queue to harden our payment webhook — ack fast, process async, and make
it idempotent against Razorpay's redeliveries."
