const { test } = require("node:test");
const assert = require("node:assert");
const { checkText } = require("../lambda-layer/nodejs/node_modules/shared/moderation");

// These tests exist because the moderation filter has two failure modes and
// they pull in opposite directions. Too permissive and abuse gets through; too
// aggressive and it blocks ordinary cloud engineering discussion, which is full
// of words a naive filter flags — "kill the process", "terminate the instance",
// "master node", "attack surface".
//
// The false-positive cases matter more than the abuse cases here. Blocked abuse
// is invisible; a blocked legitimate comment is a user who thinks the site is
// broken and doesn't report it.

test("allows ordinary cloud engineering language", () => {
  const allowed = [
    "Kill the process on the master node and terminate the EC2 instance",
    "This reduces the attack surface and aborts the deployment",
    "Use IAM, VPC, ECS, EKS and RDS — great architecture!",
    "Nice serverless setup! How do you handle cold starts?",
    "The execution role needs permission to invoke the target Lambda",
    "We had to kill a runaway query that was blocking the master",
    "Force-terminate the instance if the health check fails twice",
  ];
  for (const text of allowed) {
    const result = checkText(text);
    assert.strictEqual(result.ok, true, `should allow: "${text}" (blocked: ${result.reason})`);
  }
});

test("blocks threats of violence", () => {
  for (const text of ["I will kill you", "kys", "go kill yourself", "I hope you die"]) {
    assert.strictEqual(checkText(text).ok, false, `should block: "${text}"`);
  }
});

test("blocks slurs, including obfuscated forms", () => {
  // Normalisation handles digit substitution and spacing, which are the two
  // cheapest evasions. It will not catch a determined attempt — this filter is
  // a first line of defence, not a guarantee.
  for (const text of ["f a g g o t", "n1gg3r", "you are a retard"]) {
    assert.strictEqual(checkText(text).ok, false, `should block: "${text}"`);
  }
});

test("blocks spam patterns", () => {
  for (const text of [
    "Click here to claim your free crypto giveaway",
    "Buy cheap viagra now",
  ]) {
    assert.strictEqual(checkText(text).ok, false, `should block: "${text}"`);
  }
});

test("blocks shouting only in longer text", () => {
  // Short acronyms are normal in this domain and must survive.
  assert.strictEqual(checkText("VPC EC2 IAM RDS EKS").ok, true, "acronyms must be allowed");
  assert.strictEqual(checkText("WOW!").ok, true, "short exclamations must be allowed");
  assert.strictEqual(
    checkText("THIS IS A REALLY GREAT DIAGRAM AND I LOVE EVERYTHING ABOUT IT").ok,
    false,
    "sustained all-caps should be blocked"
  );
});

test("enforces the link limit, and respects allowLinks:false", () => {
  const threeLinks = "See https://a.com and https://b.com and https://c.com";
  assert.strictEqual(checkText(threeLinks, { maxLinks: 3 }).ok, true);
  assert.strictEqual(checkText(threeLinks, { maxLinks: 2 }).ok, false);
  assert.strictEqual(checkText("https://a.com", { allowLinks: false }).ok, false);
});

test("empty and whitespace input is allowed, not crashed on", () => {
  // Callers pass user input directly; the filter must never throw.
  for (const text of ["", "   ", null, undefined]) {
    assert.strictEqual(checkText(text).ok, true);
  }
});

test("rejections always carry a reason for the user", () => {
  const result = checkText("I will kill you");
  assert.strictEqual(result.ok, false);
  assert.ok(typeof result.reason === "string" && result.reason.length > 0,
    "a blocked message must explain itself, or the user cannot fix it");
});
