const { CognitoIdentityProviderClient, InitiateAuthCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { query, ensureUserRow } = require("shared/db");
const { ok, unauthorized, badRequest, serverError, parseBody, decodeJwtPayload } = require("shared/http");

const cognito = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  try {
    const { email, password } = parseBody(event);
    if (!email || !password) return badRequest("email and password are required");

    const result = await cognito.send(new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: process.env.COGNITO_CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    }));

    // Self-healing: if an earlier bug ever let this Cognito account get
    // created without its local users row (exactly what happened during
    // this project's own debugging history), repair it right here rather
    // than leaving an account that can authenticate but can't actually do
    // anything requiring that row (like saving a diagram).
    const claims = decodeJwtPayload(result.AuthenticationResult.IdToken);
    if (claims.sub) await ensureUserRow(claims.sub, email);

    await query(`UPDATE users SET last_log_in_at = NOW() WHERE email = :email`, { email });

    return ok({
      accessToken: result.AuthenticationResult.AccessToken,
      idToken: result.AuthenticationResult.IdToken,
      refreshToken: result.AuthenticationResult.RefreshToken,
      expiresIn: result.AuthenticationResult.ExpiresIn,
    });
  } catch (err) {
    if (err.name === "NotAuthorizedException") return unauthorized("Incorrect email or password.");
    if (err.name === "UserNotConfirmedException") return unauthorized("Please confirm your email before signing in.");
    return serverError(err);
  }
};
