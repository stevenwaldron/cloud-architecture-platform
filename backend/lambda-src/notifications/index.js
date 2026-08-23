const { query } = require("shared/db");
const { ok, badRequest, unauthorized, notFound, forbidden, serverError, getUserId } = require("shared/http");

exports.handler = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return unauthorized();

    const method = event.requestContext.http.method;
    const notificationId = event.pathParameters?.notificationId;
    const path = event.requestContext.http.path || "";

    // GET /notifications — list plus unread count.
    if (method === "GET") {
      // INNER JOIN on users drops notifications whose actor deleted their
      // account; LEFT JOIN on diagrams/comments keeps rows whose target is
      // gone but lets the client tell (title/body come back null) so it can
      // render "this diagram was deleted" rather than a broken link.
      const { rows } = await query(
        `SELECT n.notification_id, n.type, n.diagram_id, n.comment_id, n.preview,
                n.is_read, n.created_at,
                u.user_id AS actor_id, u.display_name AS actor_name,
                u.handle AS actor_handle, u.avatar_url AS actor_avatar,
                u.avatar_initials AS actor_initials,
                d.title AS diagram_title
         FROM notifications n
         JOIN users u ON u.user_id = n.actor_id
         LEFT JOIN diagrams d ON d.diagram_id = n.diagram_id
         WHERE n.recipient_id = :userId
         ORDER BY n.created_at DESC
         LIMIT 100`,
        { userId }
      );

      const { rows: countRows } = await query(
        `SELECT COUNT(*) AS unread FROM notifications WHERE recipient_id = :userId AND is_read = FALSE`,
        { userId }
      );

      return ok({
        notifications: rows,
        unreadCount: Number(countRows[0]?.unread || 0),
      });
    }

    // PUT /notifications/read-all — clear the badge in one call.
    if (method === "PUT" && path.endsWith("/read-all")) {
      await query(
        `UPDATE notifications SET is_read = TRUE WHERE recipient_id = :userId AND is_read = FALSE`,
        { userId }
      );
      return ok({ message: "All notifications marked read" });
    }

    // PUT /notifications/{notificationId} — mark a single one read.
    if (method === "PUT") {
      if (!notificationId) return badRequest("notificationId path parameter is required");

      // Confirm ownership explicitly rather than relying on the UPDATE's
      // WHERE clause, so someone else's id returns 403 instead of a silent
      // no-op that looks like success.
      const { rows } = await query(
        `SELECT recipient_id FROM notifications WHERE notification_id = :notificationId`,
        { notificationId }
      );
      if (!rows.length) return notFound("Notification not found");
      if (rows[0].recipient_id !== userId) return forbidden("Not your notification");

      await query(
        `UPDATE notifications SET is_read = TRUE WHERE notification_id = :notificationId`,
        { notificationId }
      );
      return ok({ message: "Notification marked read" });
    }

    // DELETE /notifications/{notificationId}
    if (method === "DELETE") {
      if (!notificationId) return badRequest("notificationId path parameter is required");

      const { rows } = await query(
        `SELECT recipient_id FROM notifications WHERE notification_id = :notificationId`,
        { notificationId }
      );
      if (!rows.length) return notFound("Notification not found");
      if (rows[0].recipient_id !== userId) return forbidden("Not your notification");

      await query(`DELETE FROM notifications WHERE notification_id = :notificationId`, { notificationId });
      return ok({ message: "Notification deleted" });
    }

    return badRequest("Unsupported method");
  } catch (err) {
    return serverError(err);
  }
};
