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

test("logger: redacts a value that matches a known secret source", () => {
  const { out, stdout } = captureLines();
  const log = createLogger({
    service: "watcher",
    out,
    secretSources: () => ["super-secret-key-12345"],
  });
  log.info("evt", { auth: "super-secret-key-12345", other: "fine" });
  const entry = JSON.parse(stdout[0]);
  assert.equal(entry.auth, "***REDACTED***");
  assert.equal(entry.other, "fine");
});

test("logger: redacts a value that CONTAINS the secret (e.g. inside an error message)", () => {
  const { out, stderr } = captureLines();
  const log = createLogger({
    service: "watcher",
    out,
    secretSources: () => ["abcdef12345"],
  });
  log.error("base44_failure", { message: "401 with key=abcdef12345 returned" });
  const entry = JSON.parse(stderr[0]);
  assert.equal(entry.message, "***REDACTED***");
});

test("logger: ignores empty / short secret values (don't redact everything)", () => {
  const { out, stdout } = captureLines();
  const log = createLogger({
    service: "watcher",
    out,
    secretSources: () => ["", "abc", undefined, null], // all too short / empty
  });
  log.info("evt", { msg: "abc xyz", auth: "" });
  const entry = JSON.parse(stdout[0]);
  assert.equal(entry.msg, "abc xyz", "short secret 'abc' must NOT redact incidental matches");
  assert.equal(entry.auth, "");
});

test("logger: redacts known token patterns regardless of secretSources", () => {
  const { out, stdout } = captureLines();
  const log = createLogger({ service: "watcher", out, secretSources: () => [] });

  log.info("anthropic", { key: "sk-ant-api03-xxxx-yyyy-zzzz" });
  log.info("gitlab",    { tok: "glpat-LySc0tU1QYs7F_n58p3bYmM6MQpvOjEKdTptZ3lnYQ8.01.170vvptik" });
  log.info("github",    { tok: "ghp_abcDEF123456789xyzXYZ" });
  log.info("bearer",    { hdr: "Bearer fff1aad5f90e11241446160753b879ff0e8ab5c681296f73c0ec9097b2d181cc" });

  assert.equal(JSON.parse(stdout[0]).key, "***REDACTED***");
  assert.equal(JSON.parse(stdout[1]).tok, "***REDACTED***");
  assert.equal(JSON.parse(stdout[2]).tok, "***REDACTED***");
  assert.equal(JSON.parse(stdout[3]).hdr, "***REDACTED***");
});

test("logger: non-string fields pass through unchanged", () => {
  const { out, stdout } = captureLines();
  const log = createLogger({ service: "watcher", out, secretSources: () => ["secret-1234"] });
  log.info("evt", { count: 42, ok: true, nested: { k: "secret-1234" } });
  const entry = JSON.parse(stdout[0]);
  assert.equal(entry.count, 42);
  assert.equal(entry.ok, true);
  // Nested objects are not deeply redacted (documented limitation —
  // nesting would require recursion and the logger keeps a flat shape
  // by convention).
  assert.equal(entry.nested.k, "secret-1234");
});

test("logger: redactValue is exposed for direct use", () => {
  const log = createLogger({ secretSources: () => ["my-secret"] });
  assert.equal(log.redactValue("my-secret"), "***REDACTED***");
  assert.equal(log.redactValue("nothing-special"), "nothing-special");
});
