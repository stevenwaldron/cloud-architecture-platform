const { query, newId } = require("shared/db");
const { ok, created, badRequest, unauthorized, serverError, parseBody, getUserId, getOptionalUserId } = require("shared/http");
const { notify } = require("shared/notify");
const { checkText } = require("shared/moderation");

exports.handler = async (event) => {
  try {
    const diagramId = event.pathParameters?.diagramId;
    if (!diagramId) return badRequest("diagramId path parameter is required");

    if (event.requestContext.http.method === "GET") {
      // A private diagram's discussion is part of that diagram. Without this
      // the comments were readable by id even when the diagram itself wasn't.
      const { rows: visRows } = await query(
        `SELECT user_id, visibility FROM diagrams WHERE diagram_id = :diagramId`,
        { diagramId }
      );
      if (!visRows.length) return ok({ comments: [] });
      if (visRows[0].visibility !== "public" && visRows[0].user_id !== getOptionalUserId(event)) {
        return ok({ comments: [] });
      }

      const { rows } = await query(
        `SELECT c.comment_id, c.body, c.is_edited, c.like_count, c.created_at,
                c.parent_comment_id,
                u.user_id, u.display_name, u.handle, u.avatar_url, u.avatar_initials
         FROM comments c JOIN users u ON u.user_id = c.user_id
         WHERE c.diagram_id = :diagramId
         ORDER BY c.created_at ASC LIMIT 500`,
        { diagramId }
      );
      // Returned flat and ordered oldest-first; the client nests replies under
      // their parent. Limit raised from 200 because replies now share this
      // budget with top-level comments.
      return ok({ comments: rows });
    }

    if (event.requestContext.http.method === "POST") {
      const userId = getUserId(event);
      if (!userId) return unauthorized();

      const { body, parentCommentId } = parseBody(event);
      if (!body || !body.trim()) return badRequest("Comment body is required");
      const mod = checkText(body, { maxLinks: 2 });
      if (!mod.ok) return badRequest(mod.reason);

      // Replies stay one level deep. If the target is itself a reply, attach
      // to its parent instead, so threads can't nest indefinitely.
      let parentId = null;
      if (parentCommentId) {
        const { rows: parentRows } = await query(
          `SELECT comment_id, parent_comment_id, diagram_id FROM comments WHERE comment_id = :parentCommentId`,
          { parentCommentId }
        );
        if (!parentRows.length) return badRequest("Parent comment not found");
        if (parentRows[0].diagram_id !== diagramId) return badRequest("Parent comment belongs to a different diagram");
        parentId = parentRows[0].parent_comment_id || parentRows[0].comment_id;
      }

      const commentId = newId("cmt");
      await query(
        `INSERT INTO comments (comment_id, diagram_id, user_id, body, parent_comment_id)
         VALUES (:commentId, :diagramId, :userId, :body, :parentId)`,
        { commentId, diagramId, userId, body: body.trim(), parentId }
      );
      await query(`UPDATE diagrams SET comment_count = comment_count + 1 WHERE diagram_id = :diagramId`, { diagramId });

      // Notifications. A reply notifies the parent comment's author; a
      // top-level comment notifies the diagram's owner. When someone replies
      // to a comment on their OWN diagram, the parent author and the diagram
      // owner may differ — both are notified, and notify() drops whichever
      // one is the actor themselves.
      const { rows: diagramRows } = await query(
        `SELECT user_id, title FROM diagrams WHERE diagram_id = :diagramId`,
        { diagramId }
      );
      const diagramOwnerId = diagramRows[0]?.user_id;
      const diagramTitle = diagramRows[0]?.title;

      if (parentId) {
        const { rows: parentAuthorRows } = await query(
          `SELECT user_id FROM comments WHERE comment_id = :parentId`,
          { parentId }
        );
        await notify({
          recipientId: parentAuthorRows[0]?.user_id,
          actorId: userId,
          type: "comment_reply",
          diagramId,
          commentId,
          preview: body.trim(),
        });
        // Also tell the diagram owner someone is active on their diagram,
        // unless they're the one being replied to (already notified above).
        if (diagramOwnerId && diagramOwnerId !== parentAuthorRows[0]?.user_id) {
          await notify({
            recipientId: diagramOwnerId,
            actorId: userId,
            type: "diagram_comment",
            diagramId,
            commentId,
            preview: body.trim(),
          });
        }
      } else {
        await notify({
          recipientId: diagramOwnerId,
          actorId: userId,
          type: "diagram_comment",
          diagramId,
          commentId,
          preview: body.trim(),
        });
      }

      return created({ commentId, parentCommentId: parentId });
    }

    return badRequest("Unsupported method");
  } catch (err) {
    return serverError(err);
  }
};
