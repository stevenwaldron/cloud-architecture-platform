const { CognitoIdentityProviderClient, InitiateAuthCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { ok, unauthorized, badRequest, serverError, parseBody } = require("shared/http");

const cognito = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  try {
    const { refreshToken } = parseBody(event);
    if (!refreshToken) return badRequest("refreshToken is required");

    const result = await cognito.send(new InitiateAuthCommand({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: process.env.COGNITO_CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }));

    return ok({
      accessToken: result.AuthenticationResult.AccessToken,
      idToken: result.AuthenticationResult.IdToken,
      expiresIn: result.AuthenticationResult.ExpiresIn,
    });
  } catch (err) {
    if (err.name === "NotAuthorizedException") return unauthorized("Refresh token is invalid or expired — please sign in again.");
    return serverError(err);
  }
};
