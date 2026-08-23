const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { query, newId } = require("shared/db");
const { ok, unauthorized, serverError, parseBody } = require("shared/http");
const { getUserId } = require("shared/http");

const s3 = new S3Client({});

exports.handler = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return unauthorized();

    const { contentType } = parseBody(event);
    const ext = (contentType || "image/png").split("/")[1] || "png";
    const key = `avatars/${userId}/${newId("avatar")}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: process.env.USER_CONTENT_BUCKET,
      Key: key,
      ContentType: contentType || "image/png",
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 300 });
    const publicUrl = `https://${process.env.USER_CONTENT_BUCKET}.s3.amazonaws.com/${key}`;

    // Store the new avatar URL immediately — the frontend uploads to
    // uploadUrl right after getting this response.
    await query(`UPDATE users SET avatar_url = :url WHERE user_id = :userId`, { url: publicUrl, userId });

    return ok({ uploadUrl, publicUrl, expiresIn: 300 });
  } catch (err) {
    return serverError(err);
  }
};
