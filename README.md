# Now Connect

An internal social-networking backend (originally "DevTinder"): JWT auth, a
connection-request graph, a feed, payments, and real-time chat. It works
end-to-end and is now being **scaled up phase by phase** — each phase adds a
feature area that maps to a specific, defensible senior-level interview talking
point (a design decision, a trade-off, a failure mode and its fix).

See [`project_enhancement_plan.md`](project_enhancement_plan.md) for the full
plan and [`docs/`](docs) for the per-phase write-ups.

## Stack

- **Node.js / Express** — REST API (routers in `src/routes/`)
- **MongoDB / Mongoose** — primary datastore (`src/models/`)
- **Socket.io** — real-time chat (`src/utils/socket.js`)
- **Redis** — BullMQ job queue, rate limiting, Socket.io adapter _(added Phase 0)_
- **MinIO / S3** — object storage for post images _(added Phase 0)_
- **Razorpay + AWS SES** — payments and transactional email

## Getting started

```bash
# 1. Install dependencies
npm install

# 2. Start the new infra (Redis + MinIO). Mongo stays on its own local/Atlas setup.
docker compose up -d
# No Docker? Run them natively instead (see "Local infra" below).

# 3. Configure env
cp .env.example .env   # then edit values

# 4. Run the API
npm run dev            # nodemon
# or
npm start
```

- API: `http://localhost:7777`
- MinIO console: `http://localhost:9001` (login `minioadmin` / `minioadmin`)

## Local infra (Phase 0)

`docker-compose.yml` runs the two backing services the scale-up work depends on:

| Service | Port | Used by |
|---------|------|---------|
| Redis   | 6379 | BullMQ queue (Phase 1), rate limiter (Phase 2), Socket.io adapter (Phase 3) |
| MinIO   | 9000 (API), 9001 (console) | Post image uploads (Phase 4) |

Shared clients live in `src/config/`:
- `src/config/redis.js` — a single `ioredis` client
- `src/config/s3.js` — an `@aws-sdk/client-s3` client (MinIO locally, real S3 in prod)

### No Docker? Run natively (macOS / Homebrew)

The app only depends on the service endpoints, so a native install works
identically:

```bash
brew services start redis                 # Redis on :6379
brew install minio && mkdir -p ~/minio-data
MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
  minio server ~/minio-data --console-address ":9001"   # MinIO on :9000 / :9001
```

## API reference

See [`apiList.md`](apiList.md).

## Roadmap

| Phase | Focus |
|-------|-------|
| 0 | Shared infra: Docker Compose (Redis + MinIO), config clients, env, deps ✅ |
| 1 | Async processing (BullMQ) + a real cron/index incident story |
| 2 | Membership-tier rate limiting + cursor-based feed pagination |
| 3 | Chat at scale: separate `Message` collection + Socket.io Redis adapter |
| 4 | Posts with images via pre-signed S3 uploads |
| 5 | Future scaling roadmap (write-up only) |
