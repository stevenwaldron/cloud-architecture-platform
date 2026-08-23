const { query } = require("shared/db");
const { ok, badRequest, forbidden, serverError, getOptionalUserId } = require("shared/http");
const { canViewProfile } = require("shared/visibility");

/**
 * GET /users/{userId}/services
 *
 * Aggregates which AWS services a user has actually used across their public
 * diagrams — the equivalent of GitHub's language bar. It answers the question a
 * hiring manager is really asking ("have they touched the things we run?") in
 * about two seconds.
 *
 * Derived from stored canvas data rather than self-reported tags, so it can't
 * be inflated: you only appear to know Aurora if you've built with it here.
 *
 * The counting is done in the Lambda rather than in SQL because canvas_data is
 * a JSON blob; MySQL's JSON functions could reach into it, but the shape varies
 * across older diagrams and JS handles that far more forgivingly than SQL.
 */
exports.handler = async (event) => {
  try {
    const userId = event.pathParameters?.userId;
    if (!userId) return badRequest("userId path parameter is required");

    const access = await canViewProfile(getOptionalUserId(event), userId);
    if (!access.visible) return forbidden("This account is private");

    // Only published, public diagrams count. A private draft shouldn't
    // contribute to a public portfolio summary.
    const { rows } = await query(
      `SELECT canvas_data FROM diagrams
       WHERE user_id = :userId AND visibility = 'public' AND status = 'published'
       LIMIT 200`,
      { userId }
    );

    const counts = new Map();
    let diagramsCounted = 0;

    for (const row of rows) {
      if (!row.canvas_data) continue;
      let canvas;
      try {
        canvas = typeof row.canvas_data === "string" ? JSON.parse(row.canvas_data) : row.canvas_data;
      } catch {
        continue; // a malformed blob shouldn't sink the whole aggregation
      }
      const elements = Array.isArray(canvas?.elements) ? canvas.elements : [];
      if (!elements.length) continue;
      diagramsCounted++;

      // Count each service once per diagram. Someone who dropped twelve Lambda
      // boxes into one diagram hasn't used Lambda twelve times, and counting
      // raw instances would let a single busy diagram dominate the whole bar.
      const seen = new Set();
      for (const el of elements) {
        const name = el?.service?.name || el?.serviceName || el?.name;
        if (!name || typeof name !== "string") continue;
        const key = name.trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);

        const existing = counts.get(key) || { name: key, count: 0, color: el?.service?.color || null };
        existing.count += 1;
        if (!existing.color && el?.service?.color) existing.color = el.service.color;
        counts.set(key, existing);
      }
    }

    const services = [...counts.values()].sort((a, b) =>
      b.count - a.count || a.name.localeCompare(b.name)
    );
    const total = services.reduce((sum, s) => sum + s.count, 0);

    return ok({
      services: services.map((s) => ({
        ...s,
        // Share of the bar, so the client doesn't have to recompute it.
        percent: total ? Math.round((s.count / total) * 1000) / 10 : 0,
      })),
      totalServices: services.length,
      diagramsCounted,
    });
  } catch (err) {
    return serverError(err);
  }
};
