const socketio = require("socket.io");
const mongoose = require("mongoose");
const cookie = require("cookie");
const jwt = require("jsonwebtoken");
const { createAdapter } = require("@socket.io/redis-adapter");

const redisClient = require("../config/redis");
const User = require("../models/user");
const { Chat } = require("../models/chat");
const Message = require("../models/message");
const { areConnected } = require("../utils/connectionGuard");

const MAX_MESSAGE_LENGTH = 2000;

// The room a conversation's sockets join.
//
// V1 derived the room name as sha256(sorted([userId, targetUserId])) — a way to
// get a name both sides agree on without a database lookup. That's gone, because
// the Chat document IS the pair's canonical identity now (see
// src/models/chat.js), and we have to load it anyway to write a message. Deriving
// the room from the row removes a second, parallel notion of "which conversation
// is this" — and a readable room name is worth a lot when you're debugging
// delivery across two instances, where an opaque hash tells you nothing.
const roomFor = (chatId) => `chat:${chatId}`;

// Validate the one client-supplied id both handlers accept, before it reaches
// Mongo. Without this an id of the wrong shape becomes a CastError deep in the
// query and surfaces to the user as the same opaque "could not send" as a real
// failure. Returns an error string, or null when the id is usable.
const validateTarget = (userId, targetUserId) => {
  if (!targetUserId) return "targetUserId is required.";
  if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
    return "Invalid user id: " + targetUserId;
  }
  if (targetUserId.toString() === userId.toString()) {
    return "You cannot chat with yourself.";
  }
  return null;
};

// ---------------------------------------------------------------------------
// Handshake authentication.
//
// This is the security fix that matters most in this phase. V1 took `userId`
// from the event payload:
//
//     socket.on("sendMessage", async ({ firstName, userId, targetUserId, text })
//
// The client says who it is. Any connected browser could send a message as any
// user by editing one field — full impersonation, no credentials needed, and the
// message persists to the database attributed to the victim. The HTTP side of the
// app never had this problem because `userAuth` derives the identity from a signed
// JWT; the socket side simply never got the same treatment.
//
// `io.use` is the socket equivalent of that middleware: it runs once per
// connection, before any event handler can fire, and a `next(err)` rejects the
// connection outright. From here on, `socket.user` is the ONLY source of the
// sender's identity, and `userId` in an event payload is ignored entirely.
//
// Doing it per-connection rather than per-event is the right granularity: a
// socket's identity cannot change mid-connection, so verifying the token 500 times
// for 500 messages would buy nothing. The cost is that a token which expires
// mid-session stays usable until the socket drops — bounded, and the same
// trade-off every WebSocket app makes.
const authenticateSocket = async (socket, next) => {
  try {
    const rawCookie = socket.handshake.headers.cookie;
    if (!rawCookie) {
      return next(new Error("UNAUTHORIZED: no cookie sent"));
    }

    const { token } = cookie.parse(rawCookie);
    if (!token) {
      return next(new Error("UNAUTHORIZED: no token cookie"));
    }

    // Same secret and same claim shape as src/middlewares/auth.js — one identity
    // mechanism for the whole app, not a second one invented for sockets.
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded._id).select("firstName lastName");
    if (!user) {
      return next(new Error("UNAUTHORIZED: user not found"));
    }

    socket.user = user;
    next();
  } catch (err) {
    // Deliberately opaque to the client (it gets "UNAUTHORIZED"), specific in the
    // log. Telling a caller whether a token was malformed, expired, or simply
    // belonged to a deleted user is free reconnaissance.
    console.error("[socket] handshake rejected:", err.message);
    next(new Error("UNAUTHORIZED"));
  }
};

// ---------------------------------------------------------------------------
// Cross-instance delivery.
//
// Socket.io rooms are, by default, a Map in the process's memory. With one Node
// process that is invisible; with two it silently breaks, and it breaks in the
// way that's hardest to catch: `io.to(room).emit(...)` on instance A reaches only
// the sockets A itself is holding, so if the two participants' browsers happened
// to connect to different instances, each sees their own messages and none of the
// other's. No error is raised anywhere. It works perfectly in development, on one
// process, and starts losing messages the moment you scale out or put a second
// pod behind a load balancer — which is exactly when you can least afford to be
// debugging it.
//
// The Redis adapter replaces that in-memory map with Redis pub/sub: every emit is
// published to a channel all instances subscribe to, so a room spans the fleet.
//
// Two SEPARATE connections, not the shared client from src/config/redis.js: a
// Redis connection in subscriber mode may only issue (P)SUBSCRIBE/UNSUBSCRIBE, so
// a client used for SUBSCRIBE cannot also serve the rate limiter's INCR or
// BullMQ's commands. `duplicate()` gives us new connections that inherit the same
// URL and options, so there is still exactly one place configuring how we reach
// Redis.
const attachRedisAdapter = (io) => {
  const pubClient = redisClient.duplicate();
  const subClient = redisClient.duplicate();

  // Without these listeners an ioredis connection error on a duplicated client
  // surfaces as an unhandled 'error' event and takes the process down — the
  // adapter being unavailable would become the API being unavailable.
  pubClient.on("error", (err) =>
    console.error("[socket] Redis pub client error:", err.message)
  );
  subClient.on("error", (err) =>
    console.error("[socket] Redis sub client error:", err.message)
  );

  io.adapter(createAdapter(pubClient, subClient));

  // Note on failure mode, since it's the obvious follow-up question: if Redis
  // goes down, the adapter keeps delivering to sockets on the LOCAL instance and
  // silently stops delivering across instances. That is fail-open, and it's the
  // right default for chat — a degraded conversation beats a dead one — but it
  // IS a silent degradation, so these logs are the only signal, and in production
  // this is what you alert on.
  return { pubClient, subClient };
};

