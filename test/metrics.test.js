const test = require("node:test");
const assert = require("node:assert/strict");
const { createMetrics } = require("../lib/metrics");

test("metrics.inc: counters accumulate", () => {
  const m = createMetrics();
  m.inc("polls");
  m.inc("polls");
  m.inc("polls", 3);
  assert.equal(m.snapshot().counters.polls, 5);
});

test("metrics.inc: labeled counters tracked separately", () => {
  const m = createMetrics();
  m.inc("whispers_locked", 1, { verdict: "true" });
  m.inc("whispers_locked", 1, { verdict: "true" });
  m.inc("whispers_locked", 1, { verdict: "false" });
  const snap = m.snapshot();
  assert.equal(snap.counters.whispers_locked, 3, "total counter still aggregates");
  assert.equal(snap.labeled.whispers_locked["verdict=true"], 2);
  assert.equal(snap.labeled.whispers_locked["verdict=false"], 1);
});

test("metrics.gauge: stores and overwrites", () => {
  const m = createMetrics();
  m.gauge("locked_pending_reveal", 5);
  assert.equal(m.snapshot().gauges.locked_pending_reveal, 5);
  m.gauge("locked_pending_reveal", 2);
  assert.equal(m.snapshot().gauges.locked_pending_reveal, 2);
});

test("metrics.snapshot: includes started_at and uptime", () => {
  let now = 1_000_000_000_000;
  const m = createMetrics({ now: () => now });
  now += 5_500;
  const snap = m.snapshot();
  assert.match(snap.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(snap.uptime_seconds, 5);
});

test("metrics.reset: clears everything", () => {
  const m = createMetrics();
  m.inc("a");
  m.gauge("b", 7);
  m.inc("c", 1, { x: "1" });
  m.reset();
  const snap = m.snapshot();
  assert.deepEqual(snap.counters, {});
  assert.deepEqual(snap.gauges, {});
  assert.deepEqual(snap.labeled, {});
});

test("metrics: stable label-key ordering (a=1,b=2 == b=2,a=1)", () => {
  const m = createMetrics();
  m.inc("x", 1, { a: "1", b: "2" });
  m.inc("x", 1, { b: "2", a: "1" });
  // Both should land on the same composite key.
  const snap = m.snapshot();
  assert.equal(Object.keys(snap.labeled.x).length, 1);
  assert.equal(Object.values(snap.labeled.x)[0], 2);
});
