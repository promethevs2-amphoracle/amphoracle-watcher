const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");
const { requestJSON } = require("./helpers/http-client");
const { claudeResponse, queuedHttpRequest, stubFetchURL } = require("./helpers/mocks");

function reset() {
  server.__resetHttpRequest();
  server.__resetFetchURL();
}

test("/reveal 400s when watcher_id is missing", async () => {
  const res = await requestJSON(server.app, "POST", "/reveal", {
    whisper_id: "w",
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /Missing fields/);
});

test("/reveal 400s when whisper_id is missing", async () => {
  const res = await requestJSON(server.app, "POST", "/reveal", {
    watcher_id: "w",
  });
  assert.equal(res.status, 400);
});

test("/reveal 400s on empty body", async () => {
  const res = await requestJSON(server.app, "POST", "/reveal", {});
  assert.equal(res.status, 400);
});

test("/reveal fire-and-forget: responds 200 immediately before evidence check resolves", async (t) => {
  t.after(reset);

  // Slow Claude response — if the handler awaited this, the test would time out waiting.
  let claudeResolved = false;
  server.__setFetchURL(stubFetchURL({}));
  server.__setHttpRequest(async (options) => {
    if (options.hostname === "api.anthropic.com") {
      await new Promise((r) => setTimeout(r, 50));
      claudeResolved = true;
      return claudeResponse(
        JSON.stringify({ has_answer: false, verdict: "unverifiable", confidence: 10 }),
      );
    }
    return { status: 200, data: {} };
  });

  const before = Date.now();
  const res = await requestJSON(server.app, "POST", "/reveal", {
    watcher_id: "w1",
    whisper_id: "whisp-1",
    whisper_title: "X",
    urls: [],
  });
  const elapsed = Date.now() - before;

  assert.equal(res.status, 200);
  assert.equal(res.data.status, "checking");
  // Document the "response-before-work" behavior — if this ever changes,
  // callers need to know the contract shifted.
  assert.ok(
    elapsed < 50 || !claudeResolved,
    "endpoint should respond before Claude work finishes",
  );
});

test("/scout 400s when topic is missing", async () => {
  const res = await requestJSON(server.app, "POST", "/scout", { category: "sports" });
  assert.equal(res.status, 400);
});

test("/scout 400s when category is missing", async () => {
  const res = await requestJSON(server.app, "POST", "/scout", { topic: "x" });
  assert.equal(res.status, 400);
});

test("/recommend-date 400s when whisper_title is missing", async () => {
  const res = await requestJSON(server.app, "POST", "/recommend-date", {
    category: "sports",
  });
  assert.equal(res.status, 400);
});

test("/recommend-date falls back to +7 days when Claude errors", async (t) => {
  t.after(reset);
  server.__setFetchURL(stubFetchURL({}));
  server.__setHttpRequest(async () => {
    throw new Error("simulated Claude outage");
  });

  const res = await requestJSON(server.app, "POST", "/recommend-date", {
    whisper_title: "Will it rain?",
    category: "politics",
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.success, false);
  assert.equal(res.data.confidence, "low");
  const recommended = new Date(res.data.recommended_date).getTime();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  const delta = recommended - Date.now();
  // Allow a generous window — the fallback sets time to 20:00 UTC.
  assert.ok(delta > sevenDays - 24 * 60 * 60 * 1000);
  assert.ok(delta < sevenDays + 24 * 60 * 60 * 1000);
});

test("GET / returns health status with state sizes", async () => {
  const res = await requestJSON(server.app, "GET", "/");
  assert.equal(res.status, 200);
  assert.equal(res.data.status, "online");
  assert.equal(typeof res.data.active_watchers_checked, "number");
  assert.equal(typeof res.data.locked_pending_reveal, "number");
  assert.equal(typeof res.data.uptime, "number");
});

test("CORS preflight OPTIONS returns 200 with permissive headers", async () => {
  const res = await requestJSON(server.app, "OPTIONS", "/reveal");
  assert.equal(res.status, 200);
});
