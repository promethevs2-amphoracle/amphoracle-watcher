const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decidePollInterval,
  DEFAULT_INTERVAL,
  FAR_INTERVAL,
  NEAR_INTERVAL,
  SAMEDAY_INTERVAL,
  ACTIVE_INTERVAL,
} = require("../lib/poll-interval");

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-04-17T12:00:00Z").getTime();

test("no check_after_date -> default 5-min interval", () => {
  assert.equal(decidePollInterval(NOW, null), DEFAULT_INTERVAL);
  assert.equal(decidePollInterval(NOW, undefined), DEFAULT_INTERVAL);
});

test("NaN check_after_date -> default interval (guards bad input)", () => {
  assert.equal(decidePollInterval(NOW, NaN), DEFAULT_INTERVAL);
});

test("event >48h away -> 6-hour interval", () => {
  assert.equal(decidePollInterval(NOW, NOW + 72 * HOUR), FAR_INTERVAL);
});

test("event between 24h and 48h away -> 2-hour interval", () => {
  assert.equal(decidePollInterval(NOW, NOW + 36 * HOUR), NEAR_INTERVAL);
});

test("event same day but not yet reached -> 30-min interval", () => {
  assert.equal(decidePollInterval(NOW, NOW + 6 * HOUR), SAMEDAY_INTERVAL);
});

test("event time reached or passed -> active 5-min interval", () => {
  assert.equal(decidePollInterval(NOW, NOW), ACTIVE_INTERVAL);
  assert.equal(decidePollInterval(NOW, NOW - HOUR), ACTIVE_INTERVAL);
});

test("boundaries: just under 48h is NEAR, just over is FAR", () => {
  assert.equal(decidePollInterval(NOW, NOW + 48 * HOUR - 1), NEAR_INTERVAL);
  assert.equal(decidePollInterval(NOW, NOW + 48 * HOUR + 1), FAR_INTERVAL);
});

test("boundaries: just under 24h is SAMEDAY, just over is NEAR", () => {
  assert.equal(decidePollInterval(NOW, NOW + 24 * HOUR - 1), SAMEDAY_INTERVAL);
  assert.equal(decidePollInterval(NOW, NOW + 24 * HOUR + 1), NEAR_INTERVAL);
});

test("boundary: exactly at check_after_date is ACTIVE, one ms before is SAMEDAY", () => {
  assert.equal(decidePollInterval(NOW, NOW + 1), SAMEDAY_INTERVAL);
  assert.equal(decidePollInterval(NOW, NOW), ACTIVE_INTERVAL);
});

test("ladder ordering: FAR > NEAR > SAMEDAY == ACTIVE == DEFAULT", () => {
  assert.ok(FAR_INTERVAL > NEAR_INTERVAL);
  assert.ok(NEAR_INTERVAL > SAMEDAY_INTERVAL);
  assert.equal(SAMEDAY_INTERVAL, 30 * 60 * 1000);
  assert.equal(ACTIVE_INTERVAL, 5 * 60 * 1000);
  assert.equal(DEFAULT_INTERVAL, 5 * 60 * 1000);
});
