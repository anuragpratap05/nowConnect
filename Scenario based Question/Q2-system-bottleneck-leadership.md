# Q1 — Identifying a bottleneck & leading the fix (unasked)

> **Category:** Values, Leadership & Culture
>
> **Question:** *Describe a time you identified a system bottleneck and took the
> lead to fix it without being asked. How did you balance this with your existing
> sprint velocity?*

**Scenario status:** 🔮 **Future scope** — devTinder does **not** yet have an
in-app notification / activity-feed system (no `notification` model, no
notification queue). The story below is framed as *catching the bottleneck during
the design + load-test phase of that upcoming feature*, which is the most honest
way to use a not-yet-built feature in a behavioral answer. If the interviewer
asks "is this live?", the truthful answer is: *"This was the design decision we
locked in before building it — I'll walk you through the trap we designed
around."*

---

## The bottleneck pattern (the real-world thing)

**Fan-out-on-write + a hot key (the "celebrity problem").**

When you build notifications or an activity feed, the naive design is
**fan-out-on-write**: the moment something happens (a like, a connection request,
a message), you immediately write one notification row for the recipient. That's
fine for normal users. It falls over for **popular accounts**:

- A highly-liked profile on a dating app can receive thousands of likes in a
  short burst.
- Each like triggers a write to that one user's notification list → a **single
  hot document / hot partition** that every one of those requests contends on.
- Writes serialize, latency spikes, the queue backs up, and the slowdown bleeds
  into *unrelated* endpoints because connections and worker threads are tied up.

This is one of the most common scaling incidents in social/consumer apps, which
is exactly why it's a great interview story: it's recognizable and it has a
well-known, defensible fix.

---

## STAR answer (this is what you say out loud)

**Situation**
> "We were about to add an in-app notifications feature to devTinder — likes,
> connection requests, and new messages would show up in a notification tray. It
> was scoped as a normal sprint feature. During the design review I pushed to do
> a quick load test of the proposed approach before we committed to it, because
> something about the write path worried me."

**Task**
> "Nobody asked me to stress-test it — the design 'looked fine.' But I'd seen the
> celebrity hot-key pattern bite consumer apps before, and devTinder's whole
> premise is that *some* profiles get disproportionate attention. I took it on
> myself to validate the design before we built something we'd have to rip out."

**Action**
> "I wrote a small script against our seed users to simulate a burst of likes on
> a single popular profile — a few thousand in a short window. The naive
> fan-out-on-write design did exactly what I feared: every like contended on that
> one user's notification document, write latency on that path climbed sharply,
> and because our workers were busy serializing those writes, the notification
> queue started lagging for *everyone*.
>
> I wrote a one-pager with the load-test numbers and a design change:
> - Keep **fan-out-on-write for normal users** (simple, fast reads).
> - Switch **high-fan-in accounts to fan-out-on-read** — don't write N
>   notification rows; instead aggregate ('1,284 people liked you') and
>   compute the tray lazily when the user opens it.
> - Add **jittered TTLs and a short aggregation window** so bursts collapse into
>   one notification instead of thousands.
>
> This fit naturally on top of infrastructure we already have — Redis for the
> aggregation counters and BullMQ for the async fan-out — so it wasn't a new
> system, just a smarter write path. I brought it to my lead in standup rather
> than quietly re-architecting: here's the trend, here's the fix, here's the
> cost."

**Result**
> "We adopted the hybrid fan-out design before writing the production code, so we
> never shipped the version that would have fallen over. On sprint velocity: I
> kept the investigation to a timeboxed spike — under a day — and the design
> change didn't actually grow the build estimate much, because aggregation
> replaced a lot of redundant writes. I flagged one stretch goal in the sprint as
> at-risk so the team wasn't surprised; it ended up landing anyway.
>
> The lasting win was cultural: 'load-test the hot path before we commit the
> design' became a checklist item for any feature with fan-out, and my lead
> started looping me in on scaling reviews."

---

## 60-second spoken version (when they want it tight)

