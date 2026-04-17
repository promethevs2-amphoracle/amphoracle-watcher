const test = require("node:test");
const assert = require("node:assert/strict");
const server = require("../server");
const { base44List, base44Ok, queuedHttpRequest } = require("./helpers/mocks");

function clearState() {
  server.locked.clear();
  server.lastChecked.clear();
  for (const t of server.revealTimers.values()) clearTimeout(t);
  server.revealTimers.clear();
  server.__resetHttpRequest();
  server.__resetFetchURL();
}

test("lockWhisper: writes 'fetched' + 'locked', records state, schedules reveal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    t.mock.timers.reset();
    clearState();
  });

  const http = queuedHttpRequest([
    base44Ok(), // PATCH OracleWatcher -> fetched
    base44Ok(), // PATCH Whisper -> locked
    base44List([]), // getVotersForWhisper -> no voters
  ]);
  server.__setHttpRequest(http);

  const watcher = { id: "watcher-1", whisper_id: "whisper-1", whisper_title: "Will X?" };
  await server.lockWhisper(watcher, "true", 92, "reasoning", "evidence");

  assert.equal(server.locked.has("whisper-1"), true, "locked map records whisper");
  assert.equal(server.revealTimers.has("whisper-1"), true, "reveal timer is scheduled");

  const patchWatcher = http.calls[0];
  assert.match(patchWatcher.options.path, /OracleWatcher\/watcher-1$/);
  const watcherBody = JSON.parse(patchWatcher.body);
  assert.equal(watcherBody.status, "fetched");
  assert.equal(watcherBody.oracle_verdict, "true");
  assert.equal(watcherBody.oracle_confidence, 92);

  const patchWhisper = http.calls[1];
  assert.match(patchWhisper.options.path, /Whisper\/whisper-1$/);
  const whisperBody = JSON.parse(patchWhisper.body);
  assert.equal(whisperBody.status, "locked");
  assert.ok(whisperBody.oracle_lock_time);
  assert.ok(whisperBody.reveal_scheduled_for);

  // reveal_scheduled_for should be ~LOCK_TO_REVEAL_MS after lock_time
  // (two separate Date.now() calls in the handler; allow a small delta).
  const lockMs = Date.parse(whisperBody.oracle_lock_time);
  const revealMs = Date.parse(whisperBody.reveal_scheduled_for);
  const delta = revealMs - lockMs;
  assert.ok(
    Math.abs(delta - server.LOCK_TO_REVEAL_MS) < 100,
    `expected ~${server.LOCK_TO_REVEAL_MS}ms gap, got ${delta}ms`,
  );
});

test("executeReveal: writes 'revealed' to both entities and cleans up state", async (t) => {
  t.after(clearState);

  const http = queuedHttpRequest([
    base44Ok(), // PATCH OracleWatcher -> revealed
    base44Ok(), // PATCH Whisper -> revealed
    base44List([]), // getVotersForWhisper -> no voters
  ]);
  server.__setHttpRequest(http);

  server.locked.set("whisper-2", Date.now());
  server.revealTimers.set("whisper-2", setTimeout(() => {}, 0));

  await server.executeReveal(
    { id: "watcher-2", whisper_id: "whisper-2", whisper_title: "Will Y?" },
    "false",
    90,
    "reasoning",
  );

  assert.equal(server.locked.has("whisper-2"), false);
  assert.equal(server.revealTimers.has("whisper-2"), false);

  const patchWhisper = http.calls[1];
  const body = JSON.parse(patchWhisper.body);
  assert.equal(body.status, "revealed");
  assert.equal(body.verdict, "false");
  assert.equal(body.confidence, 90);
  assert.ok(body.revealed_at);
});

test("lockWhisper schedules reveal exactly LOCK_TO_REVEAL_MS in the future", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    t.mock.timers.reset();
    clearState();
  });

  // First queue: lockWhisper's 3 calls. Then after tick: executeReveal's 3 calls.
  const http = queuedHttpRequest([
    base44Ok(),
    base44Ok(),
    base44List([]),
    base44Ok(),
    base44Ok(),
    base44List([]),
  ]);
  server.__setHttpRequest(http);

  const watcher = { id: "w", whisper_id: "whisper-3", whisper_title: "T" };
  await server.lockWhisper(watcher, "true", 99, "r", "e");

  // Before tick: locked, timer pending
  assert.equal(server.locked.has("whisper-3"), true);
  assert.equal(server.revealTimers.has("whisper-3"), true);

  // Advance just shy of the reveal window — still locked
  t.mock.timers.tick(server.LOCK_TO_REVEAL_MS - 1);
  assert.equal(server.locked.has("whisper-3"), true);

  // Advance the final ms — reveal fires
  t.mock.timers.tick(1);
  // The reveal handler is async; let its promise microtasks drain.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(server.locked.has("whisper-3"), false, "executeReveal should clear locked");
  assert.equal(server.revealTimers.has("whisper-3"), false, "executeReveal should clear timer map");
});

test("LOCK_TO_REVEAL_MS is 15 minutes — business rule pin", () => {
  assert.equal(server.LOCK_TO_REVEAL_MS, 15 * 60 * 1000);
});
