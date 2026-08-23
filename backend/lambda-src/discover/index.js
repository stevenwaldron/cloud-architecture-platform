const { query } = require("shared/db");
const { VISIBLE_AUTHOR_SQL } = require("shared/visibility");
const { ok, serverError, getUserId, getOptionalUserId } = require("shared/http");

exports.handler = async (event) => {
  try {
    const category = event.queryStringParameters?.category;
    // null for a signed-out visitor — VISIBLE_AUTHOR_SQL handles that.
    const viewerId = getOptionalUserId(event) || null;

    const { rows } = await query(
      `SELECT d.diagram_id, d.title, d.feed_caption, d.thumbnail_url, d.category, d.tags,
              d.like_count, d.comment_count, d.save_count, d.view_count, d.shared_at,
              u.user_id AS author_id, u.display_name AS author_name, u.handle AS author_handle,
              u.avatar_url AS author_avatar, u.avatar_initials AS author_initials
       FROM diagrams d
       JOIN users u ON u.user_id = d.user_id
       WHERE d.is_shared_to_feed = TRUE AND d.visibility = 'public'
         AND ${VISIBLE_AUTHOR_SQL}
       ${category ? "AND d.category = :category" : ""}
       ORDER BY (d.like_count * 3 + d.comment_count * 2 + d.view_count) DESC, d.shared_at DESC
       LIMIT 50`,
      category ? { category, viewerId } : { viewerId }
    );

    return ok({ posts: rows.map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] })) });
  } catch (err) {
    return serverError(err);
  }
};
