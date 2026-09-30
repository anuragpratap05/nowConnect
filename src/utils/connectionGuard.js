const ConnectionRequest = require("../models/connectionRequest");
const { canonicalPair } = require("../models/chat");

// Phase 3 — "are these two users actually connected?"
//
// This closes the `TODO: Check if userId & targetUserId are friends` that sat in
// src/utils/socket.js, and the matching hole in GET /chat/:targetUserId. Before
// this, any authenticated user could read any other pair's conversation and push
// messages into it just by supplying the two ids. Not a theoretical gap: the ids
// are ObjectIds that the app hands out freely in /feed and /user/connections
// responses, so the attack is "paste an id you already have".
//
// Shared between the HTTP route and the socket handlers on purpose. An
// authorization rule enforced in two places drifts — one of the two gets a fix
// the other doesn't, and the weaker path becomes the way in.

// Why this is affordable to call on the hot path (every message send, not just
// on join):
//
// Phase 2 added a unique index on {userIdLow, userIdHigh} to ConnectionRequest.
// Querying by that exact pair is a single index lookup against a unique index —
// it examines one key and at most one document, no scan, no matter how large the
// collection gets. The `status` check then happens on that one document. So the
// cost of being correct here is one point lookup per message, next to a document
// insert we are doing anyway.
//
// That is a direct dividend from Phase 2: the index was added to stop duplicate
// swipes, and it happens to be exactly the index an authorization check on a pair
// needs. Without it this query would have been an $or over {fromUserId, toUserId}
// in both directions, and "verify on every message" would have been the kind of
// cost that pushes you toward caching the decision — which is where
// authorization bugs live.
const areConnected = async (userIdA, userIdB) => {
  if (userIdA.toString() === userIdB.toString()) return false;

  const [low, high] = canonicalPair(userIdA, userIdB);

  // .exists() returns {_id} or null — it projects away everything else, so this
  // never pulls a document body over the wire just to answer a yes/no.
  const match = await ConnectionRequest.exists({
    userIdLow: low,
    userIdHigh: high,
    status: "accepted",
  });

  return Boolean(match);
};

module.exports = { areConnected };
