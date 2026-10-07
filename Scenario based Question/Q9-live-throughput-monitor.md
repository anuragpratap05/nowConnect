# Q9 — Live Throughput Monitor (React)

> **Category:** Hands-on coding (React hooks, polling, cleanup)
>
> **Scenario:** Build a dashboard for the Facility Command Center to monitor
> package throughput.
>
> **Tasks:** (1) Poll the throughput API every 10s. (2) Highlight zones **red**
> when throughput `< 100 packages/hr` (Tailwind). (3) Ensure proper cleanup of the
> polling interval.

**Solution file:** [`Q9-live-throughput-monitor.tsx`](Q9-live-throughput-monitor.tsx)
(copy-paste ready).

> **devTinder tie-in (a judgment lever worth saying):** devTinder's chat is
> *push-based* — it uses WebSockets (`src/utils/socket.js`), so the server pushes
> each message instead of the client asking. Polling is the right tool *here*
> because updates are periodic (every 10s is fine) and a dashboard doesn't need
> sub-second latency. If this dashboard needed live-to-the-second numbers I'd push
> via WebSocket/SSE instead. Knowing **when to poll vs. push** is the real signal.

---

## The three things being graded

### 1. Poll every 10s — and fetch immediately

```tsx
fetchStats();                                   // immediate: don't show a blank card for 10s
const intervalId = setInterval(fetchStats, 10_000);
```

The common miss is *only* setting the interval, so the dashboard is empty until
the first tick 10 seconds later. Fetch once on mount, then poll.

### 2. Conditional red styling (Tailwind)

```tsx
const isLow = zone.rate < 100;
<div className={`rounded-lg border p-4 ${
  isLow ? 'bg-red-100 border-red-500 text-red-800'
        : 'bg-white border-gray-200 text-gray-900'
}`}>
```

A toggled class string on a derived boolean. **Bonus a11y point:** I don't rely
on color alone — I add a "⚠ Below threshold" label, because color-only status
fails color-blind and screen-reader users (WCAG 1.4.1). (Same principle as the
accessibility angle in Q3.)

### 3. Cleanup — the part most people flub

```tsx
return () => {
  cancelled = true;
  controller.abort();
  clearInterval(intervalId);
};
```

This is the headline of the question. Without `clearInterval`:
- Every remount **stacks another interval** on top of the old one → 2, 3, N
  requests every 10s.
- In **React 18 StrictMode (dev)** the effect runs twice on mount, so you get a
  duplicate interval immediately — the cleanup is what makes that safe.
- A fetch that resolves **after unmount** calls `setState` on a dead component →
  the classic warning and a small leak. The `cancelled` flag + `AbortController`
  prevent that.

---

## Why the `cancelled` flag *and* `AbortController`?

Two distinct problems:
- **`cancelled`** stops `setState` from running after the component is gone (or
  after the effect re-ran) — it guards the *state update*.
- **`AbortController`** actually *cancels the in-flight HTTP request* — it guards
  the *network*, and it also fixes a **race**: if an old slow response and a new
  fast one are in flight, aborting the old one stops it from overwriting newer
  data. (The `cancelled` flag alone would drop the stale write; abort also saves
  the wasted bandwidth.)

---

## The senior refinement: `setInterval` can overlap

`setInterval` fires every 10s **whether or not the previous request finished**.
If the API ever takes longer than 10s — which is exactly when the facility is
busiest — requests pile up on a struggling backend. A **self-scheduling
`setTimeout`** schedules the next fetch only *after* the current one settles:

```tsx
const tick = async () => {
  await fetchStats();
  if (!cancelled) timer = setTimeout(tick, 10_000);
};
tick();
return () => { cancelled = true; clearTimeout(timer); };
```

No overlap, no drift. Mentioning this unprompted is a strong signal — but say
`setInterval` is fine for the stated requirement and this is the hardening step.

---

## Follow-up probes (be ready)

**Q: Why the empty dependency array `[]`?**
> So the effect runs once — set the interval up a single time on mount and tear it
> down on unmount. If I put a value in the deps, React would clear and recreate
> the interval every time that value changed, which usually isn't what you want
> for a timer.

**Q: Your interval callback uses `setStats` — any stale-closure risk?**
> Here, no — I always replace state with the server's response, I never read the
> previous `stats` inside the callback. If I *did* need the latest state in the
> interval (e.g., to accumulate), I'd use the functional updater
> `setStats(prev => …)` or a ref, because the closure captures the `stats` from the
> render that created the interval.

**Q: How would you make this reusable / testable?**
> Extract a custom hook — `usePolling(fetchFn, intervalMs)` or `useThroughput()` —
> returning `{ data, error, loading }`. The component gets simpler and the polling
> logic becomes unit-testable with fake timers, independent of the UI.

**Q: How do you avoid hammering the API when the tab is backgrounded?**
> Pause polling on `document.visibilitychange` when `hidden`, resume on focus. Or
> use the Page Visibility API to widen the interval in the background. Saves the
> backend a lot of pointless load from idle tabs.

**Q: Would you add a loading/error UX?**
> Yes — I show a "Loading…" placeholder before the first response and an error
> banner (with `role="alert"`) if a fetch fails, while keeping the last-good data
> on screen so a single failed poll doesn't blank the dashboard.

**Q: Polling vs WebSocket/SSE here?**
> Polling fits periodic, low-frequency updates and is simplest to operate. If the
> command center needed sub-second or event-driven updates, I'd switch to a
> WebSocket or Server-Sent Events push — which is what I used for devTinder chat.
> It's a latency-vs-simplicity trade, not a "one is always better."

---

## Takeaways to say in the room

1. **Fetch immediately, then `setInterval`** — don't leave the first 10s blank.
2. **Cleanup is the whole point of task 3**: `clearInterval` + abort + a
   `cancelled` guard; call out StrictMode double-mount.
3. **Conditional Tailwind on a derived boolean**, and add a **non-color** status
   cue for accessibility.
4. **Name the `setInterval` overlap risk** and the `setTimeout` fix as hardening.
5. **Frame polling vs push as a judgment call**, citing real WebSocket experience.
