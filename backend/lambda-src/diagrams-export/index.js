const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { query, newId } = require("shared/db");
const { ok, notFound, forbidden, badRequest, unauthorized, serverError, parseBody, getUserId } = require("shared/http");

const s3 = new S3Client({});

exports.handler = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return unauthorized();

    const diagramId = event.pathParameters?.diagramId;
    if (!diagramId) return badRequest("diagramId path parameter is required");

    const { rows } = await query(`SELECT user_id FROM diagrams WHERE diagram_id = :diagramId`, { diagramId });
    if (!rows.length) return notFound("Diagram not found");
    if (rows[0].user_id !== userId) return forbidden("You don't own this diagram");

    if (event.requestContext.http.method === "POST") {
      // Frontend wants to upload a rendered export (PNG/PDF) — hand back a
      // presigned PUT URL.
      const { contentType } = parseBody(event);
      const ext = contentType?.includes("pdf") ? "pdf" : "png";
      const key = `exports/${userId}/${diagramId}/${newId("export")}.${ext}`;

      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: process.env.USER_CONTENT_BUCKET, Key: key, ContentType: contentType || "image/png" }),
        { expiresIn: 300 }
      );
      const publicUrl = `https://${process.env.USER_CONTENT_BUCKET}.s3.amazonaws.com/${key}`;

      await query(`UPDATE diagrams SET export_url = :url WHERE diagram_id = :diagramId`, { url: publicUrl, diagramId });

      return ok({ uploadUrl, publicUrl, expiresIn: 300 });
    }

    if (event.requestContext.http.method === "GET") {
      // Frontend wants to download the current export — hand back a
      // presigned GET URL (the bucket itself stays fully private).
      const { rows: diagramRows } = await query(`SELECT export_url FROM diagrams WHERE diagram_id = :diagramId`, { diagramId });
      if (!diagramRows[0]?.export_url) return notFound("No export exists for this diagram yet");

      const key = diagramRows[0].export_url.split(".com/")[1];
      const downloadUrl = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: process.env.USER_CONTENT_BUCKET, Key: key }),
        { expiresIn: 300 }
      );

      return ok({ downloadUrl, expiresIn: 300 });
    }

    return badRequest("Unsupported method");
  } catch (err) {
    return serverError(err);
  }
};
