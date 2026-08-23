const { query } = require("shared/db");
const { ok, notFound, forbidden, badRequest, unauthorized, serverError, parseBody, getUserId } = require("shared/http");

exports.handler = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return unauthorized();

    const diagramId = event.pathParameters?.diagramId;
    if (!diagramId) return badRequest("diagramId path parameter is required");

    const { rows } = await query(`SELECT user_id FROM diagrams WHERE diagram_id = :diagramId`, { diagramId });
    if (!rows.length) return notFound("Diagram not found");
    if (rows[0].user_id !== userId) return forbidden("You don't own this diagram");

    const { caption } = parseBody(event);

    await query(
      `UPDATE diagrams
       SET status = 'published', visibility = 'public', is_shared_to_feed = TRUE,
           published_at = NOW(), shared_at = NOW(), feed_caption = :caption
       WHERE diagram_id = :diagramId`,
      { diagramId, caption: caption || null }
    );

    return ok({ message: "Published to Feed" });
  } catch (err) {
    return serverError(err);
  }
};
