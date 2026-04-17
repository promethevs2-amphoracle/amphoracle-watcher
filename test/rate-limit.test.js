const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { makeRateLimit } = require("../lib/rate-limit");
const { requestJSON } = require("./helpers/http-client");

function makeApp(limiter) {
  const app = express();
  app.set("trust proxy", true);
  app.use(limiter);
  app.get("/", (req, res) => res.json({ ok: true }));
  return app;
}

function mkReq(key) {
  // Fake an express-like req with just enough shape for the limiter.
  return { ip: key, socket: { remoteAddress: key }, headers: {} };
}
function mkRes() {
  const res = {
    statusCode: 200,
    body: null,
    headersSent: {},
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
    set(name, value) { this.headersSent[name] = value; return this; },
  };
  return res;
}

test("rate-limit: allows up to max within window", () => {
  const limiter = makeRateLimit({ windowMs: 60_000, max: 3 });
  let called = 0;
  const next = () => { called++; };
  for (let i = 0; i < 3; i++) limiter(mkReq("1.2.3.4"), mkRes(), next);
  assert.equal(called, 3);
});

test("rate-limit: blocks with 429 once max is exceeded", () => {
  const limiter = makeRateLimit({ windowMs: 60_000, max: 2 });
  let called = 0;
  const next = () => { called++; };

  limiter(mkReq("1.2.3.4"), mkRes(), next);
  limiter(mkReq("1.2.3.4"), mkRes(), next);

  const blockedRes = mkRes();
  limiter(mkReq("1.2.3.4"), blockedRes, next);

  assert.equal(called, 2, "next should have been called only twice");
  assert.equal(blockedRes.statusCode, 429);
  assert.match(blockedRes.body.error, /Too many requests/);
  assert.ok(blockedRes.body.retry_after_seconds >= 1);
  assert.ok(blockedRes.headersSent["Retry-After"]);
});

test("rate-limit: window slides — old samples drop, new requests allowed", () => {
  let nowMs = 1_000_000;
  const limiter = makeRateLimit({ windowMs: 10_000, max: 2, now: () => nowMs });
  let called = 0;
  const next = () => { called++; };

  limiter(mkReq("k"), mkRes(), next);
  nowMs += 1_000;
  limiter(mkReq("k"), mkRes(), next);
  // Third in the window -> blocked
  const blocked = mkRes();
  limiter(mkReq("k"), blocked, next);
  assert.equal(blocked.statusCode, 429);
  assert.equal(called, 2);

  // Advance past the window for the first sample -> should allow one more
  nowMs += 10_001;
  const ok = mkRes();
  limiter(mkReq("k"), ok, next);
  assert.equal(ok.statusCode, 200, "sliding window should admit request after oldest sample expires");
  assert.equal(called, 3);
});

test("rate-limit: is per-key (per-IP)", () => {
  const limiter = makeRateLimit({ windowMs: 60_000, max: 1 });
  let called = 0;
  const next = () => { called++; };

  limiter(mkReq("a"), mkRes(), next);
  limiter(mkReq("b"), mkRes(), next);
  limiter(mkReq("c"), mkRes(), next);
  assert.equal(called, 3, "different keys get independent buckets");

  // Each one now at limit; another from `a` should be blocked
  const blocked = mkRes();
  limiter(mkReq("a"), blocked, next);
  assert.equal(blocked.statusCode, 429);
});

test("rate-limit: Retry-After reflects oldest-sample age within window", () => {
  let nowMs = 1_000_000;
  const limiter = makeRateLimit({ windowMs: 60_000, max: 1, now: () => nowMs });
  const next = () => {};

  limiter(mkReq("k"), mkRes(), next);
  nowMs += 20_000;
  const blocked = mkRes();
  limiter(mkReq("k"), blocked, next);
  // First sample was at t=1_000_000, window is 60s, we're 20s in -> retry in ~40s
  assert.ok(blocked.body.retry_after_seconds >= 39 && blocked.body.retry_after_seconds <= 41);
});

test("rate-limit: keys with no recent activity get swept out of memory", () => {
  let nowMs = 1_000_000;
  const limiter = makeRateLimit({ windowMs: 10_000, max: 5, now: () => nowMs });
  const next = () => {};

  limiter(mkReq("old"), mkRes(), next);
  assert.equal(limiter._buckets.has("old"), true);

  // Advance far past the window, then touch a different key to trigger the sweep.
  nowMs += 30_000;
  limiter(mkReq("new"), mkRes(), next);

  assert.equal(limiter._buckets.has("old"), false, "stale key should be dropped on sweep");
  assert.equal(limiter._buckets.has("new"), true);
});

test("rate-limit: maxKeys cap prevents unbounded growth", () => {
  const limiter = makeRateLimit({ windowMs: 60_000, max: 10, maxKeys: 3 });
  const next = () => {};
  for (let i = 0; i < 10; i++) limiter(mkReq("k-" + i), mkRes(), next);
  assert.ok(limiter._buckets.size <= 3, `expected <= 3 buckets, got ${limiter._buckets.size}`);
});

test("rate-limit: integrates with Express — returns 429 over the wire", async () => {
  const limiter = makeRateLimit({ windowMs: 60_000, max: 2 });
  const app = makeApp(limiter);

  const r1 = await requestJSON(app, "GET", "/");
  assert.equal(r1.status, 200);
  const r2 = await requestJSON(app, "GET", "/");
  assert.equal(r2.status, 200);
  const r3 = await requestJSON(app, "GET", "/");
  assert.equal(r3.status, 429);
  assert.ok(r3.headers["retry-after"]);
});
