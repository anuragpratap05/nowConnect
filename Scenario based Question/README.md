# Scenario-Based Interview Questions

A running log of behavioral / system-design interview questions, answered using
**devTinder** as the backdrop.

Some scenarios map to features that already exist in the codebase; others are
grounded in **common production bottlenecks** and tied to features that are
**not yet implemented** but are realistic **future scope** for this project.
Each "future scope" scenario is clearly marked so I never claim in an interview
that something is already shipped when it isn't.

## How to use this

1. Read the **Scenario** to recall the setup.
2. Rehearse the **STAR answer** out loud — that's the part the interviewer hears.
3. Skim **Why this answer works** to hit the signals the question is really testing.
4. Read the **Technical appendix** so you can survive follow-up probes ("how
   exactly would you implement that?").

## Index

| # | Question theme | Scenario anchor | Status |
|---|----------------|-----------------|--------|
| 2 | Values, Leadership & Culture — identifying a bottleneck and leading the fix unasked | Notification / activity-feed fan-out (celebrity hot-key problem) | 🔮 Future scope |
| 3 | Pushing back on a Product/Design requirement (performance / accessibility) | Premium "See who liked you" screen — unbounded load vs. paginated + thumbnails | 🔮 Future scope |
| 4 | Code reviews & mentoring juniors without becoming a bottleneck | Philosophy + practices (automate / push-left / distribute approval) | 💭 Philosophy |
| 5 | Optimizing a workflow for a user + measuring success | Presigned direct-to-S3 upload + async thumbnail pipeline | ✅ Implemented |
| 6 | High-impact feature, shifting requirements, ensuring quality | Chat V1→V2 redesign (embedded → Message collection) + live idempotent migration | ✅ Implemented |
| 7 | Hands-on coding — Warehouse Bin Router (fix O(n²), add error handling) | Hash-map indexing: O(P·B) → O(B+P) + surface unroutable packages | 💻 Coding |
| 8 | API resilience — Concurrent Pallet Scan (idempotency + distributed) | TOCTOU + per-instance state → DynamoDB conditional write (atomic, lock-free) | 💻 Coding |
| 9 | React — Live Throughput Monitor (polling dashboard) | useEffect polling + interval cleanup + conditional Tailwind; poll-vs-push judgment | 💻 Coding |

Legend: ✅ Implemented · 🔮 Future scope (not yet built, used as a realistic hypothetical) · 💭 Philosophy / approach question (no single story) · 💻 Coding exercise
