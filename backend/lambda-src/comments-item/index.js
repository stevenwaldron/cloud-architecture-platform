const { query } = require("shared/db");
const { checkText } = require("shared/moderation");
const { ok, notFound, forbidden, badRequest, unauthorized, serverError, parseBody, getUserId } = require("shared/http");

exports.handler = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return unauthorized();

    const commentId = event.pathParameters?.commentId;
    if (!commentId) return badRequest("commentId path parameter is required");

    // No SQL aliases here, deliberately. The RDS Data API sets
    // columnMetadata.name to the ORIGINAL column and .label to the alias;
    // shared/db.js now prefers .label, but this function is the one that
    // gates permissions, so it should not depend on that behaviour at all.
    // Two separate queries, plain column names, nothing to collide.
    const { rows: commentRows } = await query(
      `SELECT user_id, diagram_id FROM comments WHERE comment_id = :commentId`,
      { commentId }
    );
    if (!commentRows.length) return notFound("Comment not found");
    const commentAuthorId = commentRows[0].user_id;
    const diagramId = commentRows[0].diagram_id;

    const { rows: diagramRows } = await query(
      `SELECT user_id FROM diagrams WHERE diagram_id = :diagramId`,
      { diagramId }
    );
    const diagramOwnerId = diagramRows[0]?.user_id;

    const isCommentAuthor = commentAuthorId === userId;
    const isDiagramOwner = diagramOwnerId === userId;

    if (event.requestContext.http.method === "PUT") {
      // Only the person who wrote the comment can edit its text — a
      // diagram owner moderating comments can remove them, but shouldn't
      // be able to rewrite what someone else said.
      if (!isCommentAuthor) return forbidden("You can only edit your own comments");

      const { body } = parseBody(event);
      if (!body || !body.trim()) return badRequest("Comment body is required");
      const mod = checkText(body, { maxLinks: 2 });
      if (!mod.ok) return badRequest(mod.reason);

      await query(`UPDATE comments SET body = :body, is_edited = TRUE WHERE comment_id = :commentId`, { body: body.trim(), commentId });
      return ok({ message: "Comment updated" });
    }

    if (event.requestContext.http.method === "DELETE") {
      // Either the comment's author, or the owner of the diagram it's on
      // (moderation), can delete it.
      if (!isCommentAuthor && !isDiagramOwner) return forbidden("You don't have permission to delete this comment");

      // Deleting a top-level comment takes its replies with it. This is done
      // here rather than by an ON DELETE CASCADE foreign key, because adding
      // that constraint isn't safely re-runnable through bootstrap.sh.
      const { rows: replyRows } = await query(
        `SELECT COUNT(*) AS reply_count FROM comments WHERE parent_comment_id = :commentId`,
        { commentId }
      );
      const replyCount = Number(replyRows[0]?.reply_count || 0);

      await query(`DELETE FROM comments WHERE parent_comment_id = :commentId`, { commentId });
      await query(`DELETE FROM comments WHERE comment_id = :commentId`, { commentId });
      // Decrement by the comment plus every reply that went with it.
      await query(
        `UPDATE diagrams SET comment_count = GREATEST(comment_count - :removed, 0) WHERE diagram_id = :diagramId`,
        { diagramId, removed: replyCount + 1 }
      );
      return ok({ message: "Comment deleted", repliesRemoved: replyCount });
    }

    return badRequest("Unsupported method");
  } catch (err) {
    return serverError(err);
  }
};
