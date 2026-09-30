const ConnectionRequest = require("../models/connectionRequest");

// Phase 4 — "who am I accepted-connected to?", as one shared, indexed query.
//
// Why this exists as a util rather than inline in the posts routes: GET
// /user/connections has always computed this, and the posts feed now needs the
// same answer. Two copies of a graph traversal drift — one gets the index-friendly
// rewrite, one doesn't; one remembers that a connection is bidirectional, one
// forgets. This is the same argument as src/utils/connectionGuard.js (Phase 3),
// which shares the *pairwise* authorization check between the HTTP and socket
// paths. connectionGuard answers "are A and B connected"; this answers "who is A
// connected to". One-to-one vs one-to-many, same graph, same collection.
//
// The query is an $or across both directions because a connection is stored once,
// directionally: whoever swiped first is `fromUserId`. There is no "accepted
// connections" edge list — the request document IS the edge, and its direction is
// a historical artifact of who initiated, not a property of the relationship. So
// "my connections" always has to look both ways.
//
// Phase 4 added {fromUserId, status, toUserId} and {toUserId, status, fromUserId}
// to make this an index-covered read instead of the collection scan it was; the
// full reasoning (including why a half-indexed $or scans anyway) is in
// src/models/connectionRequest.js.

// Returns an array of ObjectIds — the OTHER user in every accepted connection.
//
// `.lean()` plus an explicit `{_id: 0}` projection is not a micro-optimisation
// here, it is what makes the query covered: the moment `_id` is included, the two
// indexes above no longer contain every field the projection asks for and
// MongoDB has to fetch each document to get it. One field in a projection is the
// difference between totalDocsExamined: 0 and totalDocsExamined: <result size>.
const getAcceptedConnectionIds = async (userId) => {
  const edges = await ConnectionRequest.find(
    {
      $or: [
        { fromUserId: userId, status: "accepted" },
        { toUserId: userId, status: "accepted" },
      ],
    },
    { fromUserId: 1, toUserId: 1, _id: 0 }
  ).lean();

  const me = userId.toString();

  // Deduplicated through a Map keyed by the id STRING, because ObjectId instances
  // are objects: a plain Set would treat two ObjectIds with identical bytes as two
  // distinct members. The Map's values are the real ObjectIds, so callers get
  // something they can hand straight to a Mongo query without re-casting.
  //
  // Dedup is defensive rather than load-bearing — Phase 2's unique canonical-pair
  // index means a pair can only have one request, so duplicates should be
  // impossible. "Should be impossible" plus a cheap guard is the right posture for
  // a list that feeds an authorization-adjacent query; if a legacy duplicate row
  // ever survives the backfill, the worst it does here is nothing.
  const others = new Map();
  edges.forEach((edge) => {
    const other =
      edge.fromUserId.toString() === me ? edge.toUserId : edge.fromUserId;
    others.set(other.toString(), other);
  });

  return Array.from(others.values());
};

// Deliberately NOT cached in Redis, unlike the feed's exclusion set in
// src/utils/feedCache.js. Worth writing down, because "we cached the other one"
// is the obvious follow-up question.
//
// feedCache exists because that query's cost was proportional to the user's entire
// interaction HISTORY — every swipe ever made, re-read on every feed page, growing
// without bound for the life of the account, to produce a list that was identical
// on every page of the same scroll session. Caching converted an unbounded read
// into a bounded one.
//
// This query has no such gap. After the Phase 4 indexes its cost is proportional
// to the number of accepted connections — which is the size of the answer itself,
// so there is nothing to amortise — and it reads index keys only. A cache here
// would buy one avoided round trip and cost a second source of truth that has to
// be invalidated on every accept, every reject-after-accept, and every account
// deletion. Those are exactly the invalidation paths where a stale connection list
// stops being a performance detail and becomes a privacy bug: the posts feed uses
// this list as its access-control boundary, so a stale entry means showing a
// removed connection's posts.
//
// The rule this follows: cache to fix an access pattern whose cost is unbounded,
// not to shave a millisecond off one that is already proportional to its result.
// An index was the right fix here; a cache was the right fix there.
module.exports = { getAcceptedConnectionIds };
