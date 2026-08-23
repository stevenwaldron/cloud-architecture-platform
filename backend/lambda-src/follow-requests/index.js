const { query } = require("shared/db");
const { ok, badRequest, unauthorized, notFound, serverError, getUserId } = require("shared/http");
const { notify } = require("shared/notify");

/**
 * Follow request management for private accounts.
 *
 *   GET    /follow-requests                  list requests awaiting my decision
 *   PUT    /follow-requests/{requesterId}    accept
 *   DELETE /follow-requests/{requesterId}    deny
 *
 * Denying DELETES the row rather than marking it denied. Storing a denial would
 * let the requester's UI infer the refusal, and would block them from ever
 * asking again. Silent removal matches what people expect from Instagram.
 */
exports.handler = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return unauthorized();

    const method = event.requestContext.http.method;
    const requesterId = event.pathParameters?.requesterId;

    if (method === "GET") {
      const { rows } = await query(
        `SELECT u.user_id, u.display_name, u.handle, u.avatar_url, u.avatar_initials, u.title,
                f.created_at
         FROM follows f JOIN users u ON u.user_id = f.follower_id
         WHERE f.following_id = :userId AND f.status = 'pending'
         ORDER BY f.created_at DESC LIMIT 100`,
        { userId }
      );
      return ok({ requests: rows, count: rows.length });
    }

    if (!requesterId) return badRequest("requesterId path parameter is required");

    // Confirm the request exists and is genuinely addressed to the caller —
    // otherwise anyone could accept a request meant for someone else.
    const { rows: existing } = await query(
      `SELECT status FROM follows WHERE follower_id = :requesterId AND following_id = :userId`,
      { requesterId, userId }
    );
    if (!existing.length || existing[0].status !== "pending") {
      return notFound("No pending follow request from that user");
    }

    if (method === "PUT") {
      await query(
        `UPDATE follows SET status = 'accepted'
         WHERE follower_id = :requesterId AND following_id = :userId`,
        { requesterId, userId }
      );
      // Counts move only now, on acceptance — a pending request was never a
      // follower and was never counted.
      await query(`UPDATE users SET following_count = following_count + 1 WHERE user_id = :requesterId`, { requesterId });
      await query(`UPDATE users SET follower_count = follower_count + 1 WHERE user_id = :userId`, { userId });

      // The request notification has been acted on; replace it rather than
      // leaving a stale card with buttons that no longer apply.
      await query(
        `DELETE FROM notifications
         WHERE recipient_id = :userId AND actor_id = :requesterId AND type = 'follow_request'`,
        { userId, requesterId }
      );

      // Tell the requester they were accepted. Note the reversed direction:
      // here the account owner is the actor and the requester the recipient.
      await notify({
        recipientId: requesterId,
        actorId: userId,
        type: "follow_accepted",
      });

      return ok({ accepted: true });
    }

    if (method === "DELETE") {
      await query(
        `DELETE FROM follows WHERE follower_id = :requesterId AND following_id = :userId`,
        { requesterId, userId }
      );
      await query(
        `DELETE FROM notifications
         WHERE recipient_id = :userId AND actor_id = :requesterId AND type = 'follow_request'`,
        { userId, requesterId }
      );
      // No notification on denial, by design — the requester is not told.
      return ok({ denied: true });
    }

    return badRequest("Unsupported method");
  } catch (err) {
    return serverError(err);
  }
};
