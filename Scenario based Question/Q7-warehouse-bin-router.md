# Q7 — Hands-on Coding: The Warehouse Bin Router

> **Category:** Hands-on coding (optimization + error handling)
>
> **Problem:** In a Warehouse Management System, route incoming packages to the
> correct sorting bins by matching `zoneId`. The current code fails under
> high-traffic production load due to poor performance.

**Solution file:** [`Q7-warehouse-bin-router.ts`](Q7-warehouse-bin-router.ts)
(runnable, with inline tests — logic verified ✓).

```ts
interface Package { id: string; zoneId: string; }
interface Bin     { binId: string; zoneId: string; }
```

---

## Step 1 — Diagnose the given code out loud

```ts
// BUGGY: O(n^2) performance. Needs Map for O(n).
// MISSING: Error handling for packages with no matching zone.
export function routePackagesToBins(packages: Package[], bins: Bin[]): Record<string, string> {
  const routingMap: Record<string, string> = {};
  for (const pkg of packages) {       // P iterations
    for (const bin of bins) {         //   × B iterations  => O(P·B)
      if (pkg.zoneId === bin.zoneId) {
        routingMap[pkg.id] = bin.binId;
      }
    }
  }
  return routingMap;
}
```

Two problems, exactly as the prompt flags:

1. **O(P · B) time.** For *every* package it rescans *every* bin. With thousands
   of packages and thousands of bins that's millions of comparisons — which is
   why it falls over at high traffic. The fix is to **index the bins once** into
   a hash map keyed by `zoneId`, then do a single lookup per package.
2. **No handling for an unmatched zone.** A package whose `zoneId` has no bin just
   silently never appears in the result. In a warehouse that's a package that
   physically goes nowhere — you must *surface* it, not drop it.

A subtle third point worth voicing (it scores senior points): the original inner
loop has **no `break`**, so if several bins share a zone, the **last** one wins.
Any Map-based rewrite must consciously preserve or change that — don't do it by
accident.

---

## Step 2 — The optimized solution

```ts
interface RoutingResult {
  routingMap: Record<string, string>;   // packageId -> binId
  unroutablePackageIds: string[];        // packages whose zone has no bin
}

export function routePackagesToBins(
  packages: Package[],
  bins: Bin[]
): RoutingResult {
  // 1) Index bins by zone ONCE.  O(B)
  //    Last bin per zone wins — preserves the original's (no-break) behaviour.
  //    For "first wins", guard with `if (!binByZone.has(bin.zoneId))`.
  const binByZone = new Map<string, string>();
  for (const bin of bins) {
    binByZone.set(bin.zoneId, bin.binId);
  }

  const routingMap: Record<string, string> = {};
  const unroutablePackageIds: string[] = [];

  // 2) One pass over packages.  O(P)
  for (const pkg of packages) {
    const binId = binByZone.get(pkg.zoneId);
    if (binId === undefined) {
      unroutablePackageIds.push(pkg.id);   // explicit: no matching zone
      continue;
    }
    routingMap[pkg.id] = binId;
  }

  return { routingMap, unroutablePackageIds };
}
```

**Complexity:** `O(B + P)` time, `O(B + P)` space — down from `O(B · P)`. That's
the whole point: linear instead of quadratic, so it scales with traffic.

---

## Step 3 — The design decision on "error handling"

The prompt says *handle* unmatched packages but not *how*. Name the options and
pick one — that judgment is what's being tested:

| Option | Behaviour | When it's right |
|--------|-----------|-----------------|
| **Collect & return** (chosen) | Return `{ routingMap, unroutablePackageIds }` | Caller decides what to do; nothing is hidden. Best default. |
| Route to an **overflow/exceptions bin** | `routingMap[pkg.id] = "OVERFLOW"` | If the warehouse has a physical catch-all lane. |
| **Throw** | Abort the whole batch on first miss | Rarely — one bad package shouldn't fail thousands of good ones. |
| **Silently skip** | Original-ish behaviour | Almost never — this *is* the bug. |

I chose **collect & return** because in a real WMS an unroutable package is an
**operational event** — a human or an overflow lane has to deal with it — so the
function's job is to *report* it, not swallow it. (If the signature must stay
`Record<string, string>`, the honest fallback is to keep the map return but
`console.warn` / emit a metric for each miss rather than drop it blind.)

---

## Clarifying questions to ask the interviewer (do this *before* coding)

Asking these signals seniority more than the code does:

1. **Multiple bins for one zone — which wins, or is it an error?** (Drives the
   `binByZone` build: overwrite vs. guard vs. throw.)
2. **What should happen to a package with no matching zone?** (Drives the
   return shape — the table above.)
3. **Can `zoneId` collisions / duplicate package `id`s occur?** (Duplicate pkg
   ids → last write wins in a `Record`; flag if that's wrong.)
4. **Rough scale?** (Thousands vs. millions changes whether the Map approach is
   enough or whether this should be streamed / batched.)

---

## Edge cases the solution handles (call these out)

- **No bin for a package's zone** → collected in `unroutablePackageIds`.
- **Empty packages or empty bins** → returns empty structures, no crash.
- **Several bins share a zone** → deterministic "last wins," documented.
- **Duplicate package ids** → last occurrence wins in the record (flag to caller
  if that's not desired).

---

## Follow-up probes (be ready)

**Q: Why a `Map` and not a plain object for `binByZone`?**
> A `Map` is purpose-built for a dynamic key→value dictionary: real `O(1)` keyed
> ops, keys of any type, no prototype-pollution footguns (`"__proto__"` as a
> zoneId can't corrupt it), and clean iteration. A plain object works here since
> keys are strings, but `Map` states the intent and is safer with untrusted keys.

**Q: Can you make it faster than O(B + P)?**
> No — you must look at every bin at least once to index them and every package
> at least once to route it, so `O(B + P)` is the lower bound. You can't beat
> reading the input.

**Q: What if the bin list is huge but mostly reused across calls?**
> Build `binByZone` once and cache it, invalidating when bins change. Then each
> routing call is `O(P)`. For a hot WMS path that index is a perfect caching
> target (even in Redis, keyed by a bins-version).

**Q: How would you handle this at millions of packages / streaming input?**
> Keep the zone→bin map in memory (small — one entry per zone), and stream
> packages through it so you never hold all packages at once — route-and-emit per
> package. The algorithm is already streaming-friendly because routing each
> package is independent.

**Q: Concurrency — many workers routing simultaneously?**
> The `binByZone` map is read-only during routing, so it's safe to share across
> workers. Only bin *updates* need coordination; routing is embarrassingly
> parallel — shard packages across workers against the same shared index.

---

## Takeaways to say in the room

1. **Name the complexity before and after** — "O(P·B) → O(B + P)" — immediately.
2. **Treat the Map build as a conscious semantic choice** (last-vs-first wins),
   not a mechanical translation.
3. **Make the error case explicit and justify the shape** — surfacing unroutable
   packages *is* the correct production behaviour, not an afterthought.
4. **Ask the clarifying questions first** — in a real interview that's often
   worth more than the implementation.