> "We were about to add in-app notifications to devTinder — likes, connection
> requests, new messages. It was scoped as a normal feature, but during the
> design review I pushed to quickly load-test the write path first, because our
> whole premise is that some profiles get *way* more attention than others.
>
> Nobody asked me to — the design looked fine. But I'd seen the celebrity hot-key
> problem before, so I wrote a small script to simulate a few thousand likes on
> one popular profile. The naive fan-out-on-write design buckled: every like
> contended on that one user's notification document, write latency spiked, and
> because the workers were tied up, the notification queue lagged for *everyone*.
>
> I wrote a one-pager with the numbers and proposed a hybrid: keep
> fan-out-on-write for normal users, but switch high-traffic accounts to
> fan-out-on-read with aggregation — 'a thousand people liked you,' computed
> lazily instead of a thousand writes. It sat right on top of the Redis and queue
> infra we already had. I brought it to my lead rather than quietly
> re-architecting.
>
> The key thing on velocity: I timeboxed the spike to under a day and flagged one
> stretch task as at-risk so the sprint stayed predictable. We locked in the
> better design before writing a line of production code — the cheapest place to
> catch a scaling bug. And 'load-test the hot path before committing the design'
> became a team norm after that."

*(~210 words ≈ 55–65 seconds at a natural pace. If you need to cut further, drop
the middle paragraph's detail and keep Situation → the fix → the velocity line.)*

---

## Why this answer works (the signals being tested)

This question has two traps. Hit both on purpose:

1. **"Without being asked" ≠ cowboy.**
   The initiative is in the *investigation and the proposal*, but the fix went
   through the lead and the team. That's the maturity signal — you took ownership
   of the problem without taking unilateral control of the codebase.

2. **"Balance with sprint velocity" is the real question.**
   Weak answers say "I worked extra hours." Strong answers show explicit tradeoff
   management:
   - **Timeboxed** the spike (< 1 day) instead of open-ended tinkering.
   - **Proactively flagged** an at-risk task so velocity stayed predictable.
   - Chose a fix that **reused existing infra** (Redis + BullMQ) instead of
     introducing a new system mid-sprint.
   - Caught it at **design time**, which is the cheapest possible place to fix a
     scaling bug — far cheaper than a prod incident.

3. **It's tagged "Values, Leadership & Culture"**, so land the cultural ripple at
   the end: the new team norm. That answers the hidden question — *did your
   initiative make the team better, or just make you look good?*

### Delivery tips
- Lead with the **metric / observable** ("write latency climbed, the queue
  lagged for everyone"), not a vague feeling.
- Say the restraint line explicitly: *"I brought it to my lead rather than
  quietly re-architecting."*
- Be honest about scope: this was a **design-phase catch**, not a live incident.
  Interviewers respect "we designed around it" as much as "we firefought it."

---

## Technical appendix (to survive follow-up probes)

**Q: Fan-out-on-write vs fan-out-on-read — when do you use each?**
- **Write (push):** compute the recipient's feed/notifications at event time.
  Fast reads, expensive + contentious writes. Great for the average user.
- **Read (pull):** store events once; assemble the recipient's view on request.
  Cheap writes, more expensive reads. Great for high-fan-in / celebrity accounts.
- **Hybrid** (what Twitter/Instagram-style systems actually do): push for normal
  accounts, pull for the heavy hitters. That's the design in this answer.

**Q: How would aggregation work concretely here?**
- Maintain a Redis counter per `(recipient, event_type, window)` — e.g.
  `notif:{userId}:like`. Increment on each like within a short window.
- One notification row represents the whole window: "1,284 people liked you,"
  updated as the counter grows, instead of 1,284 rows.
- This also solves the UX problem (nobody wants 1,284 separate pings).

**Q: Why did the slowdown affect unrelated endpoints?**
- Shared resources: DB connection pool and worker concurrency. A hot write path
  that holds connections/locks starves everything else — this is why a localized
  bottleneck shows up as a *global* latency regression. Mentioning this shows you
  understand blast radius, not just the single slow query.

**Q: How would you detect this in production (not just design review)?**
- p95/p99 latency per endpoint, queue depth / job age on the notification queue,
  and per-document / per-shard write metrics. Alert on queue lag, not just error
  rate — backpressure is a leading indicator; errors are the lagging one.

**Related real-world bottleneck patterns worth name-dropping if asked for others:**
- **Cache stampede / thundering herd** — many requests rebuild the same expired
  hot cache key at once. Fix: single-flight lock, jittered TTL,
  stale-while-revalidate.
- **N+1 queries** on `populate` — fix with projection + batched lookups.
- **Missing compound index** on a filtered+sorted query — the devTinder feed
  exclusion query is a candidate.
- **Connection pool exhaustion** from a slow downstream call holding connections.
- **WebSocket horizontal-scaling gap** — Socket.io across multiple Node
  instances needs a Redis adapter / pub-sub or messages don't cross instances.
