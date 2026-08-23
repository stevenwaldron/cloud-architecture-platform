const { query } = require("shared/db");
const { ok, badRequest, serverError, getOptionalUserId } = require("shared/http");

exports.handler = async (event) => {
  try {
    const targetUserId = event.pathParameters?.userId;
    if (!targetUserId) return badRequest("userId path parameter is required");

    // Optional identity: this route is open to signed-out visitors, so the
    // authorizer hasn't run and getUserId would report anonymous even for the
    // profile's own owner.
    const requesterId = getOptionalUserId(event);
    const isOwnProfile = requesterId === targetUserId;

    const { rows } = await query(
      `SELECT diagram_id, title, thumbnail_url, category, tags, visibility, status,
              view_count, like_count, comment_count, save_count, updated_at,
              is_pinned, pinned_at
       FROM diagrams
       WHERE user_id = :userId AND status != 'archived'
       ${isOwnProfile ? "" : "AND visibility = 'public'"}
       -- Pinned diagrams lead, most recently pinned first, then everything
       -- else by recency. This is the ordering a recruiter's thirty seconds
       -- depends on, so it belongs in the query rather than in client sorting.
       ORDER BY is_pinned DESC, pinned_at DESC, updated_at DESC LIMIT 100`,
      { userId: targetUserId }
    );

    return ok({ diagrams: rows.map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] })) });
  } catch (err) {
    return serverError(err);
  }
};
