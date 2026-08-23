const { CognitoIdentityProviderClient, ConfirmForgotPasswordCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { ok, badRequest, serverError, parseBody } = require("shared/http");

const cognito = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  try {
    const { email, code, newPassword } = parseBody(event);
    if (!email || !code || !newPassword) return badRequest("email, code, and newPassword are required");

    await cognito.send(new ConfirmForgotPasswordCommand({
      ClientId: process.env.COGNITO_CLIENT_ID,
      Username: email,
      ConfirmationCode: code,
      Password: newPassword,
    }));

    return ok({ message: "Password reset successfully. You can now sign in." });
  } catch (err) {
    if (err.name === "CodeMismatchException") return badRequest("Incorrect reset code.");
    if (err.name === "ExpiredCodeException") return badRequest("This code has expired — request a new one.");
    if (err.name === "InvalidPasswordException") return badRequest("Password doesn't meet requirements.");
    return serverError(err);
  }
};
