const { query } = require("shared/db");
const { ok, badRequest, unauthorized, serverError } = require("shared/http");
const { getUserId } = require("shared/http");
const { notify } = require("shared/notify");

exports.handler = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return unauthorized();

    const commentId = event.pathParameters?.commentId;
    if (!commentId) return badRequest("commentId path parameter is required");

    if (event.requestContext.http.method === "POST") {
      const { numberOfRecordsUpdated } = await query(
        `INSERT IGNORE INTO comment_likes (user_id, comment_id) VALUES (:userId, :commentId)`,
        { userId, commentId }
      );
      if (numberOfRecordsUpdated > 0) {
        await query(`UPDATE comments SET like_count = like_count + 1 WHERE comment_id = :commentId`, { commentId });
        // Notify the comment's author.
        const { rows: authorRows } = await query(
          `SELECT user_id, diagram_id, body FROM comments WHERE comment_id = :commentId`,
          { commentId }
        );
        if (authorRows.length) {
          await notify({
            recipientId: authorRows[0].user_id,
            actorId: userId,
            type: "comment_like",
            diagramId: authorRows[0].diagram_id,
            commentId,
            preview: authorRows[0].body,
          });
        }
      }
      return ok({ liked: true });
    }

    if (event.requestContext.http.method === "DELETE") {
      const { numberOfRecordsUpdated } = await query(
        `DELETE FROM comment_likes WHERE user_id = :userId AND comment_id = :commentId`,
        { userId, commentId }
      );
      if (numberOfRecordsUpdated > 0) {
        await query(`UPDATE comments SET like_count = GREATEST(like_count - 1, 0) WHERE comment_id = :commentId`, { commentId });
      }
      return ok({ liked: false });
    }

    return badRequest("Unsupported method");
  } catch (err) {
    return serverError(err);
  }
};
