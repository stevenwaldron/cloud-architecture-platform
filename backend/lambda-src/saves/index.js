const { query } = require("shared/db");
const { ok, badRequest, unauthorized, serverError, getUserId } = require("shared/http");

exports.handler = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return unauthorized();

    // GET (no diagramId path param) — list everything the current user has saved
    if (event.requestContext.http.method === "GET" && !event.pathParameters?.diagramId) {
      const { rows } = await query(
        `SELECT d.diagram_id, d.title, d.thumbnail_url, d.category,
                u.display_name AS author_name, u.handle AS author_handle
         FROM saves s
         JOIN diagrams d ON d.diagram_id = s.diagram_id
         JOIN users u ON u.user_id = d.user_id
         WHERE s.user_id = :userId
         ORDER BY s.created_at DESC LIMIT 100`,
        { userId }
      );
      return ok({ saved: rows });
    }

    const diagramId = event.pathParameters?.diagramId;
    if (!diagramId) return badRequest("diagramId path parameter is required");

    if (event.requestContext.http.method === "POST") {
      const { numberOfRecordsUpdated } = await query(
        `INSERT IGNORE INTO saves (user_id, diagram_id) VALUES (:userId, :diagramId)`,
        { userId, diagramId }
      );
      if (numberOfRecordsUpdated > 0) {
        await query(`UPDATE diagrams SET save_count = save_count + 1 WHERE diagram_id = :diagramId`, { diagramId });
      }
      return ok({ saved: true });
    }

    if (event.requestContext.http.method === "DELETE") {
      const { numberOfRecordsUpdated } = await query(
        `DELETE FROM saves WHERE user_id = :userId AND diagram_id = :diagramId`,
        { userId, diagramId }
      );
      if (numberOfRecordsUpdated > 0) {
        await query(`UPDATE diagrams SET save_count = GREATEST(save_count - 1, 0) WHERE diagram_id = :diagramId`, { diagramId });
      }
      return ok({ saved: false });
    }

    return badRequest("Unsupported method");
  } catch (err) {
    return serverError(err);
  }
};
