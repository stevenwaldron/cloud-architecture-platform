const { query, newId } = require("shared/db");
const { checkText } = require("shared/moderation");

// Screens the free-text fields of a request body. Returns a reason string if
// anything is rejected, or null when it's clean.
function screenBody(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null) continue;
    const value = Array.isArray(body[f]) ? body[f].join(" ") : body[f];
    if (typeof value !== "string") continue;
    const r = checkText(value, { maxLinks: f === "description" || f === "bio" ? 3 : 0 });
    if (!r.ok) return r.reason;
  }
  return null;
}

const { ok, created, notFound, badRequest, unauthorized, forbidden, serverError, parseBody, getUserId, getOptionalUserId } = require("shared/http");

exports.handler = async (event) => {
  try {
    const method = event.requestContext.http.method;
    const diagramId = event.pathParameters?.diagramId;

    if (method === "POST") {
      const userId = getUserId(event);
      if (!userId) return unauthorized();

      const body = parseBody(event);
      const rejected = screenBody(body, ["title", "description", "category", "tags"]);
      if (rejected) return badRequest(rejected);
      const id = newId("diag");

      await query(
        `INSERT INTO diagrams (diagram_id, user_id, title, description, category, tags, canvas_data, visibility)
         VALUES (:id, :userId, :title, :description, :category, :tags, :canvasData, :visibility)`,
        {
          id,
          userId,
          title: body.title || "Untitled Architecture",
          description: body.description || null,
          category: body.category || null,
          tags: body.tags || [],
          canvasData: body.canvasData || {},
          visibility: body.visibility || "private",
        }
      );
      await query(`UPDATE users SET diagram_count = diagram_count + 1 WHERE user_id = :userId`, { userId });

      return created({ diagramId: id });
    }

    if (method === "GET") {
      if (!diagramId) return badRequest("diagramId path parameter is required");
      const { rows } = await query(
        `SELECT d.*, u.display_name AS author_name, u.handle AS author_handle,
                u.avatar_url AS author_avatar, u.avatar_initials AS author_initials
         FROM diagrams d JOIN users u ON u.user_id = d.user_id
         WHERE d.diagram_id = :diagramId`,
        { diagramId }
      );
      if (!rows.length) return notFound("Diagram not found");

      // Visibility check. The listing endpoints all filter private diagrams
      // out, but this route fetches by id and had no check at all — so anyone
      // holding a diagram id could read a private diagram in full, including
      // its canvas data. The lists were never the security boundary; this is.
      //
      // Returns 404 rather than 403 deliberately: a 403 confirms the diagram
      // exists, which leaks information about someone's private work.
      const viewerId = getOptionalUserId(event);
      if (rows[0].visibility !== "public" && rows[0].user_id !== viewerId) {
        return notFound("Diagram not found");
      }

      // Only count views from someone other than the owner, so a diagram's
      // view count reflects real interest rather than the author's own edits.
      if (rows[0].user_id !== viewerId) {
        await query(`UPDATE diagrams SET view_count = view_count + 1 WHERE diagram_id = :diagramId`, { diagramId });
      }

      const row = rows[0];
      return ok({
        ...row,
        tags: row.tags ? JSON.parse(row.tags) : [],
        canvasData: row.canvas_data ? JSON.parse(row.canvas_data) : {},
        // Malformed JSON here shouldn't blank the whole diagram, so fall back
        // to an empty case study rather than throwing.
        case_study: (() => { try { return row.case_study ? JSON.parse(row.case_study) : []; } catch { return []; } })(),
      });
    }

    if (method === "PUT") {
      const userId = getUserId(event);
      if (!userId) return unauthorized();
      if (!diagramId) return badRequest("diagramId path parameter is required");

      const { rows } = await query(`SELECT user_id FROM diagrams WHERE diagram_id = :diagramId`, { diagramId });
      if (!rows.length) return notFound("Diagram not found");
      if (rows[0].user_id !== userId) return forbidden("You don't own this diagram");

      const body = parseBody(event);
      const rejectedUpdate = screenBody(body, ["title", "description", "category", "tags"]);
      if (rejectedUpdate) return badRequest(rejectedUpdate);
      const updatable = ["title", "description", "category", "visibility"];
      const setParts = [];
      const params = { diagramId };

      // Pinning is capped at three. Enforced here because MySQL can't express
      // "at most three rows per user with this flag" as a constraint, and
      // because silently accepting a fourth would be worse than refusing it.
      if (body.is_pinned === true) {
        const { rows: pinnedRows } = await query(
          `SELECT COUNT(*) AS pinned FROM diagrams
           WHERE user_id = :userId AND is_pinned = TRUE AND diagram_id <> :diagramId`,
          { userId, diagramId }
        );
        if (Number(pinnedRows[0]?.pinned || 0) >= 3) {
          return badRequest("You can pin up to 3 diagrams. Unpin one first.");
        }
        setParts.push("pinned_at = NOW()");
      }
      if (body.is_pinned === false) {
        setParts.push("pinned_at = NULL");
      }
      if (body.is_pinned !== undefined) {
        setParts.push("is_pinned = :is_pinned");
        params.is_pinned = !!body.is_pinned;
      }

      // Case study arrives as an array of {q, a}. Stored as JSON text; an
      // empty array clears it.
      if (body.case_study !== undefined) {
        if (body.case_study === null || (Array.isArray(body.case_study) && body.case_study.length === 0)) {
          setParts.push("case_study = NULL");
        } else if (Array.isArray(body.case_study)) {
          const cleaned = body.case_study
            .filter((item) => item && typeof item.q === "string" && typeof item.a === "string" && item.a.trim())
            .slice(0, 10)
            .map((item) => ({ q: item.q.slice(0, 200), a: item.a.slice(0, 2000) }));
          for (const item of cleaned) {
            const r = checkText(item.a, { maxLinks: 3 });
            if (!r.ok) return badRequest(r.reason);
          }
          setParts.push("case_study = :case_study");
          params.case_study = JSON.stringify(cleaned);
        } else {
          return badRequest("case_study must be an array");
        }
      }


      updatable.forEach((f) => {
        if (body[f] !== undefined) {
          setParts.push(`${f} = :${f}`);
          params[f] = body[f];
        }
      });
      if (body.tags !== undefined) {
        setParts.push("tags = :tags");
        params.tags = body.tags;
      }
      if (body.canvasData !== undefined) {
        setParts.push("canvas_data = :canvasData");
        params.canvasData = body.canvasData;
      }
      if (!setParts.length) return badRequest("No valid fields to update");

      await query(`UPDATE diagrams SET ${setParts.join(", ")} WHERE diagram_id = :diagramId`, params);
      return ok({ message: "Diagram updated" });
    }

    if (method === "DELETE") {
      const userId = getUserId(event);
      if (!userId) return unauthorized();
      if (!diagramId) return badRequest("diagramId path parameter is required");

      const { rows } = await query(`SELECT user_id FROM diagrams WHERE diagram_id = :diagramId`, { diagramId });
      if (!rows.length) return notFound("Diagram not found");
      if (rows[0].user_id !== userId) return forbidden("You don't own this diagram");

      // Soft delete — keeps the row (and its comments/likes history) but
      // removes it from all listings.
      await query(`UPDATE diagrams SET status = 'archived', visibility = 'private' WHERE diagram_id = :diagramId`, { diagramId });
      return ok({ message: "Diagram archived" });
    }

    return badRequest("Unsupported method");
  } catch (err) {
    return serverError(err);
  }
};
