// Three-state circuit breaker.
//
// State transitions:
//   closed   → open       after `failureThreshold` consecutive failures
//   open     → half_open  after `cooldownMs` since opening
//   half_open → closed    on the first success (resets failure count)
//   half_open → open      on a single failure (doubles down on cooldown)
//
// While open, calls fail FAST without invoking the wrapped function.
// While half_open, ONE request is allowed through as a probe; until it
// returns, additional concurrent calls also fail fast.
//
// Also bypasses the breaker for failures that don't indicate a downstream
// outage — namely 4xx other than 429 (those are our problem, not theirs).
//
// Usage:
//   const breaker = createCircuitBreaker({ name: "base44", failureThreshold: 5 });
//   const guarded = breaker.wrap(httpRequest);
//   await guarded(options, body);

class CircuitOpenError extends Error {
  constructor(name, msUntilHalfOpen) {
    super(`circuit_open:${name}:retry_after_ms=${msUntilHalfOpen}`);
    this.code = "CIRCUIT_OPEN";
    this.circuit = name;
    this.retryAfterMs = msUntilHalfOpen;
  }
}

function createCircuitBreaker({
  name = "default",
  failureThreshold = 5,
  cooldownMs = 60_000,
  now = Date.now,
  onStateChange = () => {},
} = {}) {
  let state = "closed";
  let consecutiveFailures = 0;
  let openedAt = 0;
  let halfOpenInFlight = false;

  function transition(next, reason) {
    if (state === next) return;
    const prev = state;
    state = next;
    if (next === "open") openedAt = now();
    if (next === "closed") consecutiveFailures = 0;
    if (next === "half_open") halfOpenInFlight = false;
    onStateChange({ name, from: prev, to: next, reason });
  }

  function recordSuccess() {
    if (state === "half_open") {
      transition("closed", "probe_succeeded");
    } else {
      consecutiveFailures = 0;
    }
  }

  function recordFailure(reason) {
    if (state === "half_open") {
      transition("open", "probe_failed");
      return;
    }
    consecutiveFailures++;
    if (consecutiveFailures >= failureThreshold) {
      transition("open", `${consecutiveFailures}_consecutive_failures:${reason || "unknown"}`);
    }
  }

  // Decides whether a result counts as a failure for the breaker.
  // Network errors, timeouts, 5xx, and 429 do. 4xx other than 429 do NOT.
  function shouldCount({ result, error }) {
    if (error) return { failed: true, reason: error.code || error.message || "error" };
    if (result && typeof result.status === "number") {
      if (result.status === 429) return { failed: true, reason: "429" };
      if (result.status >= 500) return { failed: true, reason: `${result.status}` };
    }
    return { failed: false };
  }

  function maybeHalfOpen() {
    if (state === "open" && now() - openedAt >= cooldownMs) {
      transition("half_open", "cooldown_elapsed");
    }
  }

  // Returns a wrapped version of `fn`. Calls fail fast with CircuitOpenError
  // when the breaker is open or already probing.
  function wrap(fn) {
    return async function guarded(...args) {
      maybeHalfOpen();

      if (state === "open") {
        throw new CircuitOpenError(name, cooldownMs - (now() - openedAt));
      }
      if (state === "half_open") {
        if (halfOpenInFlight) throw new CircuitOpenError(name, 0);
        halfOpenInFlight = true;
      }

      let result, error;
      try {
        result = await fn(...args);
      } catch (e) {
        error = e;
      } finally {
        if (state === "half_open") halfOpenInFlight = false;
      }

      const verdict = shouldCount({ result, error });
      if (verdict.failed) {
        recordFailure(verdict.reason);
      } else {
        recordSuccess();
      }

      if (error) throw error;
      return result;
    };
  }

  function getState() { return state; }
  function reset() {
    state = "closed";
    consecutiveFailures = 0;
    openedAt = 0;
    halfOpenInFlight = false;
  }

  return { wrap, getState, reset, _failures: () => consecutiveFailures };
}

module.exports = { createCircuitBreaker, CircuitOpenError };
