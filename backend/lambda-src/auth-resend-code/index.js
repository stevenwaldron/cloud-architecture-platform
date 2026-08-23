const { CognitoIdentityProviderClient, ResendConfirmationCodeCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { ok, badRequest, serverError, parseBody } = require("shared/http");

const cognito = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  try {
    const { email } = parseBody(event);
    if (!email) return badRequest("email is required");

    await cognito.send(new ResendConfirmationCodeCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      Username: email,
    }));

    return ok({ message: "A new code has been sent." });
  } catch (err) {
    // Same reasoning as forgot-password — don't reveal whether the email
    // exists or is already confirmed; always respond as if it worked.
    if (err.name === "UserNotFoundException" || err.name === "InvalidParameterException") {
      return ok({ message: "A new code has been sent." });
    }
    if (err.name === "LimitExceededException") return badRequest("Too many attempts — please wait a bit before requesting another code.");
    return serverError(err);
  }
};
