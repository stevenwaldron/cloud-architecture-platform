const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { query, newId } = require("shared/db");
const { ok, notFound, forbidden, badRequest, unauthorized, serverError, getUserId } = require("shared/http");

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

    const key = `thumbnails/${userId}/${diagramId}/${newId("thumb")}.png`;

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: process.env.USER_CONTENT_BUCKET, Key: key, ContentType: "image/png" }),
      { expiresIn: 300 }
    );
    const publicUrl = `https://${process.env.USER_CONTENT_BUCKET}.s3.amazonaws.com/${key}`;

    await query(`UPDATE diagrams SET thumbnail_url = :url WHERE diagram_id = :diagramId`, { url: publicUrl, diagramId });

    return ok({ uploadUrl, publicUrl, expiresIn: 300 });
  } catch (err) {
    return serverError(err);
  }
};
