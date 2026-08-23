const { query } = require("shared/db");
const { ok, badRequest, unauthorized, notFound, serverError, getUserId } = require("shared/http");
const { notify } = require("shared/notify");
const { isPrivate } = require("shared/visibility");

exports.handler = async (event) => {
  try {
    const followerId = getUserId(event);
    if (!followerId) return unauthorized();

    const followingId = event.pathParameters?.userId;
    if (!followingId) return badRequest("userId path parameter is required");
    if (followingId === followerId) return badRequest("You can't follow yourself");

    const method = event.requestContext.http.method;

    if (method === "POST") {
      const { rows: targetRows } = await query(
        `SELECT user_id FROM users WHERE user_id = :followingId`,
        { followingId }
      );
      if (!targetRows.length) return notFound("User not found");

      // A private account gets a request; a public one gets a follow outright.
      const priv = await isPrivate(followingId);
      const status = priv ? "pending" : "accepted";

      const { numberOfRecordsUpdated } = await query(
        `INSERT IGNORE INTO follows (follower_id, following_id, status)
         VALUES (:followerId, :followingId, :status)`,
        { followerId, followingId, status }
      );

      // Only adjust counts when a row was actually inserted — INSERT IGNORE
      // no-ops on an existing row, and without this check counts inflate every
      // time someone re-clicks follow.
      //
      // Counts track ACCEPTED follows only: a pending request is not a
      // follower, and counting it would leak that someone had asked.
      if (numberOfRecordsUpdated > 0 && status === "accepted") {
        await query(`UPDATE users SET following_count = following_count + 1 WHERE user_id = :followerId`, { followerId });
        await query(`UPDATE users SET follower_count = follower_count + 1 WHERE user_id = :followingId`, { followingId });
      }

      if (numberOfRecordsUpdated > 0) {
        await notify({
          recipientId: followingId,
          actorId: followerId,
          type: priv ? "follow_request" : "new_follower",
        });
      }

      return ok({ following: status === "accepted", requested: status === "pending", status });
    }

    if (method === "DELETE") {
      // Covers both unfollowing and withdrawing a pending request.
      const { rows: existing } = await query(
        `SELECT status FROM follows WHERE follower_id = :followerId AND following_id = :followingId`,
        { followerId, followingId }
      );
      const wasAccepted = existing.length && existing[0].status === "accepted";

      const { numberOfRecordsUpdated } = await query(
        `DELETE FROM follows WHERE follower_id = :followerId AND following_id = :followingId`,
        { followerId, followingId }
      );

      if (numberOfRecordsUpdated > 0 && wasAccepted) {
        await query(`UPDATE users SET following_count = GREATEST(following_count - 1, 0) WHERE user_id = :followerId`, { followerId });
        await query(`UPDATE users SET follower_count = GREATEST(follower_count - 1, 0) WHERE user_id = :followingId`, { followingId });
      }

      // Clear any outstanding request notification so the recipient isn't left
      // holding a request they can no longer act on.
      await query(
        `DELETE FROM notifications
         WHERE recipient_id = :followingId AND actor_id = :followerId AND type = 'follow_request'`,
        { followingId, followerId }
      );

      return ok({ following: false, requested: false, status: null });
    }

    return badRequest("Unsupported method");
  } catch (err) {
    return serverError(err);
  }
};
