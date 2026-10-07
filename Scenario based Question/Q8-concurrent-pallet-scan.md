# Q8 — API & UI Resilience: Concurrent Pallet Scan

> **Category:** Hands-on coding + system design (idempotency / concurrency)
>
> **Scenario:** In the Facilities Mobile App, multiple associates may scan the
> **same pallet simultaneously**. Implement a handler that prevents duplicate scan
> records.
>
> **Task 1:** Implement idempotency logic for pallet scanning.
> **Task 2:** Discuss how you'd handle this in a distributed AWS environment
> (e.g., DynamoDB).

**Solution file:** [`Q8-concurrent-pallet-scan.ts`](Q8-concurrent-pallet-scan.ts)
(core dedup extracted as a pure function; logic verified ✓).

> **devTinder tie-in (say this — it's a real credibility lever):** I've shipped
> this exact pattern twice. devTinder's chat uses a **canonical-pair unique index**
> to make duplicate conversations *impossible* under two simultaneous opens, and
> the thumbnail worker is **idempotent via `_id` reuse** so a redelivered job can't
> double-process. Same principle as this pallet scan: *push the atomicity down to
> the storage layer; don't check-then-act in app code.*

---

## First, name the two bugs precisely

1. **TOCTOU race (time-of-check to time-of-use).** The dangerous shape is:
   ```ts
   if (!scannedPallets.has(palletId)) {
     await persistToDb(palletId);   // <-- await = a window
     scannedPallets.add(palletId);
   }
   ```
   Two concurrent requests both pass `has()` before either writes → **two
   records**. The `await` in the critical section is what opens the gap.

2. **Per-instance state.** `const scannedPallets = new Set()` lives in *one*
   process's memory. Run it behind a load balancer with 3 containers and each has
   its own Set, so a pallet scanned on instance A isn't "seen" by instance B.
   The in-memory approach **cannot** work distributed — that's what Task 2 is about.

---

## Task 1 — local (single-instance) idempotent handler

Keep the check-and-claim **synchronous** (no `await` between `has` and `add`), so
in Node's single thread it's one uninterruptible step. Do slow work *after* the
claim.

```ts
const scannedPallets = new Set<string>(); // Mock DB

app.post('/api/scan-pallet', async (req: Request, res: Response) => {
  const { palletId, associateId, timestamp } = req.body ?? {};

  // 1) Validate — never trust the body.
  if (typeof palletId !== 'string' || typeof associateId !== 'string') {
    return res.status(400).json({ success: false, error: 'palletId and associateId are required strings' });
  }

  // 2) Atomic claim: has() + add() with NO await between them.
  if (scannedPallets.has(palletId)) {
    // Idempotent: return 200, not an error. A retry / 2nd associate gets a
    // clean, repeatable answer.
    return res.status(200).json({ success: true, palletId, duplicate: true });
  }
  scannedPallets.add(palletId);

  // 3) Slow work AFTER the claim (persist, emit event…).
  console.log(`Pallet ${palletId} scanned by ${associateId} at ${timestamp ?? Date.now()}`);

  return res.status(201).json({ success: true, palletId, duplicate: false });
});
```

**Why 200 for a duplicate, not 409?** For *scanning*, the associate's intent is
"this pallet is scanned" — and it is. Returning 200 idempotently is friendlier
and makes client retries safe. Use **409 Conflict** instead when the caller must
*know* someone else won the race (e.g., to show "already scanned by Alex"). Either
is defensible — state the choice and why. The one wrong answer is a 500 or a
silent second insert.

---

## Task 2 — distributed AWS (the part they're really probing)

The in-memory Set fails across instances, so move the atomicity to **one shared,
durable store**. The clean primitive is a **DynamoDB conditional write** — it *is*
the atomic compare-and-set, so you need **no separate distributed lock**:

```ts
try {
  await ddb.send(new PutItemCommand({
    TableName: 'PalletScans',
    Item: {
      palletId:    { S: palletId },       // partition key
      associateId: { S: associateId },
      scannedAt:   { N: String(timestamp ?? Date.now()) },
    },
    // Write ONLY if no item with this palletId exists.
    ConditionExpression: 'attribute_not_exists(palletId)',
  }));
  return res.status(201).json({ success: true, palletId, duplicate: false });
} catch (err: any) {
  if (err.name === 'ConditionalCheckFailedException') {
    return res.status(200).json({ success: true, palletId, duplicate: true }); // idempotent
  }
  throw err; // genuine failure -> 5xx
}
```

**Why this is the right design:**
- **One atomic op, no read-then-write** → the TOCTOU window is gone by
  construction, not by luck.
- **Correct for any number of instances** → atomicity lives in DynamoDB, not in
  app memory.
- **No lock to acquire/release/expire** → the write *condition* is the lock, held
  and released atomically by the DB. (Distributed locks are a whole extra failure
  surface — avoid one when a conditional write will do.)

---

## Alternatives to name (shows breadth)

| Option | How | When to prefer |
|--------|-----|----------------|
| **DynamoDB conditional put** (chosen) | `attribute_not_exists(palletId)` | Default for serverless/AWS; durable + atomic, no lock. |
| **Redis `SET key NX`** | `SET pallet:{id} 1 NX EX 86400` | Very fast dedup guard; fine if a short-lived, possibly-ephemeral marker is acceptable. |
| **RDS unique constraint** | `INSERT … ON CONFLICT DO NOTHING` on `palletId` | If scans already live in a relational DB — same idea in SQL. |
| **SQS FIFO + dedup** | content-based or explicit dedup id | If scans flow through a queue; the queue dedupes a 5-min window for you. |

All four are the **same idea**: make the uniqueness constraint atomic at the
infrastructure layer, so duplicates are *impossible* rather than *unlikely*.

---

## Idempotency key — the nuance that impresses

Clarify *what* "duplicate" means:
- **Dedup by business key (pallet):** a pallet is scanned once ever →
  `palletId` is the natural idempotency key (what's shown above).
- **Dedup by request retry:** the mobile app loses signal and retries the *same*
  scan → have the client send an **`Idempotency-Key` header**, store it with the
  saved response, and on replay return the stored response (Stripe's model). This
  dedupes *network retries* even when the business action genuinely could repeat.

Mentioning both — and asking the interviewer which they mean — is the senior move.

---

## Follow-up probes (be ready)

**Q: Is there really a race in single-threaded Node?**
> Only if there's an `await` between the check and the write. `has()` then `add()`
> with nothing awaited between them can't be interrupted — Node runs it to
> completion on one thread. The race appears the instant you `await` a DB call
> inside the critical section, or the instant you run more than one process.

**Q: What if you must persist to a DB *and* keep it idempotent locally?**
> Claim first, persist after, and compensate on failure: add to the set, `await`
> the write, and if the write throws, remove it from the set so a retry can
> succeed. Better still, skip the local set entirely and let the DB's conditional
> write be the single source of truth — fewer states to keep consistent.

**Q: Two associates scan at the exact same millisecond on two instances — who wins?**
> DynamoDB serializes the two conditional writes on that partition key: exactly
> one succeeds, the other gets `ConditionalCheckFailedException`. First-writer-wins
> is decided by the DB, deterministically, with no app-level coordination.

**Q: How do you record *who* scanned first but still dedupe?**
> The first conditional put stores `associateId`. The loser catches the condition
> failure and, if it needs to show the winner, does a `GetItem` to read who holds
> it. One write + an optional read on the rare conflict path.

**Q: What about cross-item invariants (e.g., pallet + shipment must both update)?**
> A single conditional put only guards one item. For multi-item atomicity use
> `TransactWriteItems`, which applies all-or-nothing with per-item conditions.

**Q: DynamoDB cost/throughput concern?**
> Conditional writes cost the same as normal writes. The partition key is
> `palletId`, which is high-cardinality, so write load spreads well — no hot
> partition unless one pallet is scanned pathologically often.

---

## Takeaways to say in the room

1. **Diagnose both bugs by name:** the TOCTOU `await` window *and* per-instance
   state. The second is the whole reason Task 2 exists.
2. **Keep the local critical section synchronous**, return **200 idempotent** for
   duplicates (justify vs. 409).
3. **DynamoDB conditional write is the headline answer** — atomic compare-and-set,
   no distributed lock. Say "the write condition *is* the lock."
4. **Distinguish business-key dedup from retry idempotency** (Idempotency-Key).
5. If you want one memorable line: *"Make duplicates impossible at the storage
   layer with an atomic conditional write — don't check-then-act in app code."*
