// Q9 — Live Throughput Monitor (React)
//
// Tasks:
//   1. Poll the throughput API every 10 seconds.
//   2. Highlight zones in red if throughput < 100 packages/hr (Tailwind).
//   3. Ensure proper cleanup of the polling interval.

import React, { useState, useEffect } from 'react';

interface ZoneStat {
  zoneId: string;
  rate: number; // packages/hr
}

const LOW_THROUGHPUT_THRESHOLD = 100; // packages/hr
const POLL_INTERVAL_MS = 10_000;

export const ThroughputMonitor = () => {
  const [stats, setStats] = useState<ZoneStat[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Guards against updating state after unmount / after the effect re-runs,
    // and against a slow earlier response overwriting a newer one.
    let cancelled = false;
    const controller = new AbortController();

    const fetchStats = async () => {
      try {
        const res = await fetch('/api/throughput', { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: ZoneStat[] = await res.json();
        if (!cancelled) {
          setStats(data);
          setError(null);
        }
      } catch (err) {
        // Ignore the abort we triggered ourselves on cleanup.
        if (!cancelled && (err as Error).name !== 'AbortError') {
          setError('Failed to load throughput');
        }
      }
    };

    fetchStats(); // fetch immediately so the first paint isn't blank for 10s
    const intervalId = setInterval(fetchStats, POLL_INTERVAL_MS);

    // TASK 3 — cleanup: stop the interval AND abort any in-flight request.
    // Without this, every remount (and React 18 StrictMode in dev) stacks a new
    // interval on top of the old one -> N requests per tick + a memory leak.
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(intervalId);
    };
  }, []); // empty deps: set the interval up exactly once

  return (
    <div className="p-4 bg-gray-50 min-h-screen">
      <h1 className="text-xl font-bold mb-4">Facility Throughput (Real-time)</h1>

      {error && (
        <p className="mb-4 text-red-600" role="alert">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {stats.map((zone) => {
          const isLow = zone.rate < LOW_THROUGHPUT_THRESHOLD;
          return (
            <div
              key={zone.zoneId}
              className={`rounded-lg border p-4 shadow-sm transition-colors ${
                isLow
                  ? 'bg-red-100 border-red-500 text-red-800'
                  : 'bg-white border-gray-200 text-gray-900'
              }`}
            >
              <h2 className="font-semibold">{zone.zoneId}</h2>
              <p className="text-2xl font-bold">{zone.rate}</p>
              <p className="text-sm text-gray-600">packages/hr</p>
              {/* Not color-alone: a text label carries the status for screen
                  readers and color-blind users (WCAG 1.4.1). */}
              {isLow && (
                <p className="mt-1 text-xs font-medium text-red-700">⚠ Below threshold</p>
              )}
            </div>
          );
        })}

        {stats.length === 0 && !error && <p className="text-gray-500">Loading…</p>}
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// REFINEMENT (mention, maybe show): self-scheduling timeout avoids overlap.
//
// setInterval fires every 10s REGARDLESS of whether the previous request
// finished. If the API ever takes >10s (exactly when the facility is busy),
// requests pile up. A recursive setTimeout that schedules the NEXT fetch only
// after the current one settles prevents overlap and clock drift:
//
//   useEffect(() => {
//     let cancelled = false;
//     let timer: ReturnType<typeof setTimeout>;
//     const tick = async () => {
//       await fetchStats();
//       if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
//     };
//     tick();
//     return () => { cancelled = true; clearTimeout(timer); };
//   }, []);
// ---------------------------------------------------------------------------
