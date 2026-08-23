const { query } = require("shared/db");
const { checkText } = require("shared/moderation");
const { validateHandle, isHandleTaken } = require("shared/db");
const { canViewProfile } = require("shared/visibility");

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

const { ok, notFound, badRequest, unauthorized, serverError, parseBody, getUserId, getOptionalUserId } = require("shared/http");

const PROFILE_FIELDS = [
  "display_name", "handle", "title", "bio", "location", "website", "is_private",
  "avatar_url", "dark_mode", "email_notifications",
  "notify_on_comment", "notify_on_follow", "notify_on_like",
];

exports.handler = async (event) => {
  try {
    const rawPath = event.requestContext.http.path || "";

    // GET /users/me — the caller's OWN record, including settings. Kept
    // separate from the public GET /users/{userId} on purpose: settings and
    // notification preferences must not be readable by anyone else, so they
    // are only ever returned on this authenticated route.
    // GET /users/handle-available?handle=x — public, used by the signup form
    // to tell people whether a handle is free before they submit. Returns the
    // normalised handle so the UI can show exactly what they'll get.
    if (event.requestContext.http.method === "GET" && /\/users\/handle-available\/?$/.test(rawPath)) {
      const raw = event.queryStringParameters?.handle;
      const v = validateHandle(raw);
      if (!v.ok) return ok({ available: false, reason: v.reason });
      const clean = checkText(v.handle, { maxLinks: 0 });
      if (!clean.ok) return ok({ available: false, reason: "Please choose a different handle." });
      const taken = await isHandleTaken(v.handle);
      return ok({
        available: !taken,
        handle: v.handle,
        reason: taken ? "That handle is already taken." : null,
      });
    }

    if (event.requestContext.http.method === "GET" && /\/users\/me\/?$/.test(rawPath)) {
      const userId = getUserId(event);
      if (!userId) return unauthorized();
      const { rows } = await query(
        `SELECT user_id, email, display_name, handle, title, bio, location, website,
                avatar_url, avatar_initials, follower_count, following_count,
                diagram_count, total_views, joined_at, auth_provider,
                dark_mode, email_notifications, is_private,
                notify_on_comment, notify_on_follow, notify_on_like
         FROM users WHERE user_id = :userId`,
        { userId }
      );
      if (!rows.length) return notFound("User not found");
      return ok(rows[0]);
    }

    if (event.requestContext.http.method === "GET") {
      const targetId = event.pathParameters?.userId || event.queryStringParameters?.handle;
      const isHandle = !!event.queryStringParameters?.handle;
      const { rows } = await query(
        `SELECT user_id, display_name, handle, title, bio, location, website, avatar_url,
                avatar_initials, follower_count, following_count, diagram_count, total_views,
                joined_at, is_private
         FROM users WHERE ${isHandle ? "handle" : "user_id"} = :target`,
        { target: targetId }
      );
      if (!rows.length) return notFound("User not found");

      // This route is unauthenticated so public profiles can be opened by a
      // recruiter with no account. getUserId returns null for a signed-out
      // visitor, which canViewProfile handles.
      const viewerId = getOptionalUserId(event);
      const access = await canViewProfile(viewerId, rows[0].user_id);

      if (!access.visible) {
        // A private profile still returns its identity — name, handle, avatar
        // and counts — so a visitor sees WHOSE profile it is and can request
        // to follow. Only the content is withheld. Returning a bare 403 would
        // make private accounts unfindable and unrequestable.
        return ok({
          user_id: rows[0].user_id,
          display_name: rows[0].display_name,
          handle: rows[0].handle,
          avatar_url: rows[0].avatar_url,
          avatar_initials: rows[0].avatar_initials,
          follower_count: rows[0].follower_count,
          following_count: rows[0].following_count,
          diagram_count: rows[0].diagram_count,
          is_private: true,
          restricted: true,
          reason: access.reason,          // 'sign_in_required' | 'not_a_follower'
          follow_status: access.followStatus, // 'pending' | null
        });
      }

      return ok({ ...rows[0], restricted: false, follow_status: access.followStatus });
    }

    if (event.requestContext.http.method === "PUT") {
      const userId = getUserId(event);
      if (!userId) return unauthorized();

      const body = parseBody(event);
      const updates = Object.keys(body).filter((k) => PROFILE_FIELDS.includes(k));
      if (!updates.length) return badRequest("No valid fields to update");

      const rejected = screenBody(body, ["display_name", "handle", "title", "bio", "location"]);
      if (rejected) return badRequest(rejected);

      const setClause = updates.map((f) => `${f} = :${f}`).join(", ");
      const params = { userId };
      updates.forEach((f) => (params[f] = body[f]));

      await query(`UPDATE users SET ${setClause} WHERE user_id = :userId`, params);
      return ok({ message: "Profile updated" });
    }

    return badRequest("Unsupported method");
  } catch (err) {
    if (err.message?.includes("Duplicate entry") && err.message?.includes("handle")) {
      return badRequest("That handle is already taken.");
    }
    return serverError(err);
  }
};
