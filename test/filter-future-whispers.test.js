const test = require("node:test");
const assert = require("node:assert/strict");
const { filterFutureWhispers } = require("../lib/filter-future-whispers");

const NOW = new Date("2026-04-17T12:00:00Z").getTime();
const future = (hours) => new Date(NOW + hours * 60 * 60 * 1000).toISOString();

test("keeps whispers with future check_after_date", () => {
  const whispers = [
    { title: "A", check_after_date: future(1) },
    { title: "B", check_after_date: future(48) },
  ];
  assert.equal(filterFutureWhispers(whispers, NOW).length, 2);
});

test("drops whispers with past check_after_date", () => {
  const whispers = [
    { title: "past", check_after_date: future(-1) },
    { title: "future", check_after_date: future(1) },
  ];
  const result = filterFutureWhispers(whispers, NOW);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "future");
});

test("keeps whispers without check_after_date (treated as open-ended)", () => {
  const whispers = [{ title: "open" }, { title: "also open", check_after_date: null }];
  assert.equal(filterFutureWhispers(whispers, NOW).length, 2);
});

test("drops whispers with invalid date string (NaN)", () => {
  const whispers = [{ title: "bad", check_after_date: "not-a-date" }];
  assert.equal(filterFutureWhispers(whispers, NOW).length, 0);
});

test("drops whispers whose date equals now (strict greater-than)", () => {
  const whispers = [{ title: "now", check_after_date: new Date(NOW).toISOString() }];
  assert.equal(filterFutureWhispers(whispers, NOW).length, 0);
});

test("returns [] when given non-array input", () => {
  assert.deepEqual(filterFutureWhispers(null, NOW), []);
  assert.deepEqual(filterFutureWhispers(undefined, NOW), []);
  assert.deepEqual(filterFutureWhispers({}, NOW), []);
});

test("empty array returns empty array", () => {
  assert.deepEqual(filterFutureWhispers([], NOW), []);
});

test("off-by-one: one second in the future is kept, one second in the past is dropped", () => {
  const result = filterFutureWhispers(
    [
      { title: "just before", check_after_date: new Date(NOW - 1000).toISOString() },
      { title: "just after", check_after_date: new Date(NOW + 1000).toISOString() },
    ],
    NOW,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "just after");
});
