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

test("recoverRevealTimers: no locked whispers is a no-op", async (t) => {
  t.after(clearState);

  const http = queuedHttpRequest([base44List([])]);
  server.__setHttpRequest(http);

  const result = await server.recoverRevealTimers();

  assert.deepEqual(result, { recovered: 0, fired: 0, scheduled: 0, skipped: 0 });
  assert.equal(server.revealTimers.size, 0);
  assert.equal(server.locked.size, 0);
  assert.equal(http.calls.length, 1, "only the initial list call should be made");
});

test("recoverRevealTimers: reveal in the future re-schedules a timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    t.mock.timers.reset();
    clearState();
  });

  const nowIso = new Date().toISOString();
  const revealIn10Min = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const http = queuedHttpRequest([
    base44List([
      {
        id: "whisper-future",
        title: "Will it rain?",
        status: "locked",
        oracle_lock_time: nowIso,
        reveal_scheduled_for: revealIn10Min
      }
    ]),
    base44List([
      {
        id: "watcher-future",
        whisper_id: "whisper-future",
        oracle_verdict: "true",
        oracle_confidence: 92,
        oracle_reasoning: "clouds gathered"
      }
    ])
  ]);
  server.__setHttpRequest(http);

  const result = await server.recoverRevealTimers();

  assert.equal(result.recovered, 1);
  assert.equal(result.scheduled, 1);
  assert.equal(result.fired, 0);
  assert.equal(server.revealTimers.has("whisper-future"), true);
  assert.equal(server.locked.has("whisper-future"), true);
});

test("recoverRevealTimers: past reveal time fires executeReveal immediately", async (t) => {
  t.after(clearState);

  const pastLock = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const pastReveal = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const http = queuedHttpRequest([
    base44List([
      {
        id: "whisper-past",
        title: "Will X happen?",
        status: "locked",
        oracle_lock_time: pastLock,
        reveal_scheduled_for: pastReveal
      }
    ]),
    base44List([
      {
        id: "watcher-past",
        whisper_id: "whisper-past",
        oracle_verdict: "false",
        oracle_confidence: 88,
        oracle_reasoning: "event concluded"
      }
    ]),
    base44Ok(),      // executeReveal -> PATCH OracleWatcher
    base44Ok(),      // executeReveal -> PATCH Whisper
    base44List([])   // executeReveal -> getVotersForWhisper
  ]);
  server.__setHttpRequest(http);

  const result = await server.recoverRevealTimers();

  assert.equal(result.recovered, 1);
  assert.equal(result.fired, 1);
  assert.equal(result.scheduled, 0);

  // Let the async executeReveal drain.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // After executeReveal finishes, state maps are cleaned up.
  assert.equal(server.locked.has("whisper-past"), false);
  assert.equal(server.revealTimers.has("whisper-past"), false);

  // Verify the PATCH bodies match what executeReveal would write.
  const watcherPatch = http.calls.find((c) => /OracleWatcher\/watcher-past$/.test(c.options.path));
  assert.ok(watcherPatch, "OracleWatcher PATCH should have been made");
  const watcherBody = JSON.parse(watcherPatch.body);
  assert.equal(watcherBody.status, "revealed");

  const whisperPatch = http.calls.find((c) => /Whisper\/whisper-past$/.test(c.options.path));
  assert.ok(whisperPatch, "Whisper PATCH should have been made");
  const whisperBody = JSON.parse(whisperPatch.body);
  assert.equal(whisperBody.status, "revealed");
  assert.equal(whisperBody.verdict, "false");
  assert.equal(whisperBody.confidence, 88);
});

test("recoverRevealTimers: skips whisper missing reveal_scheduled_for", async (t) => {
  t.after(clearState);

  const http = queuedHttpRequest([
    base44List([
      { id: "whisper-nodate", title: "Bad row", status: "locked" }
    ])
  ]);
  server.__setHttpRequest(http);

  const result = await server.recoverRevealTimers();

  assert.equal(result.recovered, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.fired, 0);
  assert.equal(result.scheduled, 0);
  assert.equal(server.revealTimers.size, 0);
  assert.equal(server.locked.size, 0);
  // Should not have queried for the watcher since we bailed on the date check.
  assert.equal(http.calls.length, 1);
});

