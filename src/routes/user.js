const express = require("express");
const userRouter = express.Router();

const mongoose = require("mongoose");

const { userAuth } = require("../middlewares/auth");
const ConnectionRequest = require("../models/connectionRequest");
const User = require("../models/user");
const feedCache = require("../utils/feedCache");

const USER_SAFE_DATA = "firstName lastName photoUrl age gender about skills";

// Get all the pending connection request for the loggedIn user
userRouter.get("/user/requests/received", userAuth, async (req, res) => {
  try {
    const loggedInUser = req.user;

    const connectionRequests = await ConnectionRequest.find({
      toUserId: loggedInUser._id,
      status: "interested",
    }).populate("fromUserId", USER_SAFE_DATA);
    // }).populate("fromUserId", ["firstName", "lastName"]);

    res.json({
      message: "Data fetched successfully",
      data: connectionRequests,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

userRouter.get("/user/connections", userAuth, async (req, res) => {
  try {
    const loggedInUser = req.user;

    const connectionRequests = await ConnectionRequest.find({
      $or: [
        { toUserId: loggedInUser._id, status: "accepted" },
        { fromUserId: loggedInUser._id, status: "accepted" },
      ],
    })
      .populate("fromUserId", USER_SAFE_DATA)
      .populate("toUserId", USER_SAFE_DATA);

    const data = connectionRequests.map((row) => {
      if (row.fromUserId._id.toString() === loggedInUser._id.toString()) {
        return row.toUserId;
      }
      return row.fromUserId;
    });

    res.json({ data });
  } catch (err) {
    res.status(400).send({ message: err.message });
  }
});

userRouter.get("/feed", userAuth, async (req, res) => {
  try {
    const loggedInUser = req.user;

    let limit = parseInt(req.query.limit) || 10;
    limit = limit > 50 ? 50 : limit;
    limit = limit < 1 ? 10 : limit;

    // Phase 2: CURSOR-based pagination, replacing page/skip/limit.
    //
    // Why skip/limit had to go: `.skip(n)` does not jump to the nth document.
    // MongoDB walks and discards n documents first, every time, so the cost of
    // a page grows linearly with how deep into the feed you are — page 50 does
    // roughly 50x the work of page 1 to return the same 10 profiles. Latency
    // therefore degrades precisely for the engaged users who scroll furthest.
    //
    // A cursor turns that into an index seek. `_id > lastSeenId` with
    // sort({_id: 1}) lets the index position itself directly at the right place
    // and read forward, so every page costs the same as the first regardless of
    // depth. _id is the natural cursor here: it's unique (no ties to break, so
    // no page can drop or repeat a row) and monotonic enough to sort by.
    //
    // What we give up, honestly: no random access to "page 37" and no total
    // count. For an infinite-scroll feed nobody asks for either — and the old
    // skip version was already unstable under concurrent writes, since a new
    // user inserted mid-scroll shifts every subsequent offset and makes a
    // profile appear on two pages or none.
    const cursor = req.query.cursor;
    if (cursor && !mongoose.Types.ObjectId.isValid(cursor)) {
      return res.status(400).json({ message: "Invalid cursor: " + cursor });
    }

    // Phase 2: one Redis SMEMBERS instead of re-reading the user's entire
    // connection-request history from Mongo on every feed call. Falls back to
    // the Mongo computation if Redis is unavailable, so the feed cannot break
    // because a cache is down. See src/utils/feedCache.js for the
    // fan-out-on-write reasoning and why staleness is safe here.
    //
    // The returned set always contains the requester's own id, which is why
    // there's no separate {_id: {$ne: loggedInUser._id}} clause any more.
    const hideUsersFromFeed = await feedCache.getExcludedIds(loggedInUser._id);

    const idFilter = { $nin: hideUsersFromFeed };
    if (cursor) {
      idFilter.$gt = new mongoose.Types.ObjectId(cursor);
    }

    // limit + 1: fetching one extra document is how we learn whether another
    // page exists without running a second count query.
    const users = await User.find({ _id: idFilter })
      .select(USER_SAFE_DATA)
      .sort({ _id: 1 })
      .limit(limit + 1);

    const hasMore = users.length > limit;
    const page = hasMore ? users.slice(0, limit) : users;

    res.json({
      data: page,
      // nextCursor is null at the end of the feed, so the client's stop
      // condition is "the server said there is nothing after this" rather than
      // "I got back fewer rows than I asked for" — which is an unreliable
      // signal the moment any post-query filtering is added.
      nextCursor: hasMore ? page[page.length - 1]._id : null,
      hasMore,
    });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

module.exports = userRouter;
