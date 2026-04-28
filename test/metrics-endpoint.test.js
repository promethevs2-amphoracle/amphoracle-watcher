const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");
const { requestJSON } = require("./helpers/http-client");

test("GET /metrics returns counters and gauges as JSON", async () => {
  // Seed some metric activity so the response isn't empty.
  server.metrics.inc("polls");
  server.metrics.inc("whispers_locked", 1, { verdict: "true" });

  const res = await requestJSON(server.app, "GET", "/metrics");
  assert.equal(res.status, 200);
  assert.equal(typeof res.data.uptime_seconds, "number");
  assert.equal(typeof res.data.counters, "object");
  assert.ok(res.data.counters.polls >= 1);
  assert.equal(res.data.labeled.whispers_locked["verdict=true"], 1);
});

test("GET /metrics is unauthenticated (stays open even with WATCHER_AUTH_KEY set)", async (t) => {
  process.env.WATCHER_AUTH_KEY = "test-secret";
  t.after(() => { delete process.env.WATCHER_AUTH_KEY; });

  const res = await requestJSON(server.app, "GET", "/metrics");
  assert.equal(res.status, 200, "/metrics must stay scrapeable for monitoring");
});

test("GET /metrics surfaces live state-map sizes as gauges", async (t) => {
  t.after(() => {
    server.locked.clear();
    server.lastChecked.clear();
  });
  server.locked.set("w-a", Date.now());
  server.locked.set("w-b", Date.now());
  server.lastChecked.set("w-a", Date.now());

  const res = await requestJSON(server.app, "GET", "/metrics");
  assert.equal(res.data.gauges.locked_pending_reveal, 2);
  assert.equal(res.data.gauges.last_checked_size, 1);
});
