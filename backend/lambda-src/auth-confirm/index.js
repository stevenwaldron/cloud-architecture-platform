const { CognitoIdentityProviderClient, ConfirmSignUpCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { query } = require("shared/db");
const { ok, badRequest, serverError, parseBody } = require("shared/http");

const cognito = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  try {
    const { email, code } = parseBody(event);
    if (!email || !code) return badRequest("email and code are required");

    await cognito.send(new ConfirmSignUpCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      Username: email,
      ConfirmationCode: code,
    }));

    await query(`UPDATE users SET email_verified = TRUE WHERE email = :email`, { email });

    return ok({ message: "Email confirmed. You can now sign in." });
  } catch (err) {
    if (err.name === "CodeMismatchException") return badRequest("Incorrect confirmation code.");
    if (err.name === "ExpiredCodeException") return badRequest("This code has expired — request a new one.");
    return serverError(err);
  }
};
