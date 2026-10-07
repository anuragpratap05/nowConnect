# Q6 — High-impact feature, shifting requirements, ensuring quality

> **Category:** Execution / Delivering under change
>
> **Question:** *Describe a time you had to deliver a high-impact feature in a
> fast-moving environment with shifting requirements. How did you ensure quality?*

**Scenario status:** ✅ **Implemented** — this is real devTinder code: the chat
system was redesigned from **embedded messages (V1)** to a **separate `Message`
collection (V2)**, with a **live, idempotent data migration**
(`src/models/chat.js`, `src/models/message.js`,
`src/scripts/migrateChatMessages.js`). The technical substance is all real and
you can open the files.

**Honesty framing:** devTinder is a solo project, so the "fast-moving team" wrapper
is interview framing — but the *requirement shift* is genuine (the V1 design hit
hard limits and forced a redesign mid-project) and the *migration-safety work* is
real code. If probed, the honest core is: *"I discovered my original design
wouldn't hold, and I had to change the data model of a live feature without losing
data — here's how I de-risked that."*

---

## What shifted, and why it was high-impact

**The feature:** 1:1 chat — a core, high-impact feature (it's what two matched
users actually *do*).

**V1 design (the original requirement):**
```
Chat { participants: [ObjectId], messages: [messageSchema] }   // messages embedded
```
It worked in early testing. Then the requirements effectively *shifted* once I
thought about real usage and scale, and the V1 design broke in three ways:

1. **The 16MB document cap.** MongoDB refuses any document over 16MB, so a
   conversation had a hard ceiling (~100–150k short messages). Not "gets slow" —
   **stops working permanently** for that pair, with no fix that doesn't change
   the schema.
2. **Whole-array rewrite on every send.** `chat.messages.push(...)` + `save()`
   ships the entire array back each time → appending message N is **O(N)**, plus
   storage fragmentation and the whole array re-replicating to the oplog on every
   message.
3. **No meaningful pagination.** You can't page history when the server has to
   load the whole document off disk to slice an array.

**V2 design (what I delivered):** one document per message in its own collection;
`Chat` becomes conversation *metadata only* (participants, a canonical pair key,
and a denormalized `lastMessageAt`). Appends become O(1), history becomes an
index range scan. I also fixed a **concurrency bug** in the same pass: two users
opening a chat simultaneously could both miss the `findOne` and both insert,
splitting the conversation into two documents — so I added sorted
`participantLow`/`participantHigh` scalar fields with a **unique index** to make
the pair impossible to duplicate.

---

## STAR answer (this is what you say out loud)

**Situation**
> "devTinder's chat was built V1 with every message embedded in an array on the
> conversation document. It worked early on. But as I thought through real usage,
> the requirements shifted under me: that design has a hard 16MB document ceiling
> that permanently breaks a conversation once it's hit, every send rewrites the
> whole array so it gets O(N) slower the longer people talk, and you can't
> paginate history. Chat is a core feature, so this wasn't optional to fix."

**Task**
> "I had to change the data model of a live feature — move every message out of
> the embedded array into its own collection — **without losing a single message**
> and without a window where the app writes to the old shape and silently drops
> data. The migration was the risky part; getting the new schema right was the
> easy part."

**Action**
> "I split messages into their own collection, reduced Chat to metadata, and added
> a canonical-pair unique index to kill a duplicate-conversation race I found
> while I was in there.
>
> The migration is where I spent my quality budget. I made it **idempotent** by
> reusing each embedded message's existing subdocument `_id` as the new Message's
> `_id` — so re-running can't duplicate anything, and an interrupted run can just
> be re-run, which is the property you actually want when a migration dies halfway.
> I gave it a **`--dry-run` mode** that reports what it *would* do with no writes,
> **batched** it so it doesn't hammer the DB, and had it **read through the raw
> driver** instead of the model — because the new schema no longer declares the
> old `messages` field, so the model would've stripped it and the script would've
> 'successfully' migrated nothing.
>
> I also designed the cutover to be safe: I deliberately did **not** keep the old
> `messages` field on the schema, so no live code path could write an empty array
> back over data the migration hadn't moved yet. And I handled the edge cases —
> empty conversations still get the pair fields so they're inside the unique
> index, and `lastMessageAt` is derived data the script can recompute at any time."

**Result / How I ensured quality**
> "Net: the model change shipped and the data moved with **zero message loss and
> no duplication**, verifiable because idempotency + id-reuse make the migration
> re-runnable and self-checking. Chat went from a feature with a hard ceiling to
> one that appends in O(1) and paginates cleanly, and the duplicate-conversation
> race is now structurally impossible rather than just unlikely.
>
> The way I *ensured* quality under a shifting requirement wasn't more manual
> testing — it was **making the risky operation safe by construction**:
> idempotent so retries are free, dry-runnable so I could inspect before
> committing, batched so it degrades gracefully, and reversible-in-spirit because
> re-running is always safe. That's how you move fast on something dangerous
> without gambling."

