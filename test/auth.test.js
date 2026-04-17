const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { makeAuthMiddleware, timingSafeEqual } = require("../lib/auth");
const { requestJSON } = require("./helpers/http-client");

function makeApp(getKey, logger) {
  const app = express();
  app.use(express.json());
  app.use(makeAuthMiddleware(getKey, logger ? { logger } : {}));
  app.post("/protected", (req, res) => res.json({ ok: true }));
  return app;
}

test("auth: fails open when expected key is unset (getKey returns null)", async () => {
  const warnings = [];
  const app = makeApp(() => null, { warn: (m) => warnings.push(m), error: () => {} });

  const res = await requestJSON(app, "POST", "/protected", {});
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /UNPROTECTED/);
});

test("auth: warning logs only once across many unprotected requests", async () => {
  const warnings = [];
  const app = makeApp(() => "", { warn: (m) => warnings.push(m), error: () => {} });
  await requestJSON(app, "POST", "/protected", {});
  await requestJSON(app, "POST", "/protected", {});
  await requestJSON(app, "POST", "/protected", {});
  assert.equal(warnings.length, 1);
});

test("auth: 401 when key is set but no Authorization header", async () => {
  const app = makeApp(() => "secret-xyz");
  const res = await requestJSON(app, "POST", "/protected", {});
  assert.equal(res.status, 401);
  assert.match(res.data.error, /Unauthorized/);
});

test("auth: 401 when Authorization header is wrong", async () => {
  const app = makeApp(() => "secret-xyz");
  const res = await requestJSON(app, "POST", "/protected", {}, {
    headers: { Authorization: "Bearer wrong-key" },
  });
  assert.equal(res.status, 401);
});

test("auth: 401 when Authorization header is malformed (no Bearer prefix)", async () => {
  const app = makeApp(() => "secret-xyz");
  const res = await requestJSON(app, "POST", "/protected", {}, {
    headers: { Authorization: "secret-xyz" },
  });
  assert.equal(res.status, 401);
});

test("auth: 200 when Bearer token matches", async () => {
  const app = makeApp(() => "secret-xyz");
  const res = await requestJSON(app, "POST", "/protected", {}, {
    headers: { Authorization: "Bearer secret-xyz" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
});

test("auth: Bearer prefix is case-insensitive and tolerates extra whitespace", async () => {
  const app = makeApp(() => "secret-xyz");
  const res1 = await requestJSON(app, "POST", "/protected", {}, {
    headers: { Authorization: "bearer  secret-xyz  " },
  });
  assert.equal(res1.status, 200);
});

test("auth: key rotation takes effect on next request (getKey is called per request)", async () => {
  let current = "key-1";
  const app = makeApp(() => current);

  const ok1 = await requestJSON(app, "POST", "/protected", {}, {
    headers: { Authorization: "Bearer key-1" },
  });
  assert.equal(ok1.status, 200);

  current = "key-2";
  const stale = await requestJSON(app, "POST", "/protected", {}, {
    headers: { Authorization: "Bearer key-1" },
  });
  assert.equal(stale.status, 401);

  const fresh = await requestJSON(app, "POST", "/protected", {}, {
    headers: { Authorization: "Bearer key-2" },
  });
  assert.equal(fresh.status, 200);
});

test("timingSafeEqual: true for equal strings, false for unequal", () => {
  assert.equal(timingSafeEqual("abc", "abc"), true);
  assert.equal(timingSafeEqual("abc", "abd"), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
});

test("timingSafeEqual: false for non-string inputs", () => {
  assert.equal(timingSafeEqual(null, "abc"), false);
  assert.equal(timingSafeEqual("abc", undefined), false);
  assert.equal(timingSafeEqual(123, "123"), false);
});
