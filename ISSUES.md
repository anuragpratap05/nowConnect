# Known Issues — devTinder Backend

Findings from a code review of the backend (`src/`), in priority order: Security → Correctness → Scaling.

Items fixed by the scale-up phases are annotated in place rather than deleted — the original finding is the "before" half of each interview story, and the write-ups in `docs/` depend on it still being readable. Anything unannotated is still open.

## Security

1. **Hardcoded JWT secret.** [`src/models/user.js:86`](src/models/user.js:86) signs tokens with the literal string `"DEV@Tinder$790"`, but [`src/middlewares/auth.js:11`](src/middlewares/auth.js:11) verifies using `process.env.JWT_SECRET`. These only match if `JWT_SECRET` is set to that exact string. It's committed to git, so anyone who reads the code can forge a valid token for any user ID.
2. **Password hash leaks to the client.** Signup, login, `/profile/view` and `/profile/edit` all return the full user document, and the schema has no `select: false` on `password`.
3. **Webhook signature check uses the wrong body.** [`src/routes/payment.js:58`](src/routes/payment.js:58) validates against `JSON.stringify(req.body)`, but Razorpay signs the raw request bytes. Re-serialized JSON can differ from the original, so valid webhooks can fail verification. Fix: use `express.raw()` for this route and validate against the raw buffer.
4. **Webhook upgrades the user on any event.** It sets `isPremium = true` unconditionally, including on `payment.failed`. No null check if the payment record isn't found (`payment.status = ...` on `null`).
   → ✅ **Fixed in Phase 1** — handler branches on `req.body.event`, guards the lookup, and is idempotent against redeliveries. See [`docs/phase-1.md`](docs/phase-1.md).
5. **No authorization on chat.** Any logged-in user can read any chat via `GET /chat/:targetUserId`. In sockets, `userId` is supplied by the client, so anyone can send messages as anyone else. There's a `TODO: Check if userId & targetUserId are friends` in [`src/utils/socket.js:35`](src/utils/socket.js:35) marking this.
6. **Auth cookie isn't hardened.** No `httpOnly`, `secure`, or `sameSite` set on the `token` cookie. Cookie expiry (8h) also doesn't match JWT expiry (7d).
7. **Users can change their own email via edit-profile.** `validateEditProfileData` allows `emailId` in the PATCH body with no re-verification step.
8. **Secrets/PII in logs.** [`src/config/database.js:4`](src/config/database.js:4) logs the Mongo connection string. Signup logs the password hash. `/premium/verify` logs the full user object.
   → ⚠️ **Partially fixed in Phase 2** — the connection-string log is gone. The signup password-hash log and the `/premium/verify` user-object log are **still open**.

## Correctness bugs

1. **Crash in error handler.** [`src/routes/user.js:26`](src/routes/user.js:26) calls `req.statusCode(400)`, which isn't a function — any error in `/user/requests/received` throws instead of responding.
   → ✅ **Fixed in Phase 2** — now `res.status(400)`. The original throws a second `TypeError` from inside the catch block, so the request gets no response at all and hangs until the client times out.
2. **Emails never reach the real user.** [`src/utils/sendEmail.js:35-36`](src/utils/sendEmail.js:35) hardcodes the recipient to `akshaysaini.in@gmail.com` and ignores the `toEmailId` param. The cron job also calls `sendEmail.run(subject, body)` with the wrong argument shape.
   → ✅ **Fixed in Phase 1** — `toEmailId` is honoured, and the send moved onto a BullMQ worker. See [`docs/phase-1.md`](docs/phase-1.md).
3. **Shared receipt ID on every payment order.** [`src/routes/payment.js:20`](src/routes/payment.js:20) always uses `"receipt#1"`.
4. **No membership plan validation.** [`src/routes/payment.js:18`](src/routes/payment.js:18) — an unknown `membershipType` produces `NaN` as the order amount.
5. **Chat route hangs on error.** [`src/routes/chat.js:27`](src/routes/chat.js:27) only logs the error in the catch block; the request never gets a response.
6. **Hardcoded startup log.** [`src/app.js:43`](src/app.js:43) always logs "port 7777" regardless of the actual `PORT` env value.
   → ✅ **Fixed in Phase 2.**
7. **Feed can surface stale data.** It only hides users via `ConnectionRequest` history, so leftover/inconsistent state can produce odd feed results.
   → ⚠️ **Bounded in Phase 2** — the exclusion set is now a Redis cache over the same history, so it can additionally be *stale* (≤10 min TTL, kept current by fan-out-on-write). Deliberately safe: the worst outcome is an already-swiped profile reappearing, and re-swiping it is rejected by the new canonical-pair unique index with a 409. See [`docs/phase-2.md`](docs/phase-2.md).

8. **Duplicate connection requests under concurrency (found in Phase 2).** `POST /request/send` did a `findOne` existence check and then a separate `.save()` — check-then-act. Two overlapping requests both passed the check and both inserted. Triggered by a double-click *and* by two users swiping on each other at the same instant (ordinary behaviour, not abuse). Reproduced: a 10-way concurrent burst created **8 rows for one pair**; sequential testing created 1 and looked correct.
   → ✅ **Fixed in Phase 2** — unique partial index on a canonicalised `{userIdLow, userIdHigh}` pair; the pre-check is removed and `E11000` maps to `409`. Note a unique index on `{fromUserId, toUserId}` would **not** have fixed this: it misses the mutual-swipe case. See [`docs/phase-2.md`](docs/phase-2.md).

## Scaling

1. **Cron job full-scans the largest collection.** The 8 AM job in [`src/utils/cronjob.js`](src/utils/cronjob.js) filters `ConnectionRequest` by `status` + `createdAt`, but the only index is `{ fromUserId, toUserId }` — this is a `COLLSCAN` that grows with total collection size, not match size. Needs a `{ status, createdAt }` index (or a partial index on `status: "interested"`).
   → ✅ **Fixed in Phase 1** — partial covering index `{status, createdAt, toUserId}` + a rewritten covered `distinct` query. `totalDocsExamined` 8000 → 0. See [`docs/phase-1.md`](docs/phase-1.md).
2. **Feed query loads full interaction history per request.** [`src/routes/user.js:58`](src/routes/user.js:58) fetches every connection request the user has ever been part of to build the exclusion set, then does a `$nin` over it. Gets slower as a user's history grows. Skip-based pagination also degrades on deep pages.
   → ✅ **Fixed in Phase 2** — exclusion set cached in Redis (fan-out-on-write, 10-min TTL, fails open to Mongo), and skip/limit replaced by `_id` cursor pagination. `keysExamined` at page 1000: 10,021 → 11. See [`docs/phase-2.md`](docs/phase-2.md).
3. **Chat stores all messages in one embedded document.** [`src/models/chat.js`](src/models/chat.js) — MongoDB caps documents at 16MB, and every new message rewrites/reloads the entire messages array. No index on `participants` either.
4. **`userAuth` hits the DB on every request.** [`src/middlewares/auth.js:15`](src/middlewares/auth.js:15) does a `User.findById` per request with no caching layer.

---
*See also: [`src/models/connectionRequest.js`](src/models/connectionRequest.js) for the index discussion, and [`docs/phase-1.md`](docs/phase-1.md) / [`docs/phase-2.md`](docs/phase-2.md) for the full Problem → Investigation → Options → Decision → Outcome write-ups.*
