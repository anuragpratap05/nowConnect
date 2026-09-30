const express = require("express");
const mongoose = require("mongoose");
const requestRouter = express.Router();

const { userAuth } = require("../middlewares/auth");
const { swipeRateLimiter } = require("../middlewares/rateLimiter");
const ConnectionRequest = require("../models/connectionRequest");
const User = require("../models/user");
const feedCache = require("../utils/feedCache");

requestRouter.post(
  "/request/send/:status/:toUserId",
  userAuth,
  // Phase 2: the limiter sits AFTER userAuth (it keys off req.user) and BEFORE
  // the handler, so a rate-limited request costs one Redis INCR and never
  // reaches Mongo at all. Putting it any later would mean the abuse we're
  // trying to block still gets to do its database reads first.
  swipeRateLimiter,
  async (req, res) => {
    try {
      const fromUserId = req.user._id;
      const toUserId = req.params.toUserId;
      const status = req.params.status;

      const allowedStatus = ["ignored", "interested"];
      if (!allowedStatus.includes(status)) {
        return res
          .status(400)
          .json({ message: "Invalid status type: " + status });
      }

      // Validate the id shape before it reaches Mongo — otherwise a malformed
      // id surfaces as a CastError, which the catch block below would report as
      // a confusing 400 about BSON rather than "that's not a user id".
      if (!mongoose.Types.ObjectId.isValid(toUserId)) {
        return res.status(400).json({ message: "Invalid user id: " + toUserId });
      }

      // Projected: the only field this handler needs from the target user is
      // firstName, for the response message. No reason to pull the whole
      // document (including its password hash) to read one string.
      const toUser = await User.findById(toUserId).select("firstName");
      if (!toUser) {
        return res.status(404).json({ message: "User not found!" });
      }

      // Phase 2 concurrency fix — the findOne() "does a request already exist?"
      // check that used to be here is GONE, not merely supplemented.
      //
      // It was check-then-act: the gap between reading "no request exists" and
      // writing one is a window in which another request can do exactly the
      // same thing, and both then insert. Keeping the pre-check as a fast path
      // would leave that window open (it only narrows it) while still costing a
      // query on every swipe. The unique index on the canonical pair is the
      // actual guarantee, so we let the write attempt BE the check — one round
      // trip instead of two, and correct under concurrency instead of
      // usually-correct.
      const connectionRequest = new ConnectionRequest({
        fromUserId,
        toUserId,
        status,
      });

      const data = await connectionRequest.save();

      // Fan-out-on-write: keep both users' cached feed-exclusion sets current.
      // Awaited but never throws (see src/utils/feedCache.js) — the request is
      // already committed by this point.
      await feedCache.addInteraction(fromUserId, toUserId);

      res.json({
        message:
          req.user.firstName + " is " + status + " in " + toUser.firstName,
        data,
      });
    } catch (err) {
      // E11000 from the {userIdLow, userIdHigh} unique index is not a server
      // error — it's the expected, correct outcome when a request for this pair
      // already exists, whether it was created a week ago or 3ms ago by a
      // concurrent duplicate. Translating it to 409 Conflict is what makes
      // relying on the index (instead of a pre-check) safe: the loser of a race
      // gets the same clean answer a sequential duplicate would.
      if (err.code === 11000) {
        return res
          .status(409)
          .json({ message: "Connection Request Already Exists!!" });
      }

      res.status(400).send("ERROR: " + err.message);
    }
  }
);

requestRouter.post(
  "/request/review/:status/:requestId",
  userAuth,
  async (req, res) => {
    try {
      const loggedInUser = req.user;
      const { status, requestId } = req.params;

      const allowedStatus = ["accepted", "rejected"];
      if (!allowedStatus.includes(status)) {
        return res.status(400).json({ messaage: "Status not allowed!" });
      }

      if (!mongoose.Types.ObjectId.isValid(requestId)) {
        return res
          .status(400)
          .json({ message: "Invalid request id: " + requestId });
      }

      const connectionRequest = await ConnectionRequest.findOne({
        _id: requestId,
        toUserId: loggedInUser._id,
        status: "interested",
      });
      if (!connectionRequest) {
        return res
          .status(404)
          .json({ message: "Connection request not found" });
      }

      connectionRequest.status = status;

      // No feed-cache update needed here: reviewing changes the STATUS of a
      // request whose pair is already in both users' exclusion sets. The set
      // tracks "have these two interacted at all", which a review never changes.
      const data = await connectionRequest.save();

      res.json({ message: "Connection request " + status, data });
    } catch (err) {
      res.status(400).send("ERROR: " + err.message);
    }
  }
);

module.exports = requestRouter;
