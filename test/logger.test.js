const test = require("node:test");
const assert = require("node:assert/strict");
const { createLogger } = require("../lib/logger");

function captureLines() {
  const stdout = [];
  const stderr = [];
  return {
    out: { log: (line) => stdout.push(line), error: (line) => stderr.push(line) },
    stdout,
    stderr,
  };
}

test("logger: emits a single JSON line per call with required fields", () => {
  const { out, stdout } = captureLines();
  const log = createLogger({ service: "watcher", out });
  log.info("poll_complete", { count: 3 });
  assert.equal(stdout.length, 1);
  const entry = JSON.parse(stdout[0]);
  assert.equal(entry.level, "info");
  assert.equal(entry.service, "watcher");
  assert.equal(entry.event, "poll_complete");
  assert.equal(entry.count, 3);
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("logger: error level writes to stderr, not stdout", () => {
  const { out, stdout, stderr } = captureLines();
  const log = createLogger({ service: "watcher", out });
  log.error("base44_error", { entity: "Whisper", message: "x" });
  assert.equal(stdout.length, 0);
  assert.equal(stderr.length, 1);
  const entry = JSON.parse(stderr[0]);
  assert.equal(entry.level, "error");
  assert.equal(entry.entity, "Whisper");
});

test("logger: extra fields override default fields if name conflict", () => {
  const { out, stdout } = captureLines();
  const log = createLogger({ service: "watcher", out });
  // 'service' field in extras should NOT clobber base 'service' silently —
  // current behavior: spread extras over base, so extras win. Document it.
  log.info("evt", { service: "other" });
  const entry = JSON.parse(stdout[0]);
  assert.equal(entry.service, "other");
});

test("logger: handles missing fields argument", () => {
  const { out, stdout } = captureLines();
  const log = createLogger({ service: "watcher", out });
  log.info("just_an_event");
  const entry = JSON.parse(stdout[0]);
  assert.equal(entry.event, "just_an_event");
});

test("logger: warn and debug levels work", () => {
  const { out, stdout } = captureLines();
  const log = createLogger({ service: "watcher", out });
  log.warn("w");
  log.debug("d");
  assert.equal(stdout.length, 2);
  assert.equal(JSON.parse(stdout[0]).level, "warn");
  assert.equal(JSON.parse(stdout[1]).level, "debug");
});
