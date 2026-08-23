const { query } = require("shared/db");
const { VISIBLE_AUTHOR_SQL } = require("shared/visibility");
const { ok, badRequest, serverError, getUserId, getOptionalUserId } = require("shared/http");

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters?.q;
    if (!q || q.trim().length < 2) return badRequest("Query parameter 'q' must be at least 2 characters");

    const like = `%${q.trim()}%`;
    const viewerId = getOptionalUserId(event) || null;

    const { rows } = await query(
      `SELECT d.diagram_id, d.title, d.thumbnail_url, d.category, d.tags,
              d.like_count, d.comment_count,
              u.user_id AS author_id, u.display_name AS author_name, u.handle AS author_handle
       FROM diagrams d
       JOIN users u ON u.user_id = d.user_id
       WHERE d.visibility = 'public' AND d.status = 'published'
         AND ${VISIBLE_AUTHOR_SQL}
         AND (d.title LIKE :like OR d.description LIKE :like OR d.tags LIKE :like)
       ORDER BY d.like_count DESC
       LIMIT 30`,
      { like, viewerId });

    const { rows: userRows } = await query(
      `SELECT user_id, display_name, handle, avatar_url, avatar_initials, title
       FROM users WHERE display_name LIKE :like OR handle LIKE :like LIMIT 10`,
      { like }
    );

    return ok({
      diagrams: rows.map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [] })),
      users: userRows,
    });
  } catch (err) {
    return serverError(err);
  }
};
