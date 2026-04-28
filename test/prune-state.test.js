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

test("pruneState: drops lastChecked entries not in active set", () => {
  server.lastChecked.set("active-1", Date.now());
  server.lastChecked.set("stale-1", Date.now());
  server.lastChecked.set("stale-2", Date.now());

  const pruned = server.pruneState(["active-1"]);

  assert.equal(pruned, 2, "two stale entries should be pruned");
  assert.equal(server.lastChecked.has("active-1"), true);
  assert.equal(server.lastChecked.has("stale-1"), false);
  assert.equal(server.lastChecked.has("stale-2"), false);

  clearState();
});

test("pruneState: drops locked entries not in active set AND not pending reveal", () => {
  server.locked.set("active-1", Date.now());
  server.locked.set("stale-1", Date.now());

  const pruned = server.pruneState(["active-1"]);

  assert.equal(pruned, 1);
  assert.equal(server.locked.has("active-1"), true);
  assert.equal(server.locked.has("stale-1"), false);

  clearState();
});

test("pruneState: PRESERVES locked entries that still have a reveal timer pending", (t) => {
  // Simulate a whisper that was locked, watcher list moved on, but the
  // 15-min reveal timer hasn't fired yet — must NOT be pruned, otherwise
  // we'd race against executeReveal.
  server.locked.set("locked-with-timer", Date.now());
  const timer = setTimeout(() => {}, 60_000);
  server.revealTimers.set("locked-with-timer", timer);

  const pruned = server.pruneState([]); // empty active set

  assert.equal(server.locked.has("locked-with-timer"), true, "must not drop locked while timer pending");
  assert.equal(pruned, 0);

  // cleanup
  clearTimeout(timer);
  clearState();
});

test("pruneState: returns 0 when nothing to prune", () => {
  server.lastChecked.set("a", 1);
  server.lastChecked.set("b", 2);
  const pruned = server.pruneState(["a", "b"]);
  assert.equal(pruned, 0);
  clearState();
});

test("pruneState: handles empty active list (drops everything not pending reveal)", () => {
  server.lastChecked.set("x", 1);
  server.locked.set("x", 1);
  const pruned = server.pruneState([]);
  assert.equal(pruned, 2);
  assert.equal(server.lastChecked.size, 0);
  assert.equal(server.locked.size, 0);
  clearState();
});

test("executeReveal also prunes lastChecked for the revealed whisper", async (t) => {
  t.after(clearState);

  const http = queuedHttpRequest([
    base44Ok(),     // PATCH OracleWatcher
    base44Ok(),     // PATCH Whisper
    base44List([]), // getVotersForWhisper -> none
  ]);
  server.__setHttpRequest(http);

  server.locked.set("w-x", Date.now());
  server.revealTimers.set("w-x", setTimeout(() => {}, 0));
  server.lastChecked.set("w-x", Date.now());

  await server.executeReveal(
    { id: "watcher-x", whisper_id: "w-x", whisper_title: "X" },
    "true",
    90,
    "reasoning",
  );

  assert.equal(server.locked.has("w-x"), false);
  assert.equal(server.revealTimers.has("w-x"), false);
  assert.equal(server.lastChecked.has("w-x"), false, "lastChecked should be pruned by executeReveal");
});

test("pollWatchers prunes stale state entries each cycle", async (t) => {
  t.after(clearState);

  // Pre-seed lastChecked with one entry that no longer corresponds to a
  // watcher; getWatchers returns just one fresh watcher.
  server.lastChecked.set("stale-id", Date.now() - 60_000);
  server.lastChecked.set("kept-id", Date.now()); // very recent → poll will skip checking, but won't prune

  const http = queuedHttpRequest([
    base44List([{ id: "w1", whisper_id: "kept-id", whisper_title: "X", urls: [], check_after_date: null }]),
  ]);
  server.__setHttpRequest(http);

  await server.pollWatchers();

  assert.equal(server.lastChecked.has("stale-id"), false, "stale id should have been pruned");
  assert.equal(server.lastChecked.has("kept-id"), true);
});
