const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const server = require("../server");

function clearState() {
  server.locked.clear();
  server.lastChecked.clear();
  for (const t of server.revealTimers.values()) clearTimeout(t);
  server.revealTimers.clear();
}

test("gracefulShutdown: clears the poll interval timer", async (t) => {
  t.after(clearState);
  let polls = 0;
  const pollTimer = setInterval(() => { polls++; }, 1);
  // Let it tick once so we know it's actually running.
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(polls > 0, "interval should have ticked at least once");

  await server.gracefulShutdown({ pollTimer, timeoutMs: 100 });
  const before = polls;
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(polls, before, "no further ticks after gracefulShutdown");
});

test("gracefulShutdown: clears the initial-poll timeout", async (t) => {
  t.after(clearState);
  let fired = false;
  const initialTimer = setTimeout(() => { fired = true; }, 5);
  await server.gracefulShutdown({ initialTimer, timeoutMs: 100 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired, false, "initial timer should be cancelled");
});

test("gracefulShutdown: clears all pending reveal timers", async (t) => {
  t.after(clearState);
  let fired = 0;
  for (const id of ["a", "b", "c"]) {
    server.revealTimers.set(id, setTimeout(() => { fired++; }, 5));
  }
  assert.equal(server.revealTimers.size, 3);

  await server.gracefulShutdown({ timeoutMs: 100 });

  assert.equal(server.revealTimers.size, 0, "revealTimers map drained");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired, 0, "no reveal timer should fire after shutdown");
});

test("gracefulShutdown: closes the HTTP server cleanly", async (t) => {
  t.after(clearState);
  const httpServer = http.createServer((req, res) => res.end("ok"));
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  assert.equal(httpServer.listening, true);

  await server.gracefulShutdown({ httpServer, timeoutMs: 1000 });

  assert.equal(httpServer.listening, false);
});

test("gracefulShutdown: doesn't hang forever even if close() never resolves", async (t) => {
  t.after(clearState);

  // Build a fake "httpServer" whose close() never calls back. The
  // hardCutoff timeout must rescue us, otherwise the test would hang.
  const fakeServer = { close: () => {} };

  const start = Date.now();
  await server.gracefulShutdown({ httpServer: fakeServer, timeoutMs: 30 });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 200, `should exit near timeout, got ${elapsed}ms`);
});

test("gracefulShutdown: returns immediately when no httpServer provided", async (t) => {
  t.after(clearState);
  const start = Date.now();
  await server.gracefulShutdown({ timeoutMs: 5000 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 50, "should resolve fast with no httpServer to close");
});
