# Phase 0 — Shared Infrastructure

> One-line summary: stood up the new backing services (Redis + S3-compatible
> object storage) and the shared client code that Phases 1–4 all build on, so no
> later phase has to re-litigate "how do we talk to Redis / S3."

This is a **foundation** phase — no user-facing behaviour changed. Its value is
that every later phase (job queue, rate limiter, socket adapter, image uploads)
now has a single, consistent place to get a Redis or S3 client, and a one-command
way to run the infra locally.

---

## What we did (step by step)

### 1. Branch
Created `Phase0` off `dev`. Each phase is developed on its own branch so the git
history stays a clean, per-phase narrative (this matters for the interview
story in later phases — e.g. the chat model migration in Phase 3 needs a real
"before" diff to point to).

### 2. `docker-compose.yml` — local infra, one command
Added a Compose file at the project root running two services:

| Service | Image | Ports | Why |
|---------|-------|-------|-----|
| `redis` | `redis:7-alpine` | 6379 | BullMQ queue (Phase 1), rate limiter (Phase 2), Socket.io adapter (Phase 3) |
| `minio` | `minio/minio` | 9000 (S3 API), 9001 (console) | Post image storage (Phase 4) |

- **MongoDB is deliberately not in Compose** — it stays on its existing local
  install / Atlas cluster, unchanged. The plan is to *add* infra, not migrate
  what already works.
- Named volumes (`redis-data`, `minio-data`) so data survives `docker compose down`.
- MinIO is S3-compatible, so we develop against the exact same AWS SDK we'll use
  in production — no code changes between local and prod, only env vars.

Run it with:
```bash
docker compose up -d
```

### 3. `src/config/redis.js` — one shared ioredis client
A single `ioredis` client, exported the same way `sesClient.js` exports its
client, so it's reused everywhere instead of each feature opening its own
connection. Two deliberate options:
- `maxRetriesPerRequest: null` — **required by BullMQ** for its blocking
  commands (Phase 1 would fail without it).
- `lazyConnect: true` — the socket isn't opened at `require()` time, so merely
  importing the module never throws when Redis isn't running yet. Verified:
  loading the module reports status `wait` (not connected) rather than erroring.

### 4. `src/config/s3.js` — one S3 client (MinIO local, real S3 in prod)
An `@aws-sdk/client-s3` client mirroring the existing `sesClient.js` pattern
(same AWS SDK v3 family already used for SES). The one MinIO-specific detail:
- `forcePathStyle: true` when `S3_ENDPOINT` is set — MinIO addresses buckets as
  `endpoint/bucket`, whereas real S3 uses virtual-host style `bucket.endpoint`.
- In production you simply **leave `S3_ENDPOINT` unset** and the same code talks
  to real AWS S3. No branching in application logic.

### 5. New dependencies
Installed: `ioredis`, `bullmq`, `@aws-sdk/client-s3`,
`@aws-sdk/s3-request-presigner`, `@socket.io/redis-adapter`, and `redis` (v4,
which the Socket.io adapter needs for its pub/sub pair, separate from ioredis).

### 6. Environment
Extended `.env` with `REDIS_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`,
`S3_ACCESS_KEY`, `S3_SECRET_KEY`. Also added a committed **`.env.example`**
(since `.env` is gitignored) so the required keys are discoverable.

### 7. Cosmetic rename + README
- `package.json` `name` → `now-connect`, `description` updated to the "Now
  Connect" framing.
- Added a proper `README.md` (stack, getting-started, infra table, roadmap),
  replacing the course-checklist framing of `homework.md`.

---

## Design decisions (interview-ready)

**Why one shared Redis client instead of per-feature clients?**
Connection count is a real resource on Redis. A single multiplexed `ioredis`
client handles all non-blocking commands (rate limiter, general use) fine.
BullMQ and the Socket.io adapter each need their *own* dedicated connections
(BullMQ's blocking `BRPOPLPUSH`, the adapter's pub/sub pair) — so those get
separate connections in their own phases, but everything else reuses the one in
`config/redis.js`. The point: default to sharing, split only where the library
semantically requires it.

**Why MinIO locally instead of just using a folder on disk?**
The whole value of Phase 4's pre-signed-upload story is that it's the *real* S3
flow (client uploads directly to object storage, backend never proxies bytes).
A local filesystem wouldn't exercise pre-signed URLs at all, so the interview
answer would be hypothetical. MinIO is S3-compatible, so the code is identical
to production and the trade-off is genuinely demonstrated.

**Why `lazyConnect` on the Redis client?**
Fail-soft on import. A missing/down Redis shouldn't crash the process at
startup or make unit tests that merely `require()` a module explode — the
connection error surfaces at first use, where it can be handled (this also sets
up the Phase 2 "fail-open if Redis is unreachable" decision).

---

## Running the infra without Docker (macOS)

Docker Desktop wasn't an option on this machine (macOS version constraint), so
Redis and MinIO are run **natively via Homebrew** instead. This is transparent
to the application: the code only ever talks to `localhost:6379` and
`localhost:9000`, so it can't tell whether those are backed by Docker containers
or native processes. `docker-compose.yml` is still committed as the documented,
portable way to bring the same stack up on any machine that does have Docker.

