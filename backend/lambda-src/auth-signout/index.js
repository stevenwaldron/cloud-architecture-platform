const { CognitoIdentityProviderClient, GlobalSignOutCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { ok, badRequest, serverError } = require("shared/http");

const cognito = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  try {
    const authHeader = event.headers?.authorization || event.headers?.Authorization;
    const accessToken = authHeader?.replace(/^Bearer\s+/i, "");
    if (!accessToken) return badRequest("Authorization header with access token is required");

    await cognito.send(new GlobalSignOutCommand({ AccessToken: accessToken }));

    return ok({ message: "Signed out on all devices." });
  } catch (err) {
    return serverError(err);
  }
};
