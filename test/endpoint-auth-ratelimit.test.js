const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");
const { requestJSON } = require("./helpers/http-client");
const { claudeResponse, queuedHttpRequest, stubFetchURL } = require("./helpers/mocks");

function resetAll() {
  server.__resetHttpRequest();
  server.__resetFetchURL();
  server.__resetLimiters();
  delete process.env.WATCHER_AUTH_KEY;
}

test("/scout 401s when WATCHER_AUTH_KEY is set and no Authorization header", async (t) => {
  t.after(resetAll);
  process.env.WATCHER_AUTH_KEY = "test-secret";

  const res = await requestJSON(server.app, "POST", "/scout", {
    topic: "bitcoin",
    category: "stocks_crypto",
  });
  assert.equal(res.status, 401);
});

test("/scout 401s when WATCHER_AUTH_KEY is set and Authorization is wrong", async (t) => {
  t.after(resetAll);
  process.env.WATCHER_AUTH_KEY = "test-secret";

  const res = await requestJSON(server.app, "POST", "/scout", {
    topic: "bitcoin",
    category: "stocks_crypto",
  }, { headers: { Authorization: "Bearer wrong" } });
  assert.equal(res.status, 401);
});

test("/scout allows request when Authorization matches WATCHER_AUTH_KEY", async (t) => {
  t.after(resetAll);
  process.env.WATCHER_AUTH_KEY = "test-secret";

  server.__setFetchURL(stubFetchURL({
    "https://www.espn.com/search/results?q=ufc": "some event content",
    "https://www.bbc.com/sport": "sport news",
    "https://www.sofascore.com": "scores",
  }));
  server.__setHttpRequest(queuedHttpRequest([
    claudeResponse(JSON.stringify({ whispers: [] })),
  ]));

  const res = await requestJSON(server.app, "POST", "/scout", {
    topic: "ufc",
    category: "sports",
  }, { headers: { Authorization: "Bearer test-secret" } });

  // Zero whispers from Claude -> success:false with empty list (not 401)
  assert.equal(res.status, 200);
  assert.equal(res.data.success, false);
});

test("/reveal 401s when auth is set and header is missing (validation still runs only after auth)", async (t) => {
  t.after(resetAll);
  process.env.WATCHER_AUTH_KEY = "test-secret";

  // Even with missing body fields, auth fires first -> 401 (not 400).
  const res = await requestJSON(server.app, "POST", "/reveal", {});
  assert.equal(res.status, 401);
});

test("/reveal 400s on bad body when auth is satisfied", async (t) => {
  t.after(resetAll);
  process.env.WATCHER_AUTH_KEY = "test-secret";

  const res = await requestJSON(server.app, "POST", "/reveal", {}, {
    headers: { Authorization: "Bearer test-secret" },
  });
  assert.equal(res.status, 400);
});

test("/recommend-date 401s without auth when key is set", async (t) => {
  t.after(resetAll);
  process.env.WATCHER_AUTH_KEY = "test-secret";
  const res = await requestJSON(server.app, "POST", "/recommend-date", {
    whisper_title: "Will it?",
    category: "politics",
  });
  assert.equal(res.status, 401);
});

test("GET / (health) stays open even when auth key is set", async (t) => {
  t.after(resetAll);
  process.env.WATCHER_AUTH_KEY = "test-secret";

  const res = await requestJSON(server.app, "GET", "/");
  assert.equal(res.status, 200);
  assert.equal(res.data.status, "online");
});

test("rate-limit: /reveal 429s after 30 rapid requests from same IP", async (t) => {
  t.after(resetAll);
  // Leave WATCHER_AUTH_KEY unset so auth passes through. We want to
  // isolate the rate-limit behavior.

  let status429Seen = false;
  // The limiter is 30/min; blast 35 to confirm we see at least one 429.
  for (let i = 0; i < 35; i++) {
    // Missing body fields -> endpoint returns 400 quickly with no
    // Claude/Base44 calls. That's fine for rate-limit testing since
    // the limiter runs BEFORE body validation.
    const res = await requestJSON(server.app, "POST", "/reveal", {});
    if (res.status === 429) { status429Seen = true; break; }
  }
  assert.equal(status429Seen, true, "expected a 429 before request #35");
});

test("rate-limit: /scout 429s after 10 rapid requests from same IP", async (t) => {
  t.after(resetAll);

  let status429Seen = false;
  for (let i = 0; i < 15; i++) {
    const res = await requestJSON(server.app, "POST", "/scout", {});
    if (res.status === 429) { status429Seen = true; break; }
  }
  assert.equal(status429Seen, true, "expected a 429 on /scout before request #15");
});

test("rate-limit: 429 response includes Retry-After header", async (t) => {
  t.after(resetAll);

  let blocked = null;
  for (let i = 0; i < 15; i++) {
    const res = await requestJSON(server.app, "POST", "/scout", {});
    if (res.status === 429) { blocked = res; break; }
  }
  assert.ok(blocked, "should have been blocked");
  assert.ok(blocked.headers["retry-after"]);
  assert.ok(blocked.data.retry_after_seconds >= 1);
});

test("rate-limit: independent buckets per endpoint (exhausting /scout does not block /reveal)", async (t) => {
  t.after(resetAll);

  // Exhaust /scout
  for (let i = 0; i < 15; i++) {
    await requestJSON(server.app, "POST", "/scout", {});
  }

  // /reveal should still be in its own bucket
  const res = await requestJSON(server.app, "POST", "/reveal", {});
  assert.equal(res.status, 400, "/reveal should still respond normally (400 for missing body)");
});
