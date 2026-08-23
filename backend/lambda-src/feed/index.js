const { query } = require("shared/db");
const { ok, unauthorized, serverError, getUserId } = require("shared/http");

exports.handler = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return unauthorized();

    const { rows } = await query(
      `SELECT d.diagram_id, d.title, d.feed_caption, d.thumbnail_url, d.category, d.tags,
              d.like_count, d.comment_count, d.save_count, d.shared_at,
              u.user_id AS author_id, u.display_name AS author_name, u.handle AS author_handle,
              u.avatar_url AS author_avatar, u.avatar_initials AS author_initials
       FROM diagrams d
       JOIN users u ON u.user_id = d.user_id
       WHERE d.is_shared_to_feed = TRUE AND d.visibility = 'public'
         AND (
           d.user_id IN (SELECT following_id FROM follows WHERE follower_id = :userId AND status = 'accepted')
           OR d.user_id = :userId
         )
       ORDER BY d.shared_at DESC
       LIMIT 50`,
      { userId }
    );

    return ok({ posts: rows.map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] })) });
  } catch (err) {
    return serverError(err);
  }
};
