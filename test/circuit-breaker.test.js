const test = require("node:test");
const assert = require("node:assert/strict");
const { createCircuitBreaker, CircuitOpenError } = require("../lib/circuit-breaker");

function makeFakeNow() {
  let t = 1_000_000_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("circuit-breaker: starts closed; success keeps it closed", async () => {
  const cb = createCircuitBreaker({ name: "x" });
  const fn = async () => ({ status: 200, data: {} });
  const guarded = cb.wrap(fn);

  for (let i = 0; i < 10; i++) await guarded();
  assert.equal(cb.getState(), "closed");
});

test("circuit-breaker: opens after failureThreshold consecutive failures", async () => {
  const events = [];
  const cb = createCircuitBreaker({
    name: "x",
    failureThreshold: 3,
    onStateChange: (e) => events.push(e),
  });
  let calls = 0;
  const fn = async () => { calls++; throw Object.assign(new Error("boom"), { code: "ECONNRESET" }); };
  const guarded = cb.wrap(fn);

  for (let i = 0; i < 3; i++) {
    await assert.rejects(guarded(), /boom/);
  }
  assert.equal(cb.getState(), "open");
  assert.equal(calls, 3);
  // 4th call should fail fast (no network attempt)
  await assert.rejects(guarded(), CircuitOpenError);
  assert.equal(calls, 3, "fn was NOT invoked while open");
  assert.equal(events.at(-1).to, "open");
});

test("circuit-breaker: 5xx counts as failure", async () => {
  const cb = createCircuitBreaker({ name: "x", failureThreshold: 2 });
  let calls = 0;
  const fn = async () => { calls++; return { status: 503, data: "Service Unavailable" }; };
  const guarded = cb.wrap(fn);

  await guarded();
  await guarded();
  assert.equal(cb.getState(), "open");
  await assert.rejects(guarded(), CircuitOpenError);
  assert.equal(calls, 2);
});

test("circuit-breaker: 429 counts as failure", async () => {
  const cb = createCircuitBreaker({ name: "x", failureThreshold: 1 });
  const fn = async () => ({ status: 429 });
  const guarded = cb.wrap(fn);
  await guarded();
  assert.equal(cb.getState(), "open");
});

test("circuit-breaker: 4xx other than 429 does NOT open the breaker", async () => {
  const cb = createCircuitBreaker({ name: "x", failureThreshold: 2 });
  const fn = async () => ({ status: 404 });
  const guarded = cb.wrap(fn);
  for (let i = 0; i < 5; i++) await guarded();
  assert.equal(cb.getState(), "closed", "404s are caller bugs, not Base44 outages");
});

test("circuit-breaker: success resets consecutive-failure counter", async () => {
  const cb = createCircuitBreaker({ name: "x", failureThreshold: 3 });
  let i = 0;
  const fn = async () => {
    i++;
    if (i === 1 || i === 2) return { status: 503 };
    if (i === 3) return { status: 200, data: {} }; // success!
    return { status: 503 };
  };
  const guarded = cb.wrap(fn);
  await guarded();
  await guarded();
  await guarded();           // success → resets
  assert.equal(cb.getState(), "closed");
  await guarded();           // fail again — but counter restarted
  await guarded();
  assert.equal(cb.getState(), "closed", "should still be closed because failures aren't consecutive");
});

test("circuit-breaker: open → half_open after cooldown", async () => {
  const clock = makeFakeNow();
  const cb = createCircuitBreaker({
    name: "x",
    failureThreshold: 1,
    cooldownMs: 1000,
    now: clock.now,
  });
  await cb.wrap(async () => { throw Object.assign(new Error("e"), { code: "ETIMEDOUT" }); })().catch(() => {});
  assert.equal(cb.getState(), "open");

  clock.advance(1500);

  // The next wrap call should let one probe through (state transitions to half_open)
  let calls = 0;
  const fn = async () => { calls++; return { status: 200 }; };
  const result = await cb.wrap(fn)();
  assert.equal(result.status, 200);
  assert.equal(calls, 1);
  assert.equal(cb.getState(), "closed", "successful probe → closed");
});

test("circuit-breaker: half_open probe failure → re-open", async () => {
  const clock = makeFakeNow();
  const cb = createCircuitBreaker({
    name: "x",
    failureThreshold: 1,
    cooldownMs: 1000,
    now: clock.now,
  });
  // Trip
  await cb.wrap(async () => { throw Object.assign(new Error("e"), { code: "ETIMEDOUT" }); })().catch(() => {});
  clock.advance(1500);

  // Probe fails
  let probeCalls = 0;
  const failingFn = async () => { probeCalls++; throw Object.assign(new Error("still down"), { code: "ECONNRESET" }); };
  await cb.wrap(failingFn)().catch(() => {});
  assert.equal(probeCalls, 1, "probe should have been allowed through");
  assert.equal(cb.getState(), "open");
});

test("circuit-breaker: reset() returns to closed", async () => {
  const cb = createCircuitBreaker({ name: "x", failureThreshold: 1 });
  await cb.wrap(async () => ({ status: 500 }))();
  assert.equal(cb.getState(), "open");
  cb.reset();
  assert.equal(cb.getState(), "closed");
});

test("circuit-breaker: doesn't count network successes (2xx) as failures", async () => {
  const cb = createCircuitBreaker({ name: "x", failureThreshold: 1 });
  const fn = async () => ({ status: 201, data: {} });
  const guarded = cb.wrap(fn);
  for (let i = 0; i < 100; i++) await guarded();
  assert.equal(cb.getState(), "closed");
});
