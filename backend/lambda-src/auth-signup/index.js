const { CognitoIdentityProviderClient, SignUpCommand, AdminGetUserCommand, ResendConfirmationCodeCommand } = require("@aws-sdk/client-cognito-identity-provider");
const { ensureUserRow, validateHandle, isHandleTaken } = require("shared/db");
const { checkText } = require("shared/moderation");
const { created, badRequest, serverError, parseBody } = require("shared/http");

const cognito = new CognitoIdentityProviderClient({});

exports.handler = async (event) => {
  try {
    const { email, password, displayName, handle } = parseBody(event);
    if (!email || !password) return badRequest("email and password are required");

    // Handle is chosen at signup. Validated here rather than trusted from the
    // client, and checked for availability before the Cognito account is
    // created so a taken handle doesn't leave a half-finished signup behind.
    let chosenHandle = null;
    if (handle) {
      const v = validateHandle(handle);
      if (!v.ok) return badRequest(v.reason);
      const clean = checkText(v.handle, { maxLinks: 0 });
      if (!clean.ok) return badRequest("Please choose a different handle.");
      if (await isHandleTaken(v.handle)) return badRequest("That handle is already taken.");
      chosenHandle = v.handle;
    }
    if (displayName) {
      const clean = checkText(displayName, { maxLinks: 0 });
      if (!clean.ok) return badRequest(clean.reason);
    }

    try {
      const signUpResult = await cognito.send(new SignUpCommand({
        ClientId: process.env.COGNITO_CLIENT_ID,
        Username: email,
        Password: password,
        UserAttributes: [{ Name: "email", Value: email }],
      }));

      await ensureUserRow(signUpResult.UserSub, email, displayName, chosenHandle);

      return created({ userId: signUpResult.UserSub, message: "Signup successful — check your email for a confirmation code." });
    } catch (err) {
      if (err.name !== "UsernameExistsException") throw err;

      // Someone (very possibly this same person, retrying after an earlier
      // attempt got interrupted) already has this email registered.
      // Whether that's a genuine duplicate or a safe retry depends on
      // whether the existing account ever got confirmed.
      const existing = await cognito.send(new AdminGetUserCommand({
        UserPoolId: process.env.COGNITO_USER_POOL_ID,
        Username: email,
      }));

      if (existing.UserStatus === "UNCONFIRMED") {
        await cognito.send(new ResendConfirmationCodeCommand({
          ClientId: process.env.COGNITO_CLIENT_ID,
          Username: email,
        }));

        const userId = existing.UserAttributes?.find((a) => a.Name === "sub")?.Value;
        if (userId) await ensureUserRow(userId, email, displayName, chosenHandle);

        return created({ userId, message: "Signup successful — check your email for a confirmation code." });
      }

      return badRequest("An account with this email already exists.");
    }
  } catch (err) {
    if (err.name === "InvalidPasswordException") return badRequest("Password doesn't meet requirements (8+ characters, upper and lowercase, a number).");
    return serverError(err);
  }
};
