const test = require("node:test");
const assert = require("node:assert/strict");
const { withRetry, isTransientError, isRetriableStatus, parseRetryAfter } = require("../lib/retry");

// Synchronous "sleep" replacement so tests don't actually wait.
const noSleep = () => Promise.resolve();

test("isTransientError: known transient codes", () => {
  assert.equal(isTransientError({ code: "ECONNRESET" }), true);
  assert.equal(isTransientError({ code: "ETIMEDOUT" }), true);
  assert.equal(isTransientError({ code: "ENOTFOUND" }), true);
  assert.equal(isTransientError({ code: "EAI_AGAIN" }), true);
});

test("isTransientError: matches 'Timeout' message even without a code", () => {
  assert.equal(isTransientError(new Error("Timeout")), true);
  assert.equal(isTransientError(new Error("request timed out")), true);
});

test("isTransientError: false for non-transient errors", () => {
  assert.equal(isTransientError(new Error("Bad JSON")), false);
  assert.equal(isTransientError({ code: "EINVAL" }), false);
  assert.equal(isTransientError(null), false);
  assert.equal(isTransientError(undefined), false);
});

test("isRetriableStatus: 5xx and 429", () => {
  assert.equal(isRetriableStatus(500), true);
  assert.equal(isRetriableStatus(502), true);
  assert.equal(isRetriableStatus(503), true);
  assert.equal(isRetriableStatus(599), true);
  assert.equal(isRetriableStatus(429), true);
});

test("isRetriableStatus: 2xx, 3xx, and other 4xx are NOT retriable", () => {
  assert.equal(isRetriableStatus(200), false);
  assert.equal(isRetriableStatus(204), false);
  assert.equal(isRetriableStatus(301), false);
  assert.equal(isRetriableStatus(400), false);
  assert.equal(isRetriableStatus(401), false);
  assert.equal(isRetriableStatus(404), false);
});

test("withRetry: succeeds on first attempt, no retries", async () => {
  let calls = 0;
  const fn = async () => { calls++; return { status: 200, data: { ok: true } }; };
  const wrapped = withRetry(fn, { sleep: noSleep });
  const result = await wrapped();
  assert.equal(result.status, 200);
  assert.equal(calls, 1);
});

test("withRetry: retries on transient error, succeeds on second attempt", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls === 1) {
      const err = new Error("connection reset");
      err.code = "ECONNRESET";
      throw err;
    }
    return { status: 200, data: { ok: true } };
  };
  const wrapped = withRetry(fn, { sleep: noSleep });
  const result = await wrapped();
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});

test("withRetry: throws after maxAttempts of transient errors", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    const err = new Error("timeout");
    err.code = "ETIMEDOUT";
    throw err;
  };
  const wrapped = withRetry(fn, { maxAttempts: 3, sleep: noSleep });
  await assert.rejects(wrapped(), /timeout/i);
  assert.equal(calls, 3);
});

test("withRetry: does NOT retry on non-transient errors (fails fast)", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    throw new Error("bad input");
  };
  const wrapped = withRetry(fn, { maxAttempts: 5, sleep: noSleep });
  await assert.rejects(wrapped(), /bad input/);
  assert.equal(calls, 1, "non-transient error should not trigger retry");
});

test("withRetry: retries on 503 response, succeeds when server recovers", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls < 3) return { status: 503, data: "Service Unavailable" };
    return { status: 200, data: { ok: true } };
  };
  const wrapped = withRetry(fn, { maxAttempts: 5, sleep: noSleep });
  const result = await wrapped();
  assert.equal(result.status, 200);
  assert.equal(calls, 3);
});

test("withRetry: retries on 429 (Too Many Requests)", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls === 1) return { status: 429, data: "Too Many Requests" };
    return { status: 200, data: { ok: true } };
  };
  const wrapped = withRetry(fn, { sleep: noSleep });
  const result = await wrapped();
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
});

test("withRetry: returns the final 5xx response if all retries exhaust", async () => {
  let calls = 0;
  const fn = async () => {
    calls++;
    return { status: 502, data: "Bad Gateway" };
  };
  const wrapped = withRetry(fn, { maxAttempts: 3, sleep: noSleep });
  const result = await wrapped();
  assert.equal(result.status, 502);
  assert.equal(calls, 3);
});

