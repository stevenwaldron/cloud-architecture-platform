const { test } = require("node:test");
const assert = require("node:assert");
const {
  ok, badRequest, unauthorized, forbidden, notFound,
  getUserId, getOptionalUserId, parseBody,
} = require("../lambda-layer/nodejs/node_modules/shared/http");

// Builds a JWT-shaped string. Only the payload segment is real — these helpers
// decode without verifying, which is precisely why the expiry check below
// matters and is worth testing.
function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.signature`;
}

const NOW = Math.floor(Date.now() / 1000);

test("status helpers return the right codes and a JSON body", () => {
  assert.strictEqual(ok({ a: 1 }).statusCode, 200);
  assert.strictEqual(badRequest("nope").statusCode, 400);
  assert.strictEqual(unauthorized().statusCode, 401);
  assert.strictEqual(forbidden().statusCode, 403);
  assert.strictEqual(notFound().statusCode, 404);
  assert.deepStrictEqual(JSON.parse(ok({ a: 1 }).body), { a: 1 });
});

test("getUserId reads the authorizer claim and nothing else", () => {
  const withClaim = { requestContext: { authorizer: { jwt: { claims: { sub: "user-123" } } } } };
  assert.strictEqual(getUserId(withClaim), "user-123");

  // On routes that allow anonymous access the authorizer never runs, so this
  // must return null rather than inventing an identity.
  assert.strictEqual(getUserId({ requestContext: {} }), null);
  assert.strictEqual(getUserId({}), null);
});

test("getOptionalUserId prefers the verified authorizer claim", () => {
  const event = {
    requestContext: { authorizer: { jwt: { claims: { sub: "verified-user" } } } },
    headers: { authorization: "Bearer " + fakeJwt({ sub: "header-user", exp: NOW + 3600 }) },
  };
  // When the authorizer has run, its claim is verified and must win over the
  // unverified header.
  assert.strictEqual(getOptionalUserId(event), "verified-user");
});

test("getOptionalUserId falls back to the header on anonymous-allowed routes", () => {
  // This is the case that was broken in production: public routes skip the
  // authorizer, so a signed-in follower looked anonymous and was refused
  // access to an account they legitimately followed.
  const event = { headers: { authorization: "Bearer " + fakeJwt({ sub: "abc", exp: NOW + 3600 }) } };
  assert.strictEqual(getOptionalUserId(event), "abc");

  // Bare token without the Bearer prefix should also work.
  assert.strictEqual(
    getOptionalUserId({ headers: { Authorization: fakeJwt({ sub: "abc", exp: NOW + 3600 }) } }),
    "abc"
  );
});

test("getOptionalUserId REJECTS expired tokens", () => {
  // The security-critical case. This helper decodes without verifying the
  // signature, so the expiry check is the only thing preventing a stale token
  // from lingering as a usable identity.
  const expired = { headers: { authorization: "Bearer " + fakeJwt({ sub: "abc", exp: NOW - 60 }) } };
  assert.strictEqual(getOptionalUserId(expired), null);
});

test("getOptionalUserId returns null for malformed input rather than throwing", () => {
  // Called on public routes, so the input is attacker-controlled. It must
  // degrade to "anonymous" rather than crash the request.
  const cases = [
    {},
    { headers: {} },
    { headers: { authorization: "Bearer not.a.jwt" } },
    { headers: { authorization: "Bearer " } },
    { headers: { authorization: "garbage" } },
  ];
  for (const event of cases) {
    assert.strictEqual(getOptionalUserId(event), null, `should be null for ${JSON.stringify(event)}`);
  }
});

test("parseBody handles JSON, base64 and malformed bodies", () => {
  assert.deepStrictEqual(parseBody({ body: '{"a":1}' }), { a: 1 });
  assert.deepStrictEqual(
    parseBody({ body: Buffer.from('{"a":1}').toString("base64"), isBase64Encoded: true }),
    { a: 1 }
  );
  // Malformed input returns an empty object rather than throwing, so a bad
  // request produces a 400 from validation instead of a 500 from a crash.
  assert.deepStrictEqual(parseBody({ body: "not json" }), {});
  assert.deepStrictEqual(parseBody({}), {});
});
