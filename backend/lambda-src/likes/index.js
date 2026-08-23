const { query } = require("shared/db");
const { ok, badRequest, unauthorized, serverError, getUserId } = require("shared/http");
const { notify } = require("shared/notify");

exports.handler = async (event) => {
  try {
    const diagramId = event.pathParameters?.diagramId;
    if (!diagramId) return badRequest("diagramId path parameter is required");

    if (event.requestContext.http.method === "GET") {
      const { rows } = await query(
        `SELECT u.user_id, u.display_name, u.handle, u.avatar_url, u.avatar_initials
         FROM likes l JOIN users u ON u.user_id = l.user_id
         WHERE l.diagram_id = :diagramId ORDER BY l.created_at DESC LIMIT 100`,
        { diagramId }
      );
      return ok({ likers: rows });
    }

    const userId = getUserId(event);
    if (!userId) return unauthorized();

    if (event.requestContext.http.method === "POST") {
      const { numberOfRecordsUpdated } = await query(
        `INSERT IGNORE INTO likes (user_id, diagram_id) VALUES (:userId, :diagramId)`,
        { userId, diagramId }
      );
      if (numberOfRecordsUpdated > 0) {
        await query(`UPDATE diagrams SET like_count = like_count + 1 WHERE diagram_id = :diagramId`, { diagramId });
        // Notify the diagram's owner. Guarded by numberOfRecordsUpdated so a
        // duplicate like (INSERT IGNORE no-op) doesn't re-notify.
        const { rows: ownerRows } = await query(
          `SELECT user_id, title FROM diagrams WHERE diagram_id = :diagramId`,
          { diagramId }
        );
        if (ownerRows.length) {
          await notify({
            recipientId: ownerRows[0].user_id,
            actorId: userId,
            type: "diagram_like",
            diagramId,
            preview: ownerRows[0].title,
          });
        }
      }
      return ok({ liked: true });
    }

    if (event.requestContext.http.method === "DELETE") {
      const { numberOfRecordsUpdated } = await query(
        `DELETE FROM likes WHERE user_id = :userId AND diagram_id = :diagramId`,
        { userId, diagramId }
      );
      if (numberOfRecordsUpdated > 0) {
        await query(`UPDATE diagrams SET like_count = GREATEST(like_count - 1, 0) WHERE diagram_id = :diagramId`, { diagramId });
      }
      return ok({ liked: false });
    }

    return badRequest("Unsupported method");
  } catch (err) {
    return serverError(err);
  }
};