const initializeSocket = (server) => {
  const io = socketio(server, {
    cors: {
      origin: "http://localhost:5173",
      // Required now that identity comes from a cookie: without it the browser
      // will not attach cookies to the cross-origin handshake and every
      // connection is rejected as unauthenticated.
      credentials: true,
    },
  });

  attachRedisAdapter(io);
  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    const { _id: userId, firstName, lastName } = socket.user;

    // joinChat — open a conversation.
    //
    // `targetUserId` is the only thing we still take from the client, and it is
    // authorized rather than trusted: the pair must have an accepted connection
    // request. This is the TODO that src/utils/socket.js carried
    // ("Check if userId & targetUserId are friends") and that ISSUES.md lists
    // under Security #5.
    // The `= {}` default matters: a client that emits the event with no payload
    // would otherwise throw on destructuring, and an exception thrown
    // synchronously out of a socket handler is not caught by the try/catch inside
    // it — it becomes an unhandled rejection.
    socket.on("joinChat", async (payload = {}) => {
      try {
        const { targetUserId } = payload;

        const invalid = validateTarget(userId, targetUserId);
        if (invalid) {
          return socket.emit("chatError", { message: invalid });
        }

        if (!(await areConnected(userId, targetUserId))) {
          return socket.emit("chatError", {
            message: "You can only chat with your connections.",
          });
        }

        // Atomic upsert — see Chat.findOrCreateForPair. Creating the conversation
        // here (on a deliberate "open this chat" action) rather than in the GET
        // route is what let the read path become side-effect free.
        const chat = await Chat.findOrCreateForPair(userId, targetUserId);

        socket.join(roomFor(chat._id));
        socket.emit("chatJoined", { chatId: chat._id });
      } catch (err) {
        console.error("[socket] joinChat failed:", err);
        socket.emit("chatError", { message: "Could not open chat." });
      }
    });

    // sendMessage — note the payload: firstName, lastName and userId are NOT read
    // from it any more. The sender's identity and display name come from
    // socket.user, established at handshake time.
    socket.on("sendMessage", async (payload = {}) => {
      try {
        const { targetUserId, text } = payload;

        // Validate before authorizing, so a malformed message costs no database
        // work at all.
        const invalid = validateTarget(userId, targetUserId);
        if (invalid) {
          return socket.emit("chatError", { message: invalid });
        }

        if (typeof text !== "string" || text.trim().length === 0) {
          return socket.emit("chatError", { message: "Message is empty." });
        }

        const body = text.trim();
        if (body.length > MAX_MESSAGE_LENGTH) {
          return socket.emit("chatError", {
            message: `Message too long (max ${MAX_MESSAGE_LENGTH} characters).`,
          });
        }

        // Re-checked on every send, not cached from joinChat. Caching the
        // decision on the socket would be cheaper, but it would mean a user who
        // loses the connection mid-session keeps writing to the conversation for
        // as long as their tab stays open. This costs one point lookup against
        // the Phase 2 unique pair index (see src/utils/connectionGuard.js) next
        // to an insert we're doing anyway, so the cheaper option isn't worth the
        // stale-authorization window.
        if (!(await areConnected(userId, targetUserId))) {
          return socket.emit("chatError", {
            message: "You can only chat with your connections.",
          });
        }

        const chat = await Chat.findOrCreateForPair(userId, targetUserId);

        // O(1) append. The whole point of the phase: this insert writes one small
        // document and touches one index entry, whatever the conversation's
        // length. The V1 equivalent (`chat.messages.push(); chat.save()`) sent the
        // entire message history back to the server on every send.
        const message = await Message.create({
          chatId: chat._id,
          senderId: userId,
          text: body,
        });

        // Maintain the conversation-list sort key. Deliberately NOT in a
        // transaction with the insert above:
        //   - The message is the durable fact; lastMessageAt is derived from it
        //     and recomputable at any time (the migration script does exactly
        //     that), so the worst case of this update failing is a conversation
        //     sorting slightly low in a list. Losing the message would be real
        //     data loss; losing a sort hint is cosmetic.
        //   - A multi-document transaction needs a replica set, doubles the write
        //     latency on the hottest path in the feature, and would make the
        //     message fail to send because a cosmetic field couldn't be updated.
        // Ordering matters too: message first, then metadata. The reverse would
        // leave a conversation advertising activity that isn't there.
        await Chat.updateOne(
          { _id: chat._id },
          { $set: { lastMessageAt: message.createdAt } }
        );

        // Emitted through the adapter, so this reaches participants connected to
        // ANY instance, not just this one. Sending the ids and the timestamp (V1
        // sent only firstName/lastName/text) is what lets a client de-duplicate,
        // order messages, and use the newest _id as a pagination cursor.
        io.to(roomFor(chat._id)).emit("messageReceived", {
          _id: message._id,
          chatId: chat._id,
          senderId: userId,
          firstName,
          lastName,
          text: message.text,
          createdAt: message.createdAt,
        });
      } catch (err) {
        // V1 swallowed this with a bare console.log, so a failed send looked
        // identical to a successful one from the client's side — the message just
        // never appeared. Telling the sender is the difference between "the app is
        // broken" and "retry".
        console.error("[socket] sendMessage failed:", err);
        socket.emit("chatError", { message: "Message could not be sent." });
      }
    });

    socket.on("disconnect", () => {});
  });

  return io;
};

module.exports = initializeSocket;