test("withRetry: does NOT retry on 400/401/404", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    let calls = 0;
    const fn = async () => { calls++; return { status, data: "no" }; };
    const wrapped = withRetry(fn, { maxAttempts: 5, sleep: noSleep });
    const result = await wrapped();
    assert.equal(result.status, status);
    assert.equal(calls, 1, `status ${status} should not trigger retry`);
  }
});

test("withRetry: passes through arguments and resolves with the function's return value", async () => {
  const fn = async (a, b) => ({ status: 200, data: { sum: a + b } });
  const wrapped = withRetry(fn, { sleep: noSleep });
  const result = await wrapped(2, 3);
  assert.equal(result.data.sum, 5);
});

test("withRetry: invokes onRetry callback with attempt + delay + reason", async () => {
  const events = [];
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls < 3) {
      const err = new Error("nope");
      err.code = "ECONNRESET";
      throw err;
    }
    return { status: 200, data: {} };
  };
  const wrapped = withRetry(fn, {
    sleep: noSleep,
    onRetry: (info) => events.push(info),
  });
  await wrapped();
  assert.equal(events.length, 2);
  assert.equal(events[0].attempt, 1);
  assert.equal(events[0].reason, "ECONNRESET");
  assert.equal(events[1].attempt, 2);
});

test("parseRetryAfter: integer seconds", () => {
  assert.equal(parseRetryAfter("5"), 5000);
  assert.equal(parseRetryAfter("0"), 0);
  assert.equal(parseRetryAfter(120), 120_000);
});

test("parseRetryAfter: HTTP-date strings", () => {
  // Use a date 10 seconds in the future
  const future = new Date(Date.now() + 10_000).toUTCString();
  const ms = parseRetryAfter(future);
  // Allow some scheduling jitter
  assert.ok(ms > 8_000 && ms < 12_000, `expected ~10000ms, got ${ms}`);
});

test("parseRetryAfter: returns null for garbage", () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(undefined), null);
  assert.equal(parseRetryAfter("not a date"), null);
});

test("withRetry: honors Retry-After header on 429 (in seconds)", async () => {
  let calls = 0;
  const delays = [];
  const fn = async () => {
    calls++;
    if (calls === 1) return { status: 429, headers: { "retry-after": "7" } };
    return { status: 200 };
  };
  const wrapped = withRetry(fn, {
    sleep: async (ms) => { delays.push(ms); },
    backoff: () => 999_999, // would clearly mismatch — proves retry-after wins
  });
  await wrapped();
  assert.deepEqual(delays, [7000]);
  assert.equal(calls, 2);
});

test("withRetry: caps Retry-After at maxRetryAfterMs", async () => {
  let calls = 0;
  const delays = [];
  const fn = async () => {
    calls++;
    if (calls === 1) return { status: 429, headers: { "retry-after": "9999" } }; // 9999 seconds
    return { status: 200 };
  };
  const wrapped = withRetry(fn, {
    sleep: async (ms) => { delays.push(ms); },
    maxRetryAfterMs: 10_000,
  });
  await wrapped();
  assert.deepEqual(delays, [10_000], "must cap to maxRetryAfterMs");
});

test("withRetry: falls back to backoff when no Retry-After header", async () => {
  let calls = 0;
  const delays = [];
  const fn = async () => {
    calls++;
    if (calls === 1) return { status: 429, headers: {} };
    return { status: 200 };
  };
  const wrapped = withRetry(fn, {
    sleep: async (ms) => { delays.push(ms); },
    backoff: () => 1234,
  });
  await wrapped();
  assert.deepEqual(delays, [1234]);
});

test("withRetry: 5xx with Retry-After also honored", async () => {
  let calls = 0;
  const delays = [];
  const fn = async () => {
    calls++;
    if (calls === 1) return { status: 503, headers: { "Retry-After": "3" } };
    return { status: 200 };
  };
  const wrapped = withRetry(fn, {
    sleep: async (ms) => { delays.push(ms); },
  });
  await wrapped();
  assert.deepEqual(delays, [3000]);
});

test("withRetry: backoff function is called with attempt number", async () => {
  const delays = [];
  const backoff = (attempt) => { delays.push(attempt); return 0; };
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls < 4) {
      const err = new Error("x");
      err.code = "ETIMEDOUT";
      throw err;
    }
    return { status: 200 };
  };
  const wrapped = withRetry(fn, { maxAttempts: 5, sleep: noSleep, backoff });
  await wrapped();
  assert.deepEqual(delays, [1, 2, 3]);
});
