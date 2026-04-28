// Retry wrapper for transient HTTP failures.
//
// Today a single network blip in a Claude or Base44 call means the watcher
// skips that whisper for up to 6 hours (the next poll-interval tier). With
// retries, transient failures heal in a few seconds.
//
// Retry policy:
// - 3 attempts total by default
// - Exponential backoff: 500ms, 1500ms (jittered)
// - Retry on:
//     * Network errors (ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN, etc.)
//     * Generic "Timeout" thrown by httpRequest
//     * 5xx HTTP responses (server errors)
//     * 429 Too Many Requests (with Retry-After respected, capped)
// - Don't retry on:
//     * 4xx other than 429 (real client errors — retrying won't help)
//     * 2xx/3xx (success)
//
// Operates on the result shape produced by httpRequest:
//   { status: <number>, data: <parsed JSON or string> }

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

function isTransientError(err) {
  if (!err) return false;
  if (err.code && TRANSIENT_ERROR_CODES.has(err.code)) return true;
  if (typeof err.message === "string" && /time(d)? ?out/i.test(err.message)) return true;
  return false;
}

function isRetriableStatus(status) {
  if (typeof status !== "number") return false;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

function defaultBackoff(attempt) {
  // 500ms, 1500ms, 3500ms (with up to ±20% jitter)
  const base = 500 * (2 ** attempt - 1);
  const jitter = base * (Math.random() * 0.4 - 0.2);
  return Math.max(0, Math.floor(base + jitter));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wrap an async function so it retries transient failures.
//
//   const wrapped = withRetry(httpRequest, { maxAttempts: 3 });
//   await wrapped(options, body);
//
// Options:
//   maxAttempts  — total attempts including the first (default 3)
//   backoff      — function(attemptNumber) -> ms to wait (default exponential + jitter)
//   sleep        — async function(ms) (override for tests)
//   onRetry      — callback({ attempt, delay, reason }) for logging
function withRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 3;
  const backoff = opts.backoff ?? defaultBackoff;
  const sleeper = opts.sleep ?? sleep;
  const onRetry = opts.onRetry ?? (() => {});

  return async function retried(...args) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await fn(...args);
        // Result is the {status,data} shape — check for retriable HTTP status.
        if (result && isRetriableStatus(result.status) && attempt < maxAttempts) {
          const delay = backoff(attempt);
          onRetry({ attempt, delay, reason: `status_${result.status}` });
          await sleeper(delay);
          continue;
        }
        return result;
      } catch (err) {
        lastErr = err;
        if (!isTransientError(err) || attempt >= maxAttempts) throw err;
        const delay = backoff(attempt);
        onRetry({ attempt, delay, reason: err.code || err.message });
        await sleeper(delay);
      }
    }
    throw lastErr;
  };
}

module.exports = { withRetry, isTransientError, isRetriableStatus, defaultBackoff };