---

## 60-second version (tight)

> "devTinder's chat was built V1 with messages embedded in an array on the
> conversation document. It worked early, but the requirement shifted once I hit
> the reality: that design has a hard 16MB ceiling that permanently breaks a
> conversation, every send rewrites the whole array so it's O(N), and you can't
> paginate. Chat is core, so I had to redesign it — move messages into their own
> collection — without losing data on a live feature.
>
> The redesign was easy; the migration was the risk, so that's where I put my
> quality effort. I made it idempotent by reusing each message's existing `_id`,
> so re-running can't duplicate and an interrupted run just gets re-run. I added a
> dry-run mode, batched it, and read through the raw driver because the new schema
> no longer knows the old field. And I kept the old field off the schema so no
> live write could clobber unmigrated data.
>
> Result: zero message loss, no duplicates, chat now appends in O(1) and
> paginates. The lesson: under shifting requirements you ensure quality by making
> the dangerous operation *safe by construction* — idempotent, dry-runnable,
> re-runnable — not by testing harder after the fact."

*(~190 words ≈ 60 seconds.)*

---

## Why this answer works (the signals being tested)

1. **"Shifting requirements" is shown honestly as a *design* that stopped
   holding** — a very real form of requirement change, and more credible than a
   generic "the PM kept changing their mind."
2. **"How did you ensure quality" is the climax, and it's concrete.** Idempotency
   via id-reuse, dry-run, batching, raw-driver reads, not declaring the dead
   field — these are specific, senior techniques, not "I wrote tests."
3. **The reframe is the money line:** *"you ensure quality by making the dangerous
   operation safe by construction, not by testing harder afterward."* That's a
   principle, and principles are what distinguish senior answers.
4. **You fixed a latent bug in passing** (the duplicate-conversation race) and
   made it *structurally* impossible — shows you raise the quality bar, not just
   meet the ticket.
5. **It's real and defensible.** Every claim maps to a file.

### Delivery tips
- Separate the two risks out loud: *"the new schema was the easy part; the live
  migration was the risk."* It shows you know where quality effort actually goes.
- Define idempotency simply and concretely (reusing the existing `_id`), then say
  why it matters: *"a migration that died at 2am can just be re-run."*
- Land the "safe by construction" principle at the end.

---

## Follow-up probes (be ready)

**Q: Why not just do the migration automatically on app startup?**
> It's a one-shot operation over user data that can partially fail in ways a human
> should look at — so it's an operator-run script, not a boot-time migration that
> also competes with serving traffic. Boot-time migrations also run on every
> instance at once, which is how you get concurrent half-migrations.

**Q: How exactly is it idempotent?**
> Every embedded subdocument already has an `_id` from Mongoose. I reuse that as
> the new Message's `_id` instead of generating a new one, so re-inserting the
> same message collides with its own `_id` and is skipped. Re-running converges
> instead of duplicating — and any message id a client already holds as a
> pagination cursor stays valid across the migration.

**Q: What if the migration is interrupted halfway through?**
> Re-run it. Because it's idempotent, already-migrated messages are skipped and it
> picks up the rest. That's the whole reason idempotency was the design goal and
> not an afterthought.

**Q: How did you verify no data was lost?**
> Dry-run first to see the counts it would move; the script reports chats migrated
> / messages inserted / skipped / failures; and idempotency means a second run
> acts as a reconciliation pass — a clean re-run with everything "skipped" is
> evidence the move was complete. `lastMessageAt` is recomputable from Message, so
> derived data can always be rebuilt and checked against source.

**Q: Why read through the raw driver instead of the Chat model?**
> The V2 schema deliberately no longer declares the old `messages` field, so
> Mongoose would strip it from query results — the script would see every chat as
> already empty and "successfully" migrate nothing. The migration is the one place
> that must see the old shape, so it's the one place that bypasses the model.

**Q: Where's the duplicate-conversation bug come from, and how is it fixed now?**
> Old code did `findOne({participants: {$all:[a,b]}})` then created a Chat if none
> existed — check-then-act. Two simultaneous opens both miss and both insert. You
> can't uniquely index the `participants` array (a multikey unique index would
> limit each user to one conversation total), so I store the two ids *sorted* as
> scalar `participantLow`/`participantHigh` and put a unique index on the pair.
> Now the duplicate is rejected by the database, not just avoided by hope.