```bash
# Redis (already installed via brew)
brew services start redis

# MinIO
brew install minio
mkdir -p ~/minio-data
MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  minio server ~/minio-data --console-address ":9001"
```

> **Interview note:** "Docker Desktop wasn't available on my machine, so I ran
> the dependencies natively with Homebrew. Because the app only depends on the
> service *endpoints* (`localhost:6379`, `localhost:9000`), the choice of runner
> is an environment detail, not a code detail — the Compose file is still there
> for anyone who wants the one-command path." That's a legitimate
> environment-vs-code separation answer.

## Verification

All verified **live** (not just structurally), through the app's own config
clients rather than external CLIs:

- ✅ **Redis** — `src/config/redis.js` connects to the running server: `PING` →
  `PONG`, a `SET`/`GET` roundtrip returns the value, client status `ready`.
- ✅ **MinIO / S3** — `src/config/s3.js` (with `forcePathStyle: true`) creates the
  `now-connect-posts` bucket, lists it, and completes a `PutObject`/`GetObject`
  roundtrip. Confirms the AWS SDK v3 client talks to MinIO correctly.
- ✅ Both modules also `require()` cleanly before any connection (Redis lazy
  `wait` state) — importing never throws when the services are down.
- ✅ `docker-compose.yml` structurally valid (two services, ports 6379 / 9000 /
  9001, named volumes) — kept as the portable alternative.
- ✅ Dependencies present in `package.json`.

---

## Files added / changed

| File | Change |
|------|--------|
| `docker-compose.yml` | **new** — Redis + MinIO |
| `src/config/redis.js` | **new** — shared ioredis client |
| `src/config/s3.js` | **new** — S3/MinIO client |
| `.env` | added Redis + S3 vars |
| `.env.example` | **new** — committed template |
| `package.json` | renamed to `now-connect`; new deps |
| `README.md` | **new** — replaces `homework.md` framing |
| `docs/phase-0.md` | **new** — this write-up |

## Anticipated interviewer follow-up questions

These are the questions a mid/senior interviewer is likely to ask about the
Phase 0 choices, with the short answer to have ready. (Answering the *why*
behind an infra decision is what separates "I followed a tutorial" from "I made
a decision.")

**Q: Why Redis at all — couldn't you do rate limiting / queues in Mongo?**
You could, but they're the wrong tool for hot, ephemeral, high-write state.
Rate-limit counters are write-every-request and short-lived — that's exactly
Redis's atomic-`INCR`-with-TTL sweet spot, and it keeps that load *off* the
primary datastore. A job queue needs blocking pops and atomic move-between-lists
semantics that Mongo doesn't give you cleanly. Redis is one dependency that
serves three needs (queue, rate limit, socket pub/sub), so the marginal cost is
low.

**Q: Why MinIO instead of just storing images in Mongo/GridFS or on disk?**
Object storage is the right home for large binary blobs — it keeps them out of
the database (which should hold structured, queryable data) and off the app
server's local disk (which doesn't survive a redeploy and doesn't scale
horizontally). MinIO is S3-compatible, so the code is identical to production
AWS S3 — the local/prod difference is one env var (`S3_ENDPOINT`), not a code
branch.

**Q: Why one shared Redis client but separate ones for BullMQ / the socket adapter?**
Default to sharing to conserve connections; split only where the library's
semantics force it. BullMQ's blocking commands and the Socket.io adapter's
pub/sub each monopolise a connection, so those get dedicated ones in their own
phases. Everything else multiplexes over the single client in `config/redis.js`.

**Q: What happens if Redis is down?**
Import never throws (`lazyConnect`), so the process still boots. The behaviour
at *use* time is a per-feature decision: the Phase 2 rate limiter will
**fail-open** (allow the request, log a warning) because a swipe limit isn't
worth a 500; a payment-critical path would fail-closed. That "fail-open vs
fail-closed depends on what the check protects" reasoning is the real answer.

**Q: Why `forcePathStyle: true`?**
MinIO addresses buckets as `endpoint/bucket` (path style); real S3 uses
virtual-host style `bucket.endpoint`. The flag is on only when `S3_ENDPOINT` is
set (i.e. local MinIO), so production against real S3 uses the default.

**Q: Why Docker Compose if you ran it natively anyway?**
The app depends on service *endpoints*, not on how they're started — so the
runner is an environment detail. Compose is the portable, declarative record of
*what* the services are (versions, ports, volumes); the native `brew` commands
were just the local execution path because Docker Desktop wasn't available on
this Mac. Having both shows I understand the separation.

**Q: Why BullMQ and not Kafka / SQS?**
Scale-appropriate choice. Current volume doesn't justify Kafka's operational
weight — reaching for it now would be over-engineering. BullMQ on the Redis we
already run covers retries and backoff, which is what this app needs. The
*signal* that would make me revisit (durability/replay needs, multiple consumer
groups) is written down in the Phase 5 roadmap — deferring it deliberately is
itself the senior answer.

---

## Next: Phase 1
Async processing with BullMQ + the real cron/index incident story (the
`ConnectionRequest` full-collection-scan bug). Phase 1 is the first consumer of
`src/config/redis.js`.