test("recoverRevealTimers: skips whisper with no matching watcher", async (t) => {
  t.after(clearState);

  const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const http = queuedHttpRequest([
    base44List([
      {
        id: "whisper-orphan",
        title: "No watcher",
        status: "locked",
        reveal_scheduled_for: future
      }
    ]),
    base44List([])
  ]);
  server.__setHttpRequest(http);

  const result = await server.recoverRevealTimers();

  assert.equal(result.recovered, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.scheduled, 0);
  assert.equal(result.fired, 0);
  assert.equal(server.revealTimers.size, 0);
  assert.equal(server.locked.size, 0);
});

test("recoverRevealTimers: does not double-schedule if timer already in memory", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    t.mock.timers.reset();
    clearState();
  });

  const future = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const existingTimer = setTimeout(() => {}, 60_000);
  server.revealTimers.set("whisper-existing", existingTimer);

  const http = queuedHttpRequest([
    base44List([
      {
        id: "whisper-existing",
        title: "Already scheduled",
        status: "locked",
        reveal_scheduled_for: future
      }
    ])
  ]);
  server.__setHttpRequest(http);

  const result = await server.recoverRevealTimers();

  assert.equal(result.recovered, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.scheduled, 0);
  assert.equal(server.revealTimers.get("whisper-existing"), existingTimer, "pre-existing timer untouched");
  // Should not have queried for the watcher either.
  assert.equal(http.calls.length, 1);
});

test("recoverRevealTimers: handles Base44 error gracefully", async (t) => {
  t.after(clearState);

  server.__setHttpRequest(async () => { throw new Error("Base44 down"); });

  const result = await server.recoverRevealTimers();

  assert.equal(result.recovered, 0);
  assert.equal(result.error, "Base44 down");
  assert.equal(server.revealTimers.size, 0);
  assert.equal(server.locked.size, 0);
});

test("recoverRevealTimers: scheduled timer fires executeReveal at the right moment", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    t.mock.timers.reset();
    clearState();
  });

  const revealInSec = 30;
  const future = new Date(Date.now() + revealInSec * 1000).toISOString();

  const http = queuedHttpRequest([
    base44List([
      {
        id: "whisper-soon",
        title: "Soon",
        status: "locked",
        oracle_lock_time: new Date().toISOString(),
        reveal_scheduled_for: future
      }
    ]),
    base44List([
      {
        id: "watcher-soon",
        whisper_id: "whisper-soon",
        oracle_verdict: "true",
        oracle_confidence: 95,
        oracle_reasoning: "confirmed"
      }
    ]),
    base44Ok(),      // PATCH OracleWatcher -> revealed
    base44Ok(),      // PATCH Whisper -> revealed
    base44List([])   // getVotersForWhisper
  ]);
  server.__setHttpRequest(http);

  await server.recoverRevealTimers();
  assert.equal(server.revealTimers.has("whisper-soon"), true);

  // Just before fire time -> still pending.
  t.mock.timers.tick(revealInSec * 1000 - 1);
  assert.equal(server.locked.has("whisper-soon"), true);

  // Final tick -> reveal fires.
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(server.locked.has("whisper-soon"), false);
  assert.equal(server.revealTimers.has("whisper-soon"), false);
});

test("listLockedWhispers: queries Whisper?status=locked", async (t) => {
  t.after(clearState);

  const http = queuedHttpRequest([
    base44List([{ id: "w1" }, { id: "w2" }])
  ]);
  server.__setHttpRequest(http);

  const whispers = await server.listLockedWhispers();
  assert.equal(whispers.length, 2);

  const call = http.calls[0];
  assert.equal(call.options.method, "GET");
  assert.match(call.options.path, /Whisper\?status=locked/);
});

test("getWatcherByWhisperId: returns first entity or null", async (t) => {
  t.after(clearState);

  const http = queuedHttpRequest([
    base44List([{ id: "watcher-a", whisper_id: "w-a" }]),
    base44List([])
  ]);
  server.__setHttpRequest(http);

  const found = await server.getWatcherByWhisperId("w-a");
  assert.equal(found.id, "watcher-a");

  const missing = await server.getWatcherByWhisperId("w-missing");
  assert.equal(missing, null);

  assert.match(http.calls[0].options.path, /whisper_id=w-a/);
});
