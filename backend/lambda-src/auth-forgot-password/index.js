const { CognitoIdentityProviderClient, ForgotPasswordCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { ok, badRequest, serverError, parseBody } = require("shared/http");

const cognito = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  try {
    const { email } = parseBody(event);
    if (!email) return badRequest("email is required");

    await cognito.send(new ForgotPasswordCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      Username: email,
    }));

    // Always return success even if the email doesn't exist — avoids
    // leaking which emails have accounts.
    return ok({ message: "If an account exists for that email, a reset code has been sent." });
  } catch (err) {
    if (err.name === "UserNotFoundException") {
      return ok({ message: "If an account exists for that email, a reset code has been sent." });
    }
    return serverError(err);
  }
};
