const express = require("express");
const mongoose = require("mongoose");
const { userAuth } = require("../middlewares/auth");
const { Chat } = require("../models/chat");
const Message = require("../models/message");
const { areConnected } = require("../utils/connectionGuard");

const chatRouter = express.Router();

// Same shape as the feed's limit handling in src/routes/user.js — a client can
// ask for less, cannot ask for more than the ceiling, and a garbage value falls
// back to the default instead of becoming NaN and returning the whole collection.
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// GET /chat/:targetUserId?before=<messageId>&limit=50
//
// Phase 3 rewrite. What this route used to do, and why each part had to change:
//
//   1. It returned the ENTIRE conversation — `findOne(...).populate("messages
//      .senderId")` with no pagination. One request for a year-old conversation
//      is a multi-megabyte response that the client renders none of; the user
//      only ever sees the last screenful.
//   2. It CREATED a Chat document, with a `.save()`, on a GET. A read that writes
//      is wrong on its own terms (not idempotent, not cacheable, fails against a
//      read-only replica), and here it also meant merely *viewing* a profile's
//      chat page left a row behind for a conversation that never happened.
//   3. It had NO authorization check. `targetUserId` came straight from the URL,
//      so any logged-in user could read any pair's messages.
//   4. Its catch block called `console.error(err)` and nothing else — no
//      response, ever. The request hung until the client timed out. (ISSUES.md,
//      Correctness #5.)
chatRouter.get("/chat/:targetUserId", userAuth, async (req, res) => {
  try {
    const { targetUserId } = req.params;
    const userId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(targetUserId)) {
      return res
        .status(400)
        .json({ message: "Invalid user id: " + targetUserId });
    }

    // Authorization before anything else touches chat data. 403 rather than 404
    // is a deliberate choice here: the requester already knows this user exists
    // (they got the id from a feed or connections response), so hiding existence
    // buys nothing, and a clear "you are not connected" is what the client needs
    // to render the right thing.
    if (!(await areConnected(userId, targetUserId))) {
      return res.status(403).json({
        message: "You can only read conversations with your connections.",
      });
    }

    let limit = parseInt(req.query.limit) || DEFAULT_LIMIT;
    limit = limit > MAX_LIMIT ? MAX_LIMIT : limit;
    limit = limit < 1 ? DEFAULT_LIMIT : limit;

    const { before } = req.query;
    if (before && !mongoose.Types.ObjectId.isValid(before)) {
      return res.status(400).json({ message: "Invalid cursor: " + before });
    }

    // Read-only lookup — no upsert. A pair who has never spoken has no Chat
    // document, and the honest answer to "show me our history" is an empty page,
    // not a side effect. The Chat document gets created when someone actually
    // opens the conversation over a socket (see src/utils/socket.js).
    const chat = await Chat.findOne({
      participants: { $all: [userId, targetUserId] },
    }).select("_id");

    if (!chat) {
      return res.json({ chatId: null, data: [], nextCursor: null, hasMore: false });
    }

    // Cursor pagination, walking BACKWARDS through history.
    //
    // The feed in Phase 2 pages forward with `_id > cursor`; chat is the mirror
    // image — a client opens at the newest message and scrolls up into the past —
    // so it's `_id < before` with a descending sort. Both are served by an index
    // range scan that positions directly at the cursor, so page 100 of a
    // conversation costs the same as page 1. `.skip(n)` would have made scrolling
    // up through a long history progressively slower exactly as the user gets
    // further from the bottom.
    const query = { chatId: chat._id };
    if (before) {
      query._id = { $lt: new mongoose.Types.ObjectId(before) };
    }

    // limit + 1 to learn whether an older page exists without a second count
    // query — same trick as the feed.
    const messages = await Message.find(query)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .populate("senderId", "firstName lastName")
      .lean();

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;

    res.json({
      chatId: chat._id,
      // Returned oldest-first so the client can render the array top-to-bottom
      // as-is. The QUERY has to run newest-first — that's the only direction a
      // cursor into the past can walk — so the reversal happens here, on a page
      // of at most `limit` items, rather than asking every client to do it.
      data: page.slice().reverse(),
      // `page` is still newest-first, so its LAST element is the oldest message
      // on this page — which is exactly the `before` cursor for the next (older)
      // page. Null when there is nothing older, so the client's stop condition is
      // "the server said there is nothing before this" rather than a row count.
      nextCursor: hasMore ? page[page.length - 1]._id : null,
      hasMore,
    });
  } catch (err) {
    // The old catch logged and returned nothing, hanging the request. Always
    // respond.
    console.error("[GET /chat] failed:", err);
    res.status(400).json({ message: err.message });
  }
});

module.exports = chatRouter;
