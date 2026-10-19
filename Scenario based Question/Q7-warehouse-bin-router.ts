// Q7 — Warehouse Bin Router (optimized)
//
// Run:  npx ts-node "Scenario based Question/Q7-warehouse-bin-router.ts"
//   or compile with tsc and run the emitted JS.

interface Package {
  id: string;
  zoneId: string;
}

interface Bin {
  binId: string;
  zoneId: string;
}

// Richer result so "no matching zone" is surfaced, not silently dropped.
// In a real WMS, a package that can't be routed is an operational event
// (it needs a human / an overflow bin), so hiding it would be the real bug.
interface RoutingResult {
  routingMap: Record<string, string>; // packageId -> binId
  unroutablePackageIds: string[]; // packages whose zone has no bin
}

/**
 * Route each package to a bin that serves its zone.
 *
 * Time:  O(B + P)   — build the lookup once, then one pass over packages.
 * Space: O(B + P)   — the zone→bin map plus the result.
 *
 * (The original was O(P * B): for every package it rescanned every bin.)
 */
export function routePackagesToBins(
  packages: Package[],
  bins: Bin[]
): RoutingResult {
  // 1) Index bins by zone ONCE.
  //    Last bin for a given zone wins, which preserves the original code's
  //    behaviour (its inner loop had no `break`, so later matches overwrote
  //    earlier ones). If "first bin wins" were required instead, guard with
  //    `if (!binByZone.has(bin.zoneId))`. This is a question worth asking the
  //    interviewer rather than assuming.
  const binByZone = new Map<string, string>();
  for (const bin of bins) {
    binByZone.set(bin.zoneId, bin.binId);
  }

  const routingMap: Record<string, string> = {};
  const unroutablePackageIds: string[] = [];

  // 2) Single pass over packages.
  for (const pkg of packages) {
    const binId = binByZone.get(pkg.zoneId);
    if (binId === undefined) {
      // Explicit handling for "no matching zone" — the bug the prompt flags.
      unroutablePackageIds.push(pkg.id);
      continue;
    }
    routingMap[pkg.id] = binId;
  }

  return { routingMap, unroutablePackageIds };
}

// --- Minimal inline tests (no test framework needed) ------------------------

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error(`✗ ${label}\n   expected ${e}\n   got      ${a}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${label}`);
  }
}

// Happy path
{
  const packages: Package[] = [
    { id: "p1", zoneId: "A" },
    { id: "p2", zoneId: "B" },
    { id: "p3", zoneId: "A" },
  ];
  const bins: Bin[] = [
    { binId: "bin-A", zoneId: "A" },
    { binId: "bin-B", zoneId: "B" },
  ];
  const res = routePackagesToBins(packages, bins);
  assertEqual(
    res.routingMap,
    { p1: "bin-A", p2: "bin-B", p3: "bin-A" },
    "routes each package to its zone's bin"
  );
  assertEqual(res.unroutablePackageIds, [], "nothing unroutable in happy path");
}

// Unroutable package (no bin for its zone)
{
  const res = routePackagesToBins(
    [
      { id: "p1", zoneId: "A" },
      { id: "p2", zoneId: "Z" }, // no bin for zone Z
    ],
    [{ binId: "bin-A", zoneId: "A" }]
  );
  assertEqual(res.routingMap, { p1: "bin-A" }, "routes the matchable package");
  assertEqual(res.unroutablePackageIds, ["p2"], "collects the unroutable one");
}

// Multiple bins for one zone -> last one wins (matches original semantics)
{
  const res = routePackagesToBins(
    [{ id: "p1", zoneId: "A" }],
    [
      { binId: "bin-A1", zoneId: "A" },
      { binId: "bin-A2", zoneId: "A" },
    ]
  );
  assertEqual(res.routingMap, { p1: "bin-A2" }, "last bin for a zone wins");
}

// Empty inputs
{
  const res = routePackagesToBins([], []);
  assertEqual(res.routingMap, {}, "empty inputs -> empty map");
  assertEqual(res.unroutablePackageIds, [], "empty inputs -> nothing unroutable");
}
