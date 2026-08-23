const { query } = require("shared/db");
const { ok, badRequest, forbidden, serverError, getUserId, getOptionalUserId } = require("shared/http");
const { canViewProfile } = require("shared/visibility");

exports.handler = async (event) => {
  try {
    const userId = event.pathParameters?.userId;
    const type = event.queryStringParameters?.type === "following" ? "following" : "followers";
    if (!userId) return badRequest("userId path parameter is required");

    // A private account's follower list is part of its content.
    const access = await canViewProfile(getOptionalUserId(event), userId);
    if (!access.visible) return forbidden("This account is private");

    const sql =
      type === "followers"
        ? `SELECT u.user_id, u.display_name, u.handle, u.avatar_url, u.avatar_initials, u.title
           FROM follows f JOIN users u ON u.user_id = f.follower_id
           WHERE f.following_id = :userId AND f.status = 'accepted' ORDER BY f.created_at DESC LIMIT 100`
        : `SELECT u.user_id, u.display_name, u.handle, u.avatar_url, u.avatar_initials, u.title
           FROM follows f JOIN users u ON u.user_id = f.following_id
           WHERE f.follower_id = :userId AND f.status = 'accepted' ORDER BY f.created_at DESC LIMIT 100`;

    const { rows } = await query(sql, { userId });
    return ok({ type, users: rows });
  } catch (err) {
    return serverError(err);
  }
};
